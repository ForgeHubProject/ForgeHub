import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listRepoPaths } from "../../api";
import { matchPaths, type PathMatch } from "../../lib/fuzzyPath";
import { Icons, cx } from "../../ui";

// "Go to file" (#223), GitHub-style: fuzzy search over every path at the ref,
// opened with the `t` shortcut.

type Paths = { paths: string[]; truncated: boolean };

// One request per repo and ref for the page's lifetime; the list is per commit
// on the server anyway.
const pathsCache = new Map<string, Promise<Paths>>();

function loadPaths(token: string | null, handle: string, repoName: string, ref: string): Promise<Paths> {
  const key = `${handle}/${repoName}@${ref}`;
  let p = pathsCache.get(key);
  if (!p) {
    p = listRepoPaths(token, handle, repoName, ref).then(({ paths, truncated }) => ({ paths, truncated }));
    p.catch(() => pathsCache.delete(key));
    pathsCache.set(key, p);
  }
  return p;
}

/** Does this key event belong to a text field, where `t` is just a letter? */
function typingInField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function Highlighted({ match }: { match: PathMatch }) {
  const hits = new Set(match.hits);
  return (
    <>
      {[...match.path].map((ch, i) => (hits.has(i) ? <mark key={i} className="bg-transparent font-semibold text-fh-accent-fg">{ch}</mark> : ch))}
    </>
  );
}

export function GoToFile({ token, handle, repoName, gitRef, base }: {
  token: string | null;
  handle: string;
  repoName: string;
  gitRef: string;
  base: string;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Paths | null>(null);
  const [error, setError] = useState(false);
  const [active, setActive] = useState(0);

  // `t` focuses the search from anywhere on the page but a text field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "t" || e.ctrlKey || e.metaKey || e.altKey || typingInField(e)) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fetch the list the first time the search opens for this ref.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(false);
    loadPaths(token, handle, repoName, gitRef)
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [open, token, handle, repoName, gitRef]);

  // Match a moment after typing pauses, not on every keystroke of a long name.
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSettled(query), 80);
    return () => clearTimeout(t);
  }, [query]);
  const matches = useMemo(() => (data && settled.trim() ? matchPaths(data.paths, settled) : []), [data, settled]);
  useEffect(() => setActive(0), [settled]);

  function go(path: string) {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    navigate(`${base}/blob/${gitRef}/${path}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && matches[active]) { e.preventDefault(); go(matches[active]!.path); }
    else if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-md border border-fh-border bg-fh-surface px-2 focus-within:border-fh-accent-emphasis">
        <span className="text-fh-fg-subtle"><Icons.SearchIcon size={14} /></span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          placeholder="Go to file"
          aria-label="Go to file"
          aria-expanded={open && matches.length > 0}
          aria-controls="go-to-file-results"
          role="combobox"
          className="h-8 w-full min-w-0 bg-transparent text-fh-sm text-fh-fg outline-none placeholder:text-fh-fg-subtle"
        />
        <kbd className="hidden rounded border border-fh-border px-1.5 text-fh-xs text-fh-fg-subtle sm:inline">t</kbd>
      </div>
      {open && query.trim() !== "" && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-md border border-fh-border bg-fh-surface shadow-lg">
          {error ? (
            <p className="px-3 py-2 text-fh-sm text-fh-danger-fg">Could not load the file list.</p>
          ) : !data ? (
            <p className="px-3 py-2 text-fh-sm text-fh-fg-subtle">Loading files…</p>
          ) : matches.length === 0 ? (
            <p className="px-3 py-2 text-fh-sm text-fh-fg-subtle">No files match.</p>
          ) : (
            <ul id="go-to-file-results" role="listbox">
              {matches.map((m, i) => (
                <li key={m.path} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); go(m.path); }}
                    onMouseEnter={() => setActive(i)}
                    className={cx(
                      "block w-full truncate px-3 py-1.5 text-left font-mono text-fh-xs text-fh-fg cursor-pointer",
                      i === active && "bg-fh-accent-muted",
                    )}
                    title={m.path}
                  >
                    <Highlighted match={m} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data?.truncated && (
            <p className="border-t border-fh-border px-3 py-1.5 text-fh-xs text-fh-fg-subtle">
              Searching the first {data.paths.length.toLocaleString()} files of a larger repository.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
