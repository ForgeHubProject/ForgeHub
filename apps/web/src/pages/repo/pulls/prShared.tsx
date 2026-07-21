/**
 * Shared presentational bits for the pull-requests experience: PR-specific
 * Octicon marks (functional, 16px, currentColor), the state icon/pill, and the
 * source → target branch chips. Kept token-only — no raw hex in chrome.
 */
import { cx } from "../../../ui";

export type PRState = "open" | "merged" | "closed";

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const GitPullRequestIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.177 3.073 9.573.677A.25.25 0 0 1 10 .854v4.792a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354zM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25zM11 2.5h-1V4h1a1 1 0 0 1 1 1v5.628a2.251 2.251 0 1 0 1.5 0V5A2.5 2.5 0 0 0 11 2.5zm1 10.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM3.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" />
  </Svg>
);

export const GitMergeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 9.25v2.378a2.251 2.251 0 1 1-1.5 0V9.25A2.75 2.75 0 0 1 5.45 6.659l-.776-.776a.75.75 0 0 1 1.06-1.06l.716.716v-.385zm.01 5.096a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0zM9.25 5.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0-3a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" />
  </Svg>
);

export const GitBranchIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z" />
  </Svg>
);

export const GitCommitIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.5 7.75a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm1.43.75a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.001 4.001 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5h-3.32z" />
  </Svg>
);

export const FileDiffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.75 1.5a.25.25 0 0 0-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25V1.75zM8 6.25a.75.75 0 0 1 .75.75v1.25H10a.75.75 0 0 1 0 1.5H8.75V11a.75.75 0 0 1-1.5 0V9.75H6a.75.75 0 0 1 0-1.5h1.25V7A.75.75 0 0 1 8 6.25z" />
  </Svg>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06z" />
  </Svg>
);

export const ArrowLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.78 12.53a.75.75 0 0 1-1.06 0L2.47 8.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L4.81 7h7.44a.75.75 0 0 1 0 1.5H4.81l2.97 2.97a.75.75 0 0 1 0 1.06z" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" />
  </Svg>
);

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368zM8 5a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 8 5zm1 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
  </Svg>
);

export const CheckCircleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0z" />
  </Svg>
);

/** The state glyph, tinted in the state's semantic token color. */
export function PRStateIcon({ state, size = 16, className }: { state: PRState; size?: number; className?: string }) {
  const tone =
    state === "open" ? "text-fh-success-fg" : state === "merged" ? "text-fh-purple-fg" : "text-fh-danger-fg";
  const Icon = state === "merged" ? GitMergeIcon : GitPullRequestIcon;
  return <Icon size={size} className={cx("shrink-0", tone, className)} />;
}

const STATE_LABEL: Record<PRState, string> = { open: "Open", merged: "Merged", closed: "Closed" };
const STATE_SOLID: Record<PRState, string> = {
  open: "bg-fh-success-emphasis",
  merged: "bg-fh-purple-emphasis",
  closed: "bg-fh-danger-emphasis",
};

/** The prominent solid status pill for the PR header. */
export function StatePill({ state }: { state: PRState }) {
  const Icon = state === "merged" ? GitMergeIcon : GitPullRequestIcon;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-fh-sm font-semibold text-white",
        STATE_SOLID[state],
      )}
    >
      <Icon size={15} />
      {STATE_LABEL[state]}
    </span>
  );
}

/** A single branch reference rendered as a compact monospace chip. */
export function BranchChip({ name, className, title }: { name: string; className?: string; title?: string }) {
  return (
    <span
      title={title ?? name}
      className={cx(
        "inline-flex items-center gap-1 max-w-[200px] px-1.5 py-0.5 rounded-md",
        "bg-fh-surface-muted border border-fh-border font-mono text-fh-xs text-fh-fg-muted",
        className,
      )}
    >
      <GitBranchIcon size={12} className="shrink-0 text-fh-fg-subtle" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** source → target branch flow (compare into base). */
export function BranchFlow({ from, to, className }: { from: string; to: string; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 min-w-0", className)}>
      <BranchChip name={from} />
      <ArrowRightIcon size={13} className="shrink-0 text-fh-fg-subtle" />
      <BranchChip name={to} />
    </span>
  );
}
