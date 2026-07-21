/**
 * Shared building blocks for the discovery pages (dashboard, profile, search).
 *
 * These pages all present the same "repository row" anatomy — a repo mark, a
 * name link, a visibility chip, a one-line description, and a relative "updated"
 * timestamp — so it lives here once and stays identical across the cluster.
 * Everything is composed from `src/ui` primitives and semantic `fh-*` tokens;
 * the small inline icons are functional Octicon-style 16px marks in
 * `currentColor`, matching the design foundation's own icon set.
 */
import { Link } from "react-router-dom";
import { Badge, RelativeTime, cx } from "../ui";

// ── Icons ────────────────────────────────────────────────────────────────────
type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const RepoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
  </Svg>
);

export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M4 4v2h-.25A1.75 1.75 0 002 7.75v5.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 13.25v-5.5A1.75 1.75 0 0012.25 6H12V4a4 4 0 10-8 0zm6.5 2V4a2.5 2.5 0 00-5 0v2h5zM12 7.5h.25a.25.25 0 01.25.25v5.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-5.5a.25.25 0 01.25-.25H12z" />
  </Svg>
);

export const IssueOpenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
    <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
  </Svg>
);

export const IssueClosedIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z" />
    <path fillRule="evenodd" d="M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
  </Svg>
);

export const PersonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.561 8.073a6.005 6.005 0 013.432 5.142.75.75 0 11-1.498.07 4.5 4.5 0 00-8.99 0 .75.75 0 01-1.498-.07 6.005 6.005 0 013.431-5.142 3.999 3.999 0 115.612 0zM8 1.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.75 2a.75.75 0 01.75.75V7h4.25a.75.75 0 010 1.5H8.5v4.25a.75.75 0 01-1.5 0V8.5H2.75a.75.75 0 010-1.5H7V2.75A.75.75 0 017.75 2z" />
  </Svg>
);

export const LocationIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M11.536 3.464a5 5 0 010 7.072L8 14.07l-3.536-3.534a5 5 0 117.072-7.072v.001zm1.06 8.132a6.5 6.5 0 10-9.192 0l3.535 3.536a1.5 1.5 0 002.122 0l3.535-3.536zM8 9a2 2 0 100-4 2 2 0 000 4z" />
  </Svg>
);

export const LinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M7.775 3.275a.75.75 0 001.06 1.06l1.25-1.25a2 2 0 112.83 2.83l-2.5 2.5a2 2 0 01-2.83 0 .75.75 0 00-1.06 1.06 3.5 3.5 0 004.95 0l2.5-2.5a3.5 3.5 0 00-4.95-4.95l-1.25 1.25zm-4.69 9.64a2 2 0 010-2.83l2.5-2.5a2 2 0 012.83 0 .75.75 0 001.06-1.06 3.5 3.5 0 00-4.95 0l-2.5 2.5a3.5 3.5 0 004.95 4.95l1.25-1.25a.75.75 0 00-1.06-1.06l-1.25 1.25a2 2 0 01-2.83 0z" />
  </Svg>
);

export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <path fillRule="evenodd" d="M4.75 0a.75.75 0 01.75.75V2h5V.75a.75.75 0 011.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0113.25 16H2.75A1.75 1.75 0 011 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 014.75 0zm0 3.5h8.5a.25.25 0 01.25.25V6h-11V3.75a.25.25 0 01.25-.25h2zM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25V7.5h-11z" />
  </Svg>
);

// ── Topic chips ────────────────────────────────────────────────────────────────

/** Link a single topic to a prefilled repository search (`topic:<slug>`). */
export function topicSearchHref(topic: string): string {
  return `/search?q=${encodeURIComponent(`topic:${topic}`)}&type=repos`;
}

/**
 * A row of clickable topic chips (GitHub-style). Each chip navigates to a repo
 * search filtered to that topic. Rendered in the repo header and on the
 * dashboard / profile / search rows. `max` caps the visible chips with a "+N"
 * overflow marker so long topic sets don't blow out a compact row.
 */
export function TopicChips({
  topics,
  max,
  className,
}: {
  topics?: string[] | null;
  max?: number;
  className?: string;
}) {
  if (!topics || topics.length === 0) return null;
  const shown = max ? topics.slice(0, max) : topics;
  const overflow = max ? topics.length - shown.length : 0;
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1.5", className)}>
      {shown.map((t) => (
        <Link
          key={t}
          to={topicSearchHref(t)}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex max-w-full items-center rounded-full bg-fh-accent-muted px-2 py-0.5 text-fh-xs font-medium text-fh-accent-fg hover:bg-fh-accent-emphasis hover:text-fh-on-emphasis"
        >
          <span className="truncate">{t}</span>
        </Link>
      ))}
      {overflow > 0 && (
        <span className="text-fh-xs font-medium text-fh-fg-subtle">+{overflow}</span>
      )}
    </span>
  );
}

// ── Repository row ─────────────────────────────────────────────────────────────
type RepoRowProps = {
  /** Route to the repository. */
  to: string;
  /** The link label — a bare name, or `owner/name` when the owner matters. */
  name: React.ReactNode;
  description?: string | null;
  visibility?: "public" | "private";
  updatedAt?: string;
  /** Discovery topics rendered as clickable chips beneath the description. */
  topics?: string[] | null;
  /** Extra metadata rendered inline after the "Updated" time. */
  meta?: React.ReactNode;
};

/**
 * One repository row: repo mark, name link, visibility chip, description, and a
 * relative "updated" time. The single anatomy shared by the dashboard, profile,
 * and search-result lists. Wrap a group of these in {@link RowList}.
 */
export function RepoRow({ to, name, description, visibility, updatedAt, topics, meta }: RepoRowProps) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-fh-surface-muted">
      <RepoIcon className="mt-0.5 shrink-0 text-fh-fg-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={to} className="text-fh-base font-semibold text-fh-accent-fg hover:underline">
            {name}
          </Link>
          {visibility && (
            <Badge tone={visibility === "public" ? "neutral" : "warning"}>
              {visibility === "public" ? "Public" : "Private"}
            </Badge>
          )}
        </div>
        {description && <p className="mt-1 text-fh-sm text-fh-fg-muted line-clamp-2">{description}</p>}
        {topics && topics.length > 0 && <TopicChips topics={topics} max={8} className="mt-2" />}
        {(updatedAt || meta) && (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-fh-xs text-fh-fg-subtle">
            {updatedAt && (
              <span>
                Updated <RelativeTime date={updatedAt} />
              </span>
            )}
            {meta}
          </p>
        )}
      </div>
    </div>
  );
}

type RowListProps = {
  children: React.ReactNode;
  className?: string;
  "aria-label"?: string;
};

/** Bordered surface card that hairline-divides the rows it contains. */
export function RowList({ children, className, ...rest }: RowListProps) {
  return (
    <div
      className={cx(
        "overflow-hidden rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border-muted",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
