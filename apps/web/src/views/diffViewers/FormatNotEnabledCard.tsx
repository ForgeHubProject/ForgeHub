import { useCallback, useState } from "react";
import type { FormatNotEnabled } from "../../api";
import { Tooltip, cx } from "../../ui";
import { useNotEnabledFormats, notEnabledMessage } from "../../lib/notEnabledFormats";

// Local copy glyph (octicon-style, currentColor) — the shared ui/ icon set
// doesn't carry one; view-level icons follow the same rule as page-level ones
// (DESIGN.md §5.8).
function CopyIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

/** One copyable `forge …` command: monospace pill, copy-on-click with a check flash. */
function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }, [command]);

  return (
    <Tooltip label={copied ? "Copied" : "Copy command"}>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${command}`}
        className={cx(
          "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-fh-sm leading-none transition-colors",
          copied
            ? "border-fh-success-fg/40 bg-fh-success-muted text-fh-success-fg"
            : "border-fh-border bg-fh-surface-inset text-fh-fg hover:border-fh-border-strong",
        )}
      >
        <span>{command}</span>
        <span className={cx(copied ? "" : "opacity-60")}>{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}</span>
      </button>
    </Tooltip>
  );
}

/**
 * The actionable "format not enabled" card (issue #73): an official FHR handler
 * exists for this file's extension, the repo just hasn't opted it into
 * .forge/formats — so instead of a dead end, show exactly what to run.
 *
 * Registers the payload in the view's aggregation scope, so when several files
 * in the same commit/PR view hit different not-enabled formats the card speaks
 * for all of them at once ("Formats .glb, .step are not added…") and lists
 * every hint command, deduplicated across files of the same format.
 */
export function FormatNotEnabledCard({ payload, scope }: { payload: FormatNotEnabled; scope: string }) {
  const entries = useNotEnabledFormats(scope, payload);
  // Before our registration's state round-trip, speak for this file alone.
  const shown = entries.length > 0 ? entries : [{ ext: payload.ext, hint: payload.hint }];
  const message = notEnabledMessage(shown.map((e) => e.ext));
  const commands = shown.flatMap((e) => e.hint);

  return (
    <div className="px-4 py-3">
      <div className="rounded-md border border-fh-accent-muted bg-fh-accent-subtle/40 px-3.5 py-3">
        <p className="text-fh-base font-semibold text-fh-fg">
          Semantic diff isn't enabled for <code className="font-mono text-fh-sm">{payload.ext}</code> in this repo
        </p>
        <p className="mt-1 text-fh-sm text-fh-fg-muted">
          {message} An official handler exists — add the format to see the rich diff, or ignore it to
          silence this.
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {commands.map((c) => (
            <CommandRow key={c} command={c} />
          ))}
        </div>
      </div>
    </div>
  );
}
