import path from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../git-utils.js";

/**
 * Workflow definition format (issue #86, v0).
 *
 * A workflow file lives at `.forgehub/workflows/*.yml` in the pushed commit:
 *
 *   name: CI
 *   on: [push, pull_request]        # string | list | map — keys/values, no filters v0
 *   jobs:
 *     build:
 *       name: Build                 # optional; defaults to the job id
 *       steps:
 *         - name: Install           # optional step label
 *           run: npm ci             # required shell command
 *         - run: npm test
 *
 * v0 is deliberately tiny: no marketplace actions, no reusable workflows, no
 * matrix/filters/caching/artifacts. Each step is a shell command run with
 * `sh -c` in a fresh checkout of the triggering commit.
 */

export type CiEvent = "push" | "pull_request";

export type WorkflowStep = {
  name?: string;
  run: string;
};

export type WorkflowJob = {
  id: string;
  name: string;
  steps: WorkflowStep[];
  /** Merged env for this job (workflow-level ∪ job-level, job wins). */
  env: Record<string, string>;
};

export type ParsedWorkflow = {
  name: string;
  /** The subset of {push, pull_request} this workflow triggers on. */
  events: CiEvent[];
  /** Glob branch filters per event, or null when the event is unfiltered (all branches). */
  branchFilters: { push: string[] | null; pull_request: string[] | null };
  /** Workflow-level env (before job-level overrides). */
  env: Record<string, string>;
  jobs: WorkflowJob[];
};

export type ParseResult =
  | { ok: true; workflow: ParsedWorkflow }
  | { ok: false; error: string };

const KNOWN_EVENTS: readonly CiEvent[] = ["push", "pull_request"];

/** Collect the recognized event names from an `on:` value (string | list | map). */
function extractEvents(on: unknown): CiEvent[] {
  const found = new Set<CiEvent>();
  const add = (v: unknown) => {
    if (typeof v === "string" && (KNOWN_EVENTS as readonly string[]).includes(v)) {
      found.add(v as CiEvent);
    }
  };
  if (typeof on === "string") add(on);
  else if (Array.isArray(on)) for (const v of on) add(v);
  else if (on && typeof on === "object") for (const k of Object.keys(on as object)) add(k);
  return KNOWN_EVENTS.filter((e) => found.has(e));
}

/** Coerce a `branches:` value (string | list) into a trimmed non-empty string list. */
function toStringList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((s) => s.trim());
  }
  return [];
}

/**
 * Pull the glob branch filter for `event` out of an `on:` MAP form:
 *   on: { push: { branches: [main, "releases/*"] } }
 * Returns null when `on` is not a map, the event has no `branches:`, or the list
 * is empty — meaning "unfiltered" (every branch triggers, the v0 behavior).
 */
function extractBranchFilter(on: unknown, event: CiEvent): string[] | null {
  if (!on || typeof on !== "object" || Array.isArray(on)) return null;
  const spec = (on as Record<string, unknown>)[event];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const list = toStringList((spec as Record<string, unknown>)["branches"]);
  return list.length > 0 ? list : null;
}

/**
 * Parse an `env:` mapping into a string→string record. Rejects a non-mapping or
 * any non-string value so a mistake surfaces as a failing CheckRun (the same
 * invalid-workflow path the rest of the parser uses) rather than silently
 * stringifying `NODE_ENV: 1` into `"1"`.
 */
function parseEnvMap(raw: unknown, context: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new StepError(`${context} 'env' must be a mapping of string keys to string values.`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new StepError(`${context} 'env' value for '${k}' must be a string.`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Tiny glob match for branch filters: `*` matches any run of characters within a
 * path segment (i.e. not `/`), everything else is literal. So `releases/*` matches
 * `releases/1.0` but not `releases/1.0/rc`, and `main` matches only `main`. No new
 * dependency — a hand-rolled anchored regex.
 */
export function globMatch(pattern: string, value: string): boolean {
  const re = pattern
    .split("*")
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${re}$`).test(value);
}

/**
 * Does `branch` pass a branch filter? A null filter (unfiltered) always passes.
 * With a filter present, the branch must be known and glob-match at least one
 * pattern. An unknown branch (undefined) against a real filter never matches.
 */
export function branchAllowed(filter: string[] | null, branch: string | undefined): boolean {
  if (filter === null) return true;
  if (branch === undefined) return false;
  return filter.some((p) => globMatch(p, branch));
}

/**
 * Parse a workflow YAML document into a normalized workflow, or return the first
 * validation error as human-readable text. On failure the trigger layer records a
 * CheckRun that FAILS with this text as its log so the author sees the mistake —
 * a bad file never crashes the push.
 *
 * `defaultName` (the file basename) is used when the document omits `name`.
 */
export function parseWorkflowYaml(text: string, defaultName: string): ParseResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `YAML parse error: ${msg}` };
  }

  if (doc === null || doc === undefined) {
    return { ok: false, error: "Workflow file is empty." };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "Workflow must be a YAML mapping at the top level." };
  }
  const root = doc as Record<string, unknown>;

  const name =
    typeof root["name"] === "string" && root["name"].trim() ? root["name"].trim() : defaultName;

  if (!("on" in root) || root["on"] === null || root["on"] === undefined) {
    return { ok: false, error: "Workflow is missing the required 'on' field." };
  }
  const events = extractEvents(root["on"]);
  const branchFilters = {
    push: extractBranchFilter(root["on"], "push"),
    pull_request: extractBranchFilter(root["on"], "pull_request"),
  };

  // Workflow-level env (merged into each job below). Throws StepError on a bad map.
  const workflowEnv = parseEnvMap(root["env"], "Workflow");

  const rawJobs = root["jobs"];
  if (!rawJobs || typeof rawJobs !== "object" || Array.isArray(rawJobs)) {
    return { ok: false, error: "Workflow must define a 'jobs' mapping." };
  }
  const jobEntries = Object.entries(rawJobs as Record<string, unknown>);
  if (jobEntries.length === 0) {
    return { ok: false, error: "Workflow defines no jobs." };
  }

  const jobs: WorkflowJob[] = [];
  for (const [jobId, rawJob] of jobEntries) {
    if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) {
      return { ok: false, error: `Job '${jobId}' must be a mapping.` };
    }
    const job = rawJob as Record<string, unknown>;
    const jobName =
      typeof job["name"] === "string" && job["name"].trim() ? job["name"].trim() : jobId;

    // Job-level env overrides workflow-level on key collisions. Throws on a bad map.
    const jobEnv = { ...workflowEnv, ...parseEnvMap(job["env"], `Job '${jobId}'`) };

    const rawSteps = job["steps"];
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return { ok: false, error: `Job '${jobId}' must define a non-empty 'steps' list.` };
    }
    const steps: WorkflowStep[] = [];
    rawSteps.forEach((rawStep, i) => {
      if (rawStep && typeof rawStep === "object" && !Array.isArray(rawStep)) {
        const step = rawStep as Record<string, unknown>;
        const run = step["run"];
        if (typeof run === "string" && run.trim()) {
          const stepName = typeof step["name"] === "string" && step["name"].trim() ? step["name"].trim() : undefined;
          steps.push(stepName ? { name: stepName, run } : { run });
          return;
        }
      }
      throw new StepError(`Step ${i + 1} of job '${jobId}' must have a non-empty 'run' command.`);
    });

    jobs.push({ id: jobId, name: jobName, steps, env: jobEnv });
  }

  return { ok: true, workflow: { name, events, branchFilters, env: workflowEnv, jobs } };
}

// Thrown inside the forEach above; caught by the wrapper below. Keeps the happy
// path linear without an index-based for-loop label.
class StepError extends Error {}

/** Same as parseWorkflowYaml but converts a thrown StepError into a ParseResult. */
export function parseWorkflow(text: string, defaultName: string): ParseResult {
  try {
    return parseWorkflowYaml(text, defaultName);
  } catch (err) {
    if (err instanceof StepError) return { ok: false, error: err.message };
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Workflow parse error: ${msg}` };
  }
}

export type WorkflowFile = { path: string; content: string };

/**
 * List `.forgehub/workflows/*.yml|*.yaml` files present in a commit's tree along
 * with their contents. Returns [] when the directory is absent (→ no runs).
 */
export async function listWorkflowFilesAtCommit(
  storageKey: string,
  commitSha: string,
): Promise<WorkflowFile[]> {
  let treeOut: string;
  try {
    // -r recurses; paths are relative to repo root. Restrict to the workflows dir.
    treeOut = await git(storageKey, ["ls-tree", "-r", "--name-only", commitSha, ".forgehub/workflows/"]);
  } catch {
    return [];
  }
  const paths = treeOut
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.endsWith(".yml") || p.endsWith(".yaml"));

  const files: WorkflowFile[] = [];
  for (const p of paths) {
    try {
      const content = await git(storageKey, ["show", `${commitSha}:${p}`]);
      files.push({ path: p, content });
    } catch {
      // A file that vanished between ls-tree and show is simply skipped.
    }
  }
  return files;
}

/** Display name for a workflow file when it omits `name:` — the basename sans extension. */
export function defaultWorkflowName(filePath: string): string {
  const base = path.basename(filePath);
  return base.replace(/\.(ya?ml)$/i, "");
}
