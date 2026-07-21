import { Link } from "react-router-dom";
import { RelativeTime, cx } from "../../ui";
import { highlightCode, langForFilename } from "../../lib/highlight";
import type { BlameHunk } from "../../types";
import type { FileViewerProps } from "../fileViewerTypes";

function splitHighlightedLines(highlighted: string): string[] {
  const result: string[] = [];
  let currentLine = "";
  let depth = 0;
  const parts = highlighted.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    currentLine += (i > 0 ? "\n" : "") + part;
    depth += (part.match(/<span[^>]*>/g) ?? []).length;
    depth -= (part.match(/<\/span>/g) ?? []).length;
    if (depth <= 0) {
      result.push(currentLine);
      currentLine = "";
      depth = 0;
    }
  }
  if (currentLine) result.push(currentLine);
  return result;
}

/** The blame chrome shown once per hunk, spanning its lines via rowSpan. */
function BlameGutterCell({ hunk, span, repoBase }: { hunk: BlameHunk; span: number; repoBase?: string }) {
  return (
    <td
      rowSpan={span}
      className="align-top border-r border-fh-border bg-fh-canvas px-2 py-1 w-[220px] max-w-[220px]"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        {repoBase ? (
          <Link
            to={`${repoBase}/commits/${hunk.sha}`}
            title={hunk.summary}
            className="font-mono text-fh-xs text-fh-accent-fg no-underline hover:underline shrink-0"
          >
            {hunk.shortSha}
          </Link>
        ) : (
          <span className="font-mono text-fh-xs text-fh-fg-muted shrink-0">{hunk.shortSha}</span>
        )}
        <span className="truncate text-fh-xs text-fh-fg-muted" title={hunk.summary}>{hunk.summary}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-fh-xs text-fh-fg-subtle min-w-0">
        <span className="truncate font-medium">{hunk.author}</span>
        {hunk.date && (
          <>
            <span aria-hidden="true">·</span>
            <RelativeTime date={hunk.date} className="shrink-0" />
          </>
        )}
      </div>
    </td>
  );
}

export function CodeViewer({ content, filename, repoBase, selectedRange, onLineSelect, blame }: FileViewerProps) {
  const lang = langForFilename(filename);
  const lines = content.split("\n");
  const highlighted = highlightCode(content, lang);
  const highlightedLines = splitHighlightedLines(highlighted);

  // Map a line number → the hunk starting there (blame gutter is emitted once
  // per hunk and spans its rows).
  const hunkStart = new Map<number, BlameHunk>();
  if (blame) for (const h of blame) hunkStart.set(h.startLine, h);

  const inSelection = (n: number) =>
    selectedRange != null && n >= selectedRange.start && n <= selectedRange.end;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs font-mono" style={{ lineHeight: "20px" }}>
        <tbody>
          {lines.map((_, i) => {
            const n = i + 1;
            const selected = inSelection(n);
            const hunk = hunkStart.get(n);
            return (
              <tr key={i} id={`L${n}`} className={cx("group", selected ? "bg-fh-accent-muted" : "hover:bg-fh-surface-muted")}>
                {blame && (hunk
                  ? <BlameGutterCell hunk={hunk} span={hunk.endLine - hunk.startLine + 1} repoBase={repoBase} />
                  : null)}
                <td
                  className={cx(
                    "select-none text-right pr-4 pl-3 w-[1%] whitespace-nowrap border-r border-fh-border",
                    onLineSelect ? "cursor-pointer" : "",
                    selected ? "text-fh-accent-fg" : "text-fh-fg-muted",
                  )}
                  style={{ userSelect: "none", minWidth: 40 }}
                  onClick={onLineSelect ? (e) => onLineSelect(n, e.shiftKey) : undefined}
                >
                  {onLineSelect ? (
                    <a
                      href={`#L${n}`}
                      onClick={(e) => e.preventDefault()}
                      className="text-inherit no-underline"
                      aria-label={`Line ${n}`}
                    >
                      {n}
                    </a>
                  ) : (
                    n
                  )}
                </td>
                <td className="pl-4 pr-4 whitespace-pre">
                  <span dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? "" }} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
