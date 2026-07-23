/**
 * Presentational atoms for the commit history + commit-detail views. These are
 * the small, reusable chrome pieces the RepoCommitsTab composes — built only
 * from `fh-*` tokens and ui/ primitives (see apps/web/DESIGN.md). They are
 * deliberately dumb: no data fetching, no routing decisions.
 */
import { useCallback, useState } from "react";
import { Badge, Tooltip, cx } from "../../ui";
import type { BadgeTone } from "../../ui";
import type { CommitSignature, FileDiff } from "../../types";

// ─── Local icons ───────────────────────────────────────────────────────────────
// Octicon-style 16px marks in currentColor for the few glyphs the shared ui/
// icon set doesn't carry (copy, commit-node, file, chevron). Page-level icons,
// consistent with rule §5.8 of DESIGN.md.

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
    <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
  </Svg>
);

export const CommitNodeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" />
  </Svg>
);

export const FileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8 4.25V1.5Zm5.75.56v2.19c0 .138.112.25.25.25h2.19Z" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
  </Svg>
);

// ─── Day heading ───────────────────────────────────────────────────────────────

/** "Jul 20, 2026" — abbreviated month, local calendar day. */
export function formatDayHeading(date: string): string {
  return new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ─── Short-SHA chip with copy-on-click ──────────────────────────────────────────

type ShaChipProps = {
  sha: string;
  /** Length of the abbreviated hash shown (default 7). */
  length?: number;
  className?: string;
};

/**
 * A monospace short-SHA pill that copies the FULL sha to the clipboard on click,
 * flashing a check for confirmation. Subtle border that strengthens on hover.
 */
export function ShaChip({ sha, length = 7, className }: ShaChipProps) {
  const short = sha.slice(0, length);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(sha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }, [sha]);

  return (
    <Tooltip label={copied ? "Copied" : "Copy full SHA"}>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy commit ${short}`}
        className={cx(
          "inline-flex items-center gap-1.5 font-mono text-fh-xs leading-none",
          "rounded-md border px-2 py-1 transition-colors",
          copied
            ? "border-fh-success-fg/40 text-fh-success-fg bg-fh-success-muted"
            : "border-fh-border bg-fh-surface-muted text-fh-fg-muted hover:border-fh-border-strong hover:text-fh-fg",
          className,
        )}
      >
        <span>{short}</span>
        {copied ? <CheckMark /> : <CopyIcon size={12} className="opacity-70" />}
      </button>
    </Tooltip>
  );
}

function CheckMark() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

// ─── Commit signature badge (Verified — issue #117) ──────────────────────────────

const VerifiedIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.585.52a2.678 2.678 0 0 0-1.17 0c-.296.069-.577.19-.957.359l-.19.084c-.351.156-.462.2-.556.223a1.179 1.179 0 0 1-.281.034c-.096.002-.199-.014-.582-.058l-.207-.024c-.415-.048-.72-.083-1.021-.061a2.679 2.679 0 0 0-1.109.331c-.264.145-.5.336-.821.593l-.16.128c-.297.238-.387.306-.47.362a1.18 1.18 0 0 1-.256.128c-.093.033-.196.058-.567.14l-.2.045c-.406.09-.705.156-.973.283a2.678 2.678 0 0 0-.899.674c-.19.22-.339.478-.545.844l-.101.18c-.185.328-.245.427-.311.516a1.181 1.181 0 0 1-.2.2c-.088.066-.187.126-.515.31l-.181.102c-.366.206-.623.356-.844.545a2.678 2.678 0 0 0-.674.9c-.127.267-.193.566-.283.972l-.045.2c-.082.371-.107.474-.14.567a1.18 1.18 0 0 1-.128.256c-.056.083-.124.173-.362.47l-.128.16c-.257.321-.448.557-.593.821-.16.29-.272.605-.331 1.109-.022.301.013.606.061 1.021l.024.207c.044.383.06.486.058.582a1.18 1.18 0 0 1-.034.281c-.023.094-.067.205-.223.556l-.084.19c-.169.38-.29.661-.359.957a2.678 2.678 0 0 0 0 1.17c.069.296.19.577.359.957l.084.19c.156.351.2.462.223.556.02.09.03.18.034.281.002.096-.014.199-.058.582l-.024.207c-.048.415-.083.72-.061 1.021.058.504.17.819.331 1.109.145.264.336.5.593.821l.128.16c.238.297.306.387.362.47.05.081.093.167.128.256.033.093.058.196.14.567l.045.2c.09.406.156.705.283.973.163.345.39.656.674.899.22.19.478.339.844.545l.18.101c.328.185.427.245.516.311.08.06.146.126.2.2.066.089.126.188.31.516l.102.181c.206.366.356.623.545.844.243.284.554.51.9.674.267.127.566.193.972.283l.2.045c.371.082.474.107.567.14.089.035.175.078.256.128.083.056.173.124.47.362l.16.128c.321.257.557.448.821.593.29.16.605.272 1.109.331.301.022.606-.013 1.021-.061l.207-.024c.383-.044.486-.06.582-.058.095.004.189.015.281.034.094.023.205.067.556.223l.19.084c.38.169.661.29.957.359a2.678 2.678 0 0 0 1.17 0c.296-.069.577-.19.957-.359l.19-.084c.351-.156.462-.2.556-.223.09-.02.18-.03.281-.034.096-.002.199.014.582.058l.207.024c.415.048.72.083 1.021.061a2.678 2.678 0 0 0 1.109-.331c.264-.145.5-.336.821-.593l.16-.128c.297-.238.387-.306.47-.362.081-.05.167-.093.256-.128.093-.033.196-.058.567-.14l.2-.045c.406-.09.705-.156.973-.283a2.678 2.678 0 0 0 .899-.674c.243-.221.339-.478.545-.844l.101-.181c.185-.328.245-.427.311-.516.06-.074.126-.14.2-.2.089-.066.188-.126.516-.31l.181-.102c.366-.206.623-.356.844-.545a2.679 2.679 0 0 0 .674-.9c.127-.267.193-.566.283-.972l.045-.2c.082-.371.107-.474.14-.567.035-.089.078-.175.128-.256.056-.083.124-.173.362-.47l.128-.16c.257-.321.448-.557.593-.821.16-.29.272-.605.331-1.109.022-.301-.013-.606-.061-1.021l-.024-.207c-.044-.383-.06-.486-.058-.582.004-.095.015-.189.034-.281.023-.094.067-.205.223-.556l.084-.19c.169-.38.29-.661.359-.957a2.678 2.678 0 0 0 0-1.17c-.069-.296-.19-.577-.359-.957l-.084-.19c-.156-.351-.2-.462-.223-.556a1.18 1.18 0 0 1-.034-.281c-.002-.096.014-.199.058-.582l.024-.207c.048-.415.083-.72.061-1.021a2.678 2.678 0 0 0-.331-1.109c-.145-.264-.336-.5-.593-.821l-.128-.16c-.238-.297-.306-.387-.362-.47a1.179 1.179 0 0 1-.128-.256c-.033-.093-.058-.196-.14-.567l-.045-.2c-.09-.406-.156-.705-.283-.973a2.678 2.678 0 0 0-.674-.899c-.221-.19-.478-.339-.844-.545l-.181-.101c-.328-.185-.427-.245-.516-.311a1.181 1.181 0 0 1-.2-.2c-.066-.089-.126-.188-.31-.516l-.102-.181c-.206-.366-.356-.623-.545-.844a2.678 2.678 0 0 0-.9-.674c-.267-.127-.566-.193-.972-.283l-.2-.045c-.371-.082-.474-.107-.567-.14a1.18 1.18 0 0 1-.256-.128c-.083-.056-.173-.124-.47-.362l-.16-.128c-.321-.257-.557-.448-.821-.593a2.678 2.678 0 0 0-1.109-.331c-.301-.022-.606.013-1.021.061l-.207.024c-.383.044-.486.06-.582.058a1.179 1.179 0 0 1-.281-.034c-.094-.023-.205-.067-.556-.223l-.19-.084c-.38-.169-.661-.29-.957-.359Zm2.831 5.435-3.75 5.5a.75.75 0 0 1-1.154.114l-2.5-2.5a.75.75 0 0 1 1.06-1.06l1.856 1.855 3.24-4.752a.75.75 0 1 1 1.248.833Z" />
  </Svg>
);

const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.533.133a1.75 1.75 0 0 0-1.066 0l-5.25 1.68A1.75 1.75 0 0 0 1 3.48V7c0 1.566.32 3.182 1.303 4.696.983 1.511 2.594 2.885 5.03 3.884a1.75 1.75 0 0 0 1.334 0c2.436-.999 4.047-2.373 5.03-3.884C14.68 10.182 15 8.566 15 7V3.48a1.75 1.75 0 0 0-1.217-1.667L8.533.133Zm-.61 1.429a.25.25 0 0 1 .153 0l5.25 1.68a.25.25 0 0 1 .174.238V7c0 1.358-.275 2.666-1.057 3.87-.784 1.205-2.121 2.41-4.366 3.32a.25.25 0 0 1-.191 0c-2.245-.91-3.582-2.115-4.366-3.32C2.775 9.666 2.5 8.358 2.5 7V3.48a.25.25 0 0 1 .174-.237l5.25-1.68Z" />
  </Svg>
);

const SIGNATURE_META: Record<
  CommitSignature["status"],
  { tone: BadgeTone; label: string; Icon: (p: IconProps) => React.ReactElement } | null
> = {
  verified: { tone: "success", label: "Verified", Icon: VerifiedIcon },
  "signed-unverified": { tone: "neutral", label: "Signed", Icon: ShieldIcon },
  unsigned: null,
};

/**
 * A chip for a commit's signature status: green "Verified" when git validated
 * the signature, a neutral "Signed" when a signature is present but couldn't be
 * verified (e.g. no gpg on the server / no trust store), and nothing at all for
 * an unsigned commit. The tooltip carries the signer when known.
 */
export function SignatureBadge({ signature, className }: { signature: CommitSignature; className?: string }) {
  const meta = SIGNATURE_META[signature.status];
  if (!meta) return null;
  const { tone, label, Icon } = meta;
  const tip =
    signature.status === "verified"
      ? `Verified signature${signature.signer ? ` by ${signature.signer}` : ""}`
      : `Signed${signature.signer ? ` by ${signature.signer}` : ""} — signature present but not verified here`;
  return (
    <Tooltip label={tip}>
      <Badge tone={tone} className={cx("gap-1", className)}>
        <Icon size={12} />
        {label}
      </Badge>
    </Tooltip>
  );
}

// ─── File change-type badge ─────────────────────────────────────────────────────

const STATUS_TONE: Record<FileDiff["status"], BadgeTone> = {
  added: "success",
  deleted: "danger",
  renamed: "accent",
  modified: "neutral",
};

const STATUS_LABEL: Record<FileDiff["status"], string> = {
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  modified: "Modified",
};

/**
 * A tag for a file's change type. Modified files get no tag (the +/- counts
 * carry the signal, matching GitHub) to keep the file list quiet.
 */
export function ChangeTypeBadge({ status }: { status: FileDiff["status"] }) {
  if (status === "modified") return null;
  return (
    <Badge tone={STATUS_TONE[status]} pill={false}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

// ─── +additions / −deletions counts ─────────────────────────────────────────────

/** Monospace +N −M pair, colored via success/danger tokens. Zero sides drop. */
export function DiffCounts({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-mono text-fh-xs leading-none", className)}>
      {additions > 0 && <span className="text-fh-success-fg">+{additions}</span>}
      {deletions > 0 && <span className="text-fh-danger-fg">&minus;{deletions}</span>}
      {additions === 0 && deletions === 0 && <span className="text-fh-fg-subtle">0</span>}
    </span>
  );
}

// ─── GitHub-style 5-square diffstat ─────────────────────────────────────────────

/** Compact green/red proportion bar (5 squares) summarizing a changeset. */
export function DiffStatBar({ additions, deletions }: { additions: number; deletions: number }) {
  const squares = 5;
  const total = additions + deletions;
  let greens = 0;
  let reds = 0;
  if (total > 0) {
    greens = additions > 0 ? Math.min(squares, Math.max(1, Math.round((additions / total) * squares))) : 0;
    reds = deletions > 0 ? Math.min(squares - greens, Math.max(1, Math.round((deletions / total) * squares))) : 0;
  }
  return (
    <span
      className="inline-flex items-center gap-[2px] align-middle"
      title={`${additions} addition${additions !== 1 ? "s" : ""} & ${deletions} deletion${deletions !== 1 ? "s" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: squares }).map((_, i) => (
        <span
          key={i}
          className={cx(
            "h-2 w-2 rounded-[2px]",
            i < greens ? "bg-fh-success-fg" : i < greens + reds ? "bg-fh-danger-fg" : "bg-fh-neutral-muted",
          )}
        />
      ))}
    </span>
  );
}
