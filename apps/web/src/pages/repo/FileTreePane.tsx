import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listTree } from "../../api";
import type { TreeEntry } from "../../types";
import { Icons, cx } from "../../ui";
import { FileIcon, FolderIcon } from "./fileIcons";

// The repository's file tree beside a file (#223), GitHub-style: opened down to
// the current file, folders loaded only when opened, and kept as it is while
// the reader moves from file to file.

type DirState = TreeEntry[] | "loading" | "error";

/** Every folder above `path`: "a/b/c.txt" → ["a", "a/b"]. */
export function ancestorDirs(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Folders first, then files, each alphabetical, as the Code tab lists them. */
export function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1,
  );
}

type Props = {
  token: string | null;
  handle: string;
  repoName: string;
  gitRef: string;
  /** The file on screen, highlighted and opened to. */
  currentPath: string;
  /** "/owner/repo". */
  base: string;
};

export function FileTreePane({ token, handle, repoName, gitRef, currentPath, base }: Props) {
  const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map());
  const [open, setOpen] = useState<Set<string>>(() => new Set(ancestorDirs(currentPath)));
  const loading = useRef(new Set<string>());
  const scrolled = useRef(false);
  const scope = `${handle}/${repoName}@${gitRef}`;

  // A different ref is a different tree: start over, opened to the file.
  useEffect(() => {
    setDirs(new Map());
    setOpen(new Set(ancestorDirs(currentPath)));
    loading.current = new Set();
    scrolled.current = false;
    // currentPath is read once per ref; following it is the next effect's job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Moving to another file opens its folders, leaving the rest as they were.
  useEffect(() => {
    setOpen((prev) => {
      const missing = ancestorDirs(currentPath).filter((d) => !prev.has(d));
      return missing.length ? new Set([...prev, ...missing]) : prev;
    });
  }, [currentPath]);

  const load = useCallback(
    (dir: string) => {
      if (loading.current.has(dir)) return;
      loading.current.add(dir);
      setDirs((m) => new Map(m).set(dir, "loading"));
      listTree(token, handle, repoName, gitRef, dir || undefined)
        .then(({ entries }) => setDirs((m) => new Map(m).set(dir, sortEntries(entries))))
        .catch(() => setDirs((m) => new Map(m).set(dir, "error")));
    },
    [token, handle, repoName, gitRef],
  );

  // Load the root and every open folder that isn't loaded yet.
  useEffect(() => {
    for (const dir of ["", ...open]) if (!dirs.has(dir)) load(dir);
  }, [open, dirs, load]);

  const toggle = (dir: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  // Bring the current file into view once, when it first appears.
  const currentRef = useCallback((el: HTMLAnchorElement | null) => {
    if (!el || scrolled.current) return;
    scrolled.current = true;
    const scroll = (el as { scrollIntoView?: (arg: unknown) => void }).scrollIntoView;
    if (typeof scroll === "function") scroll.call(el, { block: "nearest" });
  }, []);

  function renderDir(dir: string, depth: number): React.ReactNode {
    const state = dirs.get(dir);
    const pad = { paddingLeft: `${8 + depth * 14}px` };
    if (state === undefined || state === "loading") {
      return <li className="py-1 text-fh-xs text-fh-fg-subtle" style={pad}>Loading…</li>;
    }
    if (state === "error") {
      return <li className="py-1 text-fh-xs text-fh-danger-fg" style={pad}>Could not load this folder.</li>;
    }
    return state.map((entry) => {
      if (entry.type === "tree") {
        const isOpen = open.has(entry.path);
        return (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => toggle(entry.path)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-fh-sm text-fh-fg hover:bg-fh-surface-muted cursor-pointer"
              style={pad}
              title={entry.path}
            >
              <span className={cx("shrink-0 text-fh-fg-subtle transition-transform", !isOpen && "-rotate-90")}>
                <Icons.ChevronDownIcon size={12} />
              </span>
              <FolderIcon />
              <span className="truncate">{entry.name}</span>
            </button>
            {isOpen && <ul>{renderDir(entry.path, depth + 1)}</ul>}
          </li>
        );
      }
      const current = entry.path === currentPath;
      return (
        <li key={entry.path}>
          <Link
            to={`${base}/blob/${gitRef}/${entry.path}`}
            ref={current ? currentRef : undefined}
            aria-current={current ? "page" : undefined}
            className={cx(
              "flex items-center gap-1.5 rounded-md py-1 pr-2 text-fh-sm no-underline",
              current ? "bg-fh-accent-muted font-semibold text-fh-fg" : "text-fh-fg hover:bg-fh-surface-muted",
            )}
            style={{ paddingLeft: `${8 + depth * 14 + 16}px` }}
            title={entry.path}
          >
            <FileIcon />
            <span className="truncate">{entry.name}</span>
          </Link>
        </li>
      );
    });
  }

  return (
    <nav aria-label="Repository files">
      <ul className="space-y-px">{renderDir("", 0)}</ul>
    </nav>
  );
}
