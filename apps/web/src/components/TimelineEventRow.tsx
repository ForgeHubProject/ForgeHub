import { Link } from "react-router-dom";
import { Avatar, LabelChip, RelativeTime } from "../ui";
import type { RepoRef } from "../lib/autolink";
import type { TimelineEvent } from "../types";

// ─── Local Octicon-style marks (16px, currentColor) ─────────────────────────────

type IconProps = { size?: number; className?: string };
function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}
const TagMark = (p: IconProps) => <Svg {...p}><path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" /></Svg>;
const PersonMark = (p: IconProps) => <Svg {...p}><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.622 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" /></Svg>;
const ClosedMark = (p: IconProps) => <Svg {...p}><path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z" /><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z" /></Svg>;
const OpenMark = (p: IconProps) => <Svg {...p}><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" /><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" /></Svg>;
const MergeMark = (p: IconProps) => <Svg {...p}><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" /></Svg>;
const LinkMark = (p: IconProps) => <Svg {...p}><path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z" /></Svg>;
const PushMark = (p: IconProps) => <Svg {...p}><path d="M1 2.5A2.5 2.5 0 0 1 3.5 0h8.75a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V1.5h-8a1 1 0 0 0-1 1v6.708A2.492 2.492 0 0 1 3.5 9h3.25a.75.75 0 0 1 0 1.5H3.5a1 1 0 0 0 0 2h5.75a.75.75 0 0 1 0 1.5H3.5A2.5 2.5 0 0 1 1 11.5Zm13.23 7.79a.75.75 0 0 0 1.06-1.06l-2.505-2.505a.75.75 0 0 0-1.06 0L9.72 9.229a.75.75 0 1 0 1.06 1.061l1.225-1.224v6.184a.75.75 0 0 0 1.5 0V9.066Z" /></Svg>;
const PencilMark = (p: IconProps) => <Svg {...p}><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" /></Svg>;

// ─── Data helpers ────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }
function num(v: unknown): number | undefined { return typeof v === "number" ? v : undefined; }
function short(sha: unknown): string | undefined { const s = str(sha); return s ? s.slice(0, 7) : undefined; }

function ActorLink({ handle }: { handle: string }) {
  return <Link to={`/${handle}`} className="font-semibold text-fh-fg hover:text-fh-accent-fg">{handle}</Link>;
}

type RenderResult = { icon: React.ReactNode; tone: string; body: React.ReactNode };

function renderEvent(event: TimelineEvent, repo: RepoRef): RenderResult | null {
  const d = event.data;
  const base = `/${repo.owner}/${repo.name}`;
  switch (event.kind) {
    case "labeled":
    case "unlabeled": {
      const label = (d.label as { name?: string; color?: string } | undefined) ?? {};
      return {
        icon: <TagMark />, tone: "text-fh-fg-subtle",
        body: <>{event.kind === "labeled" ? "added the" : "removed the"}{" "}
          {label.name ? <LabelChip name={label.name} color={label.color ?? "#8b97a4"} /> : "a"} label</>,
      };
    }
    case "assigned":
    case "unassigned": {
      const who = str(d.assignee);
      return {
        icon: <PersonMark />, tone: "text-fh-fg-subtle",
        body: <>{event.kind === "assigned" ? "assigned" : "unassigned"}{" "}
          {who ? <ActorLink handle={who} /> : "someone"}</>,
      };
    }
    case "closed": {
      const pull = num(d.closedByPull);
      return {
        icon: <ClosedMark />, tone: "text-fh-purple-fg",
        body: <>closed this{pull != null && <> via <Link to={`${base}/pulls/${pull}`} className="text-fh-accent-fg hover:underline">!{pull}</Link></>}</>,
      };
    }
    case "reopened":
      return { icon: <OpenMark />, tone: "text-fh-success-fg", body: <>reopened this</> };
    case "merged": {
      const sha = short(d.sha);
      return {
        icon: <MergeMark />, tone: "text-fh-purple-fg",
        body: <>merged this{sha && <> · <span className="font-mono text-fh-xs text-fh-fg-subtle">{sha}</span></>}</>,
      };
    }
    case "referenced": {
      const sourceType = str(d.sourceType);
      const sourceNumber = num(d.sourceNumber);
      const sourceTitle = str(d.sourceTitle);
      const isPull = sourceType === "PULL_REQUEST";
      const path = sourceNumber != null ? `${base}/${isPull ? "pulls" : "issues"}/${sourceNumber}` : null;
      const ref = sourceNumber != null ? `${isPull ? "!" : "#"}${sourceNumber}` : "";
      return {
        icon: <LinkMark />, tone: "text-fh-fg-subtle",
        body: <>referenced this{path && <> in{" "}
          <Link to={path} className="text-fh-accent-fg hover:underline" title={sourceTitle}>{ref}</Link></>}</>,
      };
    }
    case "head_pushed": {
      const branch = str(d.branch);
      const from = short(d.oldSha);
      const to = short(d.newSha);
      return {
        icon: <PushMark />, tone: "text-fh-fg-subtle",
        body: <>pushed to {branch && <span className="font-mono text-fh-xs text-fh-fg">{branch}</span>}
          {from && to && <> <span className="font-mono text-fh-xs text-fh-fg-subtle">{from}…{to}</span></>}</>,
      };
    }
    case "title_changed": {
      const from = str(d.from);
      const to = str(d.to);
      return {
        icon: <PencilMark />, tone: "text-fh-fg-subtle",
        body: <>changed the title{from && to && <> from <span className="line-through text-fh-fg-subtle">{from}</span> to <span className="text-fh-fg">{to}</span></>}</>,
      };
    }
    default:
      return null;
  }
}

/** A compact, GitHub-style non-comment conversation event (icon + actor + verb + time). */
export function TimelineEventRow({ event, repo }: { event: TimelineEvent; repo: RepoRef }) {
  const rendered = renderEvent(event, repo);
  if (!rendered) return null;
  return (
    <div className="flex items-center gap-2 pl-1 text-fh-sm text-fh-fg-muted">
      <span className={`flex items-center justify-center shrink-0 w-7 h-7 rounded-full bg-fh-surface-muted ${rendered.tone}`}>
        {rendered.icon}
      </span>
      <Avatar name={event.actor} size={18} />
      <span className="min-w-0">
        <ActorLink handle={event.actor} /> {rendered.body}{" "}
        <RelativeTime date={event.createdAt} className="text-fh-fg-subtle" />
      </span>
    </div>
  );
}
