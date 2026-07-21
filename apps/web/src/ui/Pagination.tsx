import { cx } from "./cx";
import { ChevronDownIcon } from "./icons";

type Props = {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  className?: string;
};

/** Build the list of page tokens with gaps, e.g. [1,"…",4,5,6,"…",20]. */
function pageTokens(page: number, pageCount: number): (number | "gap")[] {
  const tokens: (number | "gap")[] = [];
  const add = (n: number) => tokens.push(n);
  const window = 1;
  const lo = Math.max(2, page - window);
  const hi = Math.min(pageCount - 1, page + window);
  add(1);
  if (lo > 2) tokens.push("gap");
  for (let n = lo; n <= hi; n++) add(n);
  if (hi < pageCount - 1) tokens.push("gap");
  if (pageCount > 1) add(pageCount);
  return tokens;
}

/** Numbered pager with previous/next chevrons. Hidden when there's ≤1 page. */
export function Pagination({ page, pageCount, onPageChange, className }: Props) {
  if (pageCount <= 1) return null;

  const cellBase =
    "inline-flex items-center justify-center min-w-8 h-8 px-2 rounded-md text-fh-base border border-transparent cursor-pointer select-none transition-colors";

  return (
    <nav aria-label="Pagination" className={cx("flex items-center justify-center gap-1", className)}>
      <button
        type="button"
        className={cx(cellBase, "gap-1 text-fh-fg hover:border-fh-border disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-transparent bg-transparent")}
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
      >
        <ChevronDownIcon size={14} className="rotate-90" />
        <span className="hidden sm:inline">Previous</span>
      </button>

      {pageTokens(page, pageCount).map((tok, i) =>
        tok === "gap" ? (
          <span key={`gap-${i}`} className="inline-flex items-center justify-center min-w-8 h-8 text-fh-fg-subtle select-none">
            …
          </span>
        ) : (
          <button
            key={tok}
            type="button"
            aria-current={tok === page ? "page" : undefined}
            className={cx(
              cellBase,
              tok === page
                ? "bg-fh-accent-emphasis text-fh-on-emphasis font-semibold"
                : "text-fh-fg hover:border-fh-border bg-transparent",
            )}
            onClick={() => onPageChange(tok)}
          >
            {tok}
          </button>
        ),
      )}

      <button
        type="button"
        className={cx(cellBase, "gap-1 text-fh-fg hover:border-fh-border disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-transparent bg-transparent")}
        onClick={() => onPageChange(page + 1)}
        disabled={page >= pageCount}
      >
        <span className="hidden sm:inline">Next</span>
        <ChevronDownIcon size={14} className="-rotate-90" />
      </button>
    </nav>
  );
}
