/**
 * GitLab-style quick actions ("slash commands") for issue & PR comment bodies.
 *
 * A comment body is split into command lines and prose. A *command line* is any
 * line whose first non-whitespace character is `/` followed by a word (e.g.
 * `/close`, `/label ~bug "help wanted"`, `/estimate 2h30m`). Command lines are
 * stripped from the stored body and dispatched to the same mutations the REST
 * endpoints perform, so timeline events fire through the conversation spine
 * (`recordEvent`). Everything else is kept as the comment prose — and if nothing
 * remains, no comment is created but the actions still apply.
 *
 * Parsing is pure and unit-tested. Applying is a thin async layer over Prisma +
 * `recordEvent`; permissions are checked per action (matching the equivalent
 * REST endpoint), and unknown / unauthorized / inapplicable commands are
 * reported back in the result summary rather than silently dropped.
 */

import { prisma } from "./prisma.js";
import { recordEvent } from "./timeline-service.js";
import { parseDuration, formatDuration } from "./duration.js";

// ─── Parsing ────────────────────────────────────────────────────────────────────

export type QuickCommand = {
  /** Lower-cased command name without the leading slash (e.g. `"label"`). */
  name: string;
  /** Everything after the command word on that line, trimmed. */
  arg: string;
  /** The original (trimmed) source line, for echoing back on rejection. */
  raw: string;
};

export type ParsedComment = {
  commands: QuickCommand[];
  /** The comment body with all command lines removed and trimmed. */
  body: string;
};

// A command line: optional indent, `/`, a command word, then the rest as args.
const COMMAND_LINE_RE = /^\s*\/([a-zA-Z_][a-zA-Z0-9_]*)\s*(.*)$/;
// Fenced code-block delimiters — commands inside a fence are left as prose.
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Split a comment body into quick-action commands and the remaining prose.
 * Lines inside fenced code blocks are never treated as commands.
 */
export function parseQuickActions(input: string | null | undefined): ParsedComment {
  const commands: QuickCommand[] = [];
  const kept: string[] = [];
  if (!input) return { commands, body: "" };

  let fence: string | null = null;
  for (const line of input.split(/\r?\n/)) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      kept.push(line);
      continue;
    }
    if (fence === null) {
      const m = line.match(COMMAND_LINE_RE);
      if (m) {
        commands.push({ name: m[1].toLowerCase(), arg: m[2].trim(), raw: line.trim() });
        continue; // drop from the stored body
      }
    }
    kept.push(line);
  }

  return { commands, body: kept.join("\n").trim() };
}

/**
 * Tokenize a label argument list, honoring the GitLab `~name` sigil and quoting:
 * `~bug ~"help wanted" 'needs triage'` → `["bug", "help wanted", "needs triage"]`.
 */
export function parseLabelTokens(arg: string): string[] {
  const tokens: string[] = [];
  const re = /~?(?:"([^"]*)"|'([^']*)'|([^\s"']\S*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg)) !== null) {
    const t = m[1] ?? m[2] ?? m[3];
    if (t != null && t !== "") tokens.push(t);
  }
  return tokens;
}

// ─── Applying ─────────────────────────────────────────────────────────────────

export type AppliedAction = { command: string; summary: string };
export type RejectedAction = { command: string; reason: string };
export type QuickActionResult = { applied: AppliedAction[]; rejected: RejectedAction[] };

/** The subset of a resolved repo the applier needs for permission checks. */
type RepoCtx = {
  id: string;
  ownerId: string;
  collaborators: Array<{ userId: string; role: string }>;
};

type IssueSubject = {
  type: "ISSUE";
  issue: {
    id: string;
    number: number;
    authorId: string;
    state: string;
    title: string;
    assigneeId: string | null;
    estimateMinutes: number;
    spentMinutes: number;
    milestoneId: string | null;
  };
};

type PullSubject = {
  type: "PULL_REQUEST";
  pr: { id: string; number: number; authorId: string; state: string };
};

export type QuickActionSubject = IssueSubject | PullSubject;

export type ApplyQuickActionsParams = {
  repo: RepoCtx;
  actorId: string;
  commands: QuickCommand[];
  subject: QuickActionSubject;
  log?: { error: (obj: unknown, msg?: string) => void };
};

const KNOWN_COMMANDS = new Set([
  "close", "reopen", "label", "unlabel", "assign", "unassign", "title",
  "estimate", "spend", "remove_estimate", "remove_time_spent",
  "milestone", "remove_milestone",
]);

/**
 * Extract a milestone title from a `/milestone` arg. Honors the GitLab `%` sigil
 * and single/double quoting so multi-word titles survive: `%"v1.0 beta"`,
 * `%'Sprint 4'`, `%Backlog`, or just `Sprint 4` all yield the bare title.
 */
export function parseMilestoneTitle(arg: string): string {
  let s = arg.trim();
  if (s.startsWith("%")) s = s.slice(1).trim();
  const quote = s[0];
  if ((quote === '"' || quote === "'") && s.endsWith(quote) && s.length >= 2) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function isWriter(repo: RepoCtx, userId: string): boolean {
  if (repo.ownerId === userId) return true;
  return repo.collaborators.some((c) => c.userId === userId && c.role === "WRITER");
}

async function handleOf(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { handle: true } });
  return u?.handle ?? "ghost";
}

/**
 * Apply parsed quick-action commands against an issue or pull request. Each
 * command is permission-checked and dispatched through the same Prisma writes +
 * `recordEvent` calls the REST endpoints use. Returns an applied/rejected
 * summary suitable for a UI toast. Never throws for a single bad command.
 */
export async function applyQuickActions(p: ApplyQuickActionsParams): Promise<QuickActionResult> {
  const applied: AppliedAction[] = [];
  const rejected: RejectedAction[] = [];
  const reject = (command: string, reason: string) => rejected.push({ command, reason });
  const apply = (command: string, summary: string) => applied.push({ command, summary });

  const writer = isWriter(p.repo, p.actorId);

  if (p.subject.type === "PULL_REQUEST") {
    await applyPullCommands(p, { writer, apply, reject });
  } else {
    await applyIssueCommands(p, { writer, apply, reject });
  }

  return { applied, rejected };
}

type Dispatch = {
  writer: boolean;
  apply: (command: string, summary: string) => void;
  reject: (command: string, reason: string) => void;
};

// ─── Pull requests: only /close and /reopen map onto an existing mutation ───────

async function applyPullCommands(p: ApplyQuickActionsParams, d: Dispatch): Promise<void> {
  const pr = (p.subject as PullSubject).pr;
  const canModify = pr.authorId === p.actorId || p.repo.ownerId === p.actorId;
  let state = pr.state;

  for (const cmd of p.commands) {
    const label = `/${cmd.name}`;
    try {
      if (!KNOWN_COMMANDS.has(cmd.name)) {
        d.reject(label, `Unknown command ${label}`);
        continue;
      }
      if (cmd.name !== "close" && cmd.name !== "reopen") {
        d.reject(label, `${label} is not available on pull requests`);
        continue;
      }
      if (!canModify) {
        d.reject(label, "You need to be the author or repository owner to change a pull request");
        continue;
      }
      if (state === "MERGED") {
        d.reject(label, "Cannot change the state of a merged pull request");
        continue;
      }
      const target = cmd.name === "close" ? "CLOSED" : "OPEN";
      if (state === target) {
        d.apply(label, `This pull request is already ${target.toLowerCase()}`);
        continue;
      }
      await prisma.pullRequest.update({ where: { id: pr.id }, data: { state: target } });
      state = target;
      await recordEvent({
        repoId: p.repo.id, subjectType: "PULL_REQUEST", subjectNumber: pr.number,
        kind: target === "CLOSED" ? "closed" : "reopened", actorId: p.actorId,
      });
      d.apply(label, target === "CLOSED" ? "Closed this pull request" : "Reopened this pull request");
    } catch (err) {
      p.log?.error({ err, cmd }, "quick action (pull) failed");
      d.reject(label, "Could not apply this command");
    }
  }
}

// ─── Issues: the full command set ───────────────────────────────────────────────

async function applyIssueCommands(p: ApplyQuickActionsParams, d: Dispatch): Promise<void> {
  const issue = (p.subject as IssueSubject).issue;
  const canModify = issue.authorId === p.actorId || d.writer;

  // Mutable working copy so sequential commands see prior effects.
  let state = issue.state;
  let assigneeId = issue.assigneeId;
  let title = issue.title;
  let estimate = issue.estimateMinutes;
  let spent = issue.spentMinutes;
  let milestoneId = issue.milestoneId;

  // Lazily-loaded repo milestones (only when a /milestone command appears).
  let repoMilestones: Array<{ id: string; number: number; title: string }> | null = null;
  const loadMilestones = async () => {
    if (!repoMilestones) {
      repoMilestones = await prisma.milestone.findMany({
        where: { repoId: p.repo.id },
        select: { id: true, number: true, title: true },
      });
    }
    return repoMilestones;
  };

  // Lazily-loaded repo labels + currently-applied label ids (only if needed).
  let repoLabels: Array<{ id: string; name: string; color: string }> | null = null;
  let appliedLabelIds: Set<string> | null = null;
  const loadRepoLabels = async () => {
    if (!repoLabels) {
      repoLabels = await prisma.label.findMany({
        where: { repoId: p.repo.id },
        select: { id: true, name: true, color: true },
      });
    }
    return repoLabels;
  };
  const loadAppliedLabels = async () => {
    if (!appliedLabelIds) {
      const rows = await prisma.issueLabel.findMany({
        where: { issueId: issue.id },
        select: { labelId: true },
      });
      appliedLabelIds = new Set(rows.map((r) => r.labelId));
    }
    return appliedLabelIds;
  };
  const findLabel = async (name: string) => {
    const labels = await loadRepoLabels();
    const lower = name.toLowerCase();
    return labels.find((l) => l.name.toLowerCase() === lower) ?? null;
  };

  const emit = (kind: Parameters<typeof recordEvent>[0]["kind"], data?: Record<string, unknown>) =>
    recordEvent({ repoId: p.repo.id, subjectType: "ISSUE", subjectNumber: issue.number, kind, actorId: p.actorId, data });

  for (const cmd of p.commands) {
    const label = `/${cmd.name}`;
    try {
      switch (cmd.name) {
        // ── State ──────────────────────────────────────────────────────────────
        case "close":
        case "reopen": {
          if (!canModify) { d.reject(label, "You need to be the author or a writer to change this issue"); break; }
          const target = cmd.name === "close" ? "CLOSED" : "OPEN";
          if (state === target) { d.apply(label, `This issue is already ${target.toLowerCase()}`); break; }
          await prisma.issue.update({
            where: { id: issue.id },
            data: target === "CLOSED" ? { state: "CLOSED", closedAt: new Date() } : { state: "OPEN", closedAt: null },
          });
          state = target;
          await emit(target === "CLOSED" ? "closed" : "reopened");
          d.apply(label, target === "CLOSED" ? "Closed this issue" : "Reopened this issue");
          break;
        }

        // ── Title ──────────────────────────────────────────────────────────────
        case "title": {
          if (!canModify) { d.reject(label, "You need to be the author or a writer to change this issue"); break; }
          const next = cmd.arg.trim();
          if (!next) { d.reject(label, "A new title is required"); break; }
          if (next === title) { d.apply(label, "Title is unchanged"); break; }
          const from = title;
          await prisma.issue.update({ where: { id: issue.id }, data: { title: next } });
          title = next;
          await emit("title_changed", { from, to: next });
          d.apply(label, `Changed the title to “${next}”`);
          break;
        }

        // ── Assignment ───────────────────────────────────────────────────────────
        case "assign": {
          if (!canModify) { d.reject(label, "You need to be the author or a writer to change assignees"); break; }
          const token = cmd.arg.split(/\s+/).filter(Boolean)[0];
          if (!token) { d.reject(label, "A user to assign is required (try `/assign @handle` or `/assign me`)"); break; }
          let targetUser: { id: string; handle: string } | null;
          if (token.toLowerCase() === "me") {
            targetUser = { id: p.actorId, handle: await handleOf(p.actorId) };
          } else {
            const handle = token.replace(/^@/, "").toLowerCase();
            targetUser = await prisma.user.findUnique({ where: { handle }, select: { id: true, handle: true } });
          }
          if (!targetUser) { d.reject(label, `There is no user ${token.startsWith("@") ? token : `@${token}`}`); break; }
          if (assigneeId === targetUser.id) { d.apply(label, `@${targetUser.handle} is already assigned`); break; }
          await prisma.issue.update({ where: { id: issue.id }, data: { assigneeId: targetUser.id } });
          assigneeId = targetUser.id;
          await emit("assigned", { assignee: targetUser.handle });
          d.apply(label, `Assigned @${targetUser.handle}`);
          break;
        }
        case "unassign": {
          if (!canModify) { d.reject(label, "You need to be the author or a writer to change assignees"); break; }
          if (!assigneeId) { d.apply(label, "No one was assigned"); break; }
          const prev = await handleOf(assigneeId);
          await prisma.issue.update({ where: { id: issue.id }, data: { assigneeId: null } });
          assigneeId = null;
          await emit("unassigned", { assignee: prev });
          d.apply(label, `Unassigned @${prev}`);
          break;
        }

        // ── Labels ───────────────────────────────────────────────────────────────
        case "label": {
          if (!d.writer) { d.reject(label, "Write access is required to change labels"); break; }
          const names = parseLabelTokens(cmd.arg);
          if (names.length === 0) { d.reject(label, "One or more label names are required"); break; }
          const current = await loadAppliedLabels();
          const added: string[] = [];
          for (const name of names) {
            const found = await findLabel(name);
            if (!found) { d.reject(label, `Label “${name}” does not exist in this repository`); continue; }
            if (current.has(found.id)) continue; // idempotent
            await prisma.issueLabel.create({ data: { issueId: issue.id, labelId: found.id } });
            current.add(found.id);
            await emit("labeled", { label: { name: found.name, color: found.color } });
            added.push(found.name);
          }
          if (added.length > 0) d.apply(label, `Added label${added.length > 1 ? "s" : ""} ${added.join(", ")}`);
          break;
        }
        case "unlabel": {
          if (!d.writer) { d.reject(label, "Write access is required to change labels"); break; }
          const current = await loadAppliedLabels();
          const names = parseLabelTokens(cmd.arg);
          const removed: string[] = [];
          if (names.length === 0) {
            // No args → remove every label currently applied.
            const labels = await loadRepoLabels();
            for (const l of labels) {
              if (!current.has(l.id)) continue;
              await prisma.issueLabel.delete({ where: { issueId_labelId: { issueId: issue.id, labelId: l.id } } });
              current.delete(l.id);
              await emit("unlabeled", { label: { name: l.name, color: l.color } });
              removed.push(l.name);
            }
          } else {
            for (const name of names) {
              const found = await findLabel(name);
              if (!found || !current.has(found.id)) continue; // idempotent
              await prisma.issueLabel.delete({ where: { issueId_labelId: { issueId: issue.id, labelId: found.id } } });
              current.delete(found.id);
              await emit("unlabeled", { label: { name: found.name, color: found.color } });
              removed.push(found.name);
            }
          }
          if (removed.length > 0) d.apply(label, `Removed label${removed.length > 1 ? "s" : ""} ${removed.join(", ")}`);
          break;
        }

        // ── Time tracking (issues only) ──────────────────────────────────────────
        case "estimate": {
          if (!d.writer) { d.reject(label, "Write access is required to set an estimate"); break; }
          const minutes = parseDuration(cmd.arg);
          if (minutes == null || minutes < 0) { d.reject(label, `“${cmd.arg}” is not a valid duration (try 2h30m, 1d, 1w)`); break; }
          await prisma.issue.update({ where: { id: issue.id }, data: { estimateMinutes: minutes } });
          estimate = minutes;
          d.apply(label, `Set time estimate to ${formatDuration(minutes)}`);
          break;
        }
        case "spend": {
          if (!d.writer) { d.reject(label, "Write access is required to log time"); break; }
          const delta = parseDuration(cmd.arg);
          if (delta == null) { d.reject(label, `“${cmd.arg}” is not a valid duration (try 30m, 2h, -1h)`); break; }
          const next = Math.max(0, spent + delta);
          await prisma.issue.update({ where: { id: issue.id }, data: { spentMinutes: next } });
          spent = next;
          d.apply(
            label,
            delta < 0
              ? `Subtracted ${formatDuration(-delta)} of spent time (total ${formatDuration(next)})`
              : `Added ${formatDuration(delta)} of spent time (total ${formatDuration(next)})`,
          );
          break;
        }
        case "remove_estimate": {
          if (!d.writer) { d.reject(label, "Write access is required to change the estimate"); break; }
          if (estimate === 0) { d.apply(label, "There was no estimate to remove"); break; }
          await prisma.issue.update({ where: { id: issue.id }, data: { estimateMinutes: 0 } });
          estimate = 0;
          d.apply(label, "Removed the time estimate");
          break;
        }
        case "remove_time_spent": {
          if (!d.writer) { d.reject(label, "Write access is required to change spent time"); break; }
          if (spent === 0) { d.apply(label, "There was no spent time to remove"); break; }
          await prisma.issue.update({ where: { id: issue.id }, data: { spentMinutes: 0 } });
          spent = 0;
          d.apply(label, "Removed all spent time");
          break;
        }

        // ── Milestone (#83) ──────────────────────────────────────────────────────
        case "milestone": {
          if (!d.writer) { d.reject(label, "Write access is required to set a milestone"); break; }
          const wanted = parseMilestoneTitle(cmd.arg);
          if (!wanted) { d.reject(label, "A milestone title is required (try `/milestone \"v1.0\"`)"); break; }
          const milestones = await loadMilestones();
          const lower = wanted.toLowerCase();
          const found = milestones.find((m) => m.title.toLowerCase() === lower);
          if (!found) { d.reject(label, `Milestone “${wanted}” does not exist in this repository`); break; }
          if (milestoneId === found.id) { d.apply(label, `Already on milestone ${found.title}`); break; }
          await prisma.issue.update({ where: { id: issue.id }, data: { milestoneId: found.id } });
          milestoneId = found.id;
          await emit("milestoned", { milestone: { title: found.title, number: found.number } });
          d.apply(label, `Added to milestone ${found.title}`);
          break;
        }
        case "remove_milestone": {
          if (!d.writer) { d.reject(label, "Write access is required to change the milestone"); break; }
          if (!milestoneId) { d.apply(label, "This issue is not on a milestone"); break; }
          const milestones = await loadMilestones();
          const prev = milestones.find((m) => m.id === milestoneId) ?? null;
          await prisma.issue.update({ where: { id: issue.id }, data: { milestoneId: null } });
          milestoneId = null;
          await emit("demilestoned", prev ? { milestone: { title: prev.title, number: prev.number } } : undefined);
          d.apply(label, prev ? `Removed from milestone ${prev.title}` : "Removed from milestone");
          break;
        }

        default:
          d.reject(label, `Unknown command ${label}`);
      }
    } catch (err) {
      p.log?.error({ err, cmd }, "quick action (issue) failed");
      d.reject(label, "Could not apply this command");
    }
  }
}
