import { useEffect, useMemo, useRef, useState } from "react";
import { listIssues, listPulls } from "../../../api";
import { Spinner, TextInput, cx } from "../../../ui";
import type { ProjectSubjectType } from "../../../types";
import { PlusIcon, SubjectStateIcon, XIcon, subjectRef } from "./parts";

type Candidate = {
  type: ProjectSubjectType;
  number: number;
  title: string;
  state: string;
};

type Props = {
  token: string;
  handle: string;
  repoName: string;
  /** Keys (`issue:5` / `pull:3`) already on the board — filtered out of results. */
  excludeKeys: Set<string>;
  onAdd: (type: ProjectSubjectType, number: number) => Promise<void>;
};

/**
 * Column-footer affordance: an "Add item" button that opens a search-by-number
 * or -title picker over the repo's issues and PRs. Candidates are fetched once
 * per open and filtered client-side; already-added subjects are excluded.
 */
export function AddItemPicker({ token, handle, repoName, excludeKeys, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load candidates the first time the picker opens.
  useEffect(() => {
    if (!open || candidates) return;
    setLoading(true);
    Promise.all([
      listIssues(token, handle, repoName, "all").catch(() => ({ issues: [] })),
      listPulls(token, handle, repoName, "all").catch(() => ({ pulls: [] })),
    ])
      .then(([iss, pr]) => {
        const list: Candidate[] = [
          ...iss.issues.map((i) => ({ type: "issue" as const, number: i.number, title: i.title, state: i.state })),
          ...pr.pulls.map((p) => ({ type: "pull" as const, number: p.number, title: p.title, state: p.state })),
        ];
        setCandidates(list);
      })
      .finally(() => setLoading(false));
  }, [open, candidates, token, handle, repoName]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const results = useMemo(() => {
    if (!candidates) return [];
    const q = query.trim().toLowerCase().replace(/^[#!]/, "");
    return candidates
      .filter((c) => !excludeKeys.has(`${c.type}:${c.number}`))
      .filter((c) => {
        if (!q) return true;
        return String(c.number).includes(q) || c.title.toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [candidates, query, excludeKeys]);

  async function add(c: Candidate) {
    const key = `${c.type}:${c.number}`;
    setAdding(key);
    try {
      await onAdd(c.type, c.number);
      // Optimistically drop it from the local candidate list so it can't be re-added.
      setCandidates((prev) => prev?.filter((x) => !(x.type === c.type && x.number === c.number)) ?? prev);
      setQuery("");
    } catch {
      // The parent surfaces the failure via a toast; keep the picker open to retry.
    } finally {
      setAdding(null);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 w-full inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-fh-sm text-fh-fg-muted hover:bg-fh-surface-muted hover:text-fh-fg outline-none focus-visible:ring-2 focus-visible:ring-fh-accent-emphasis"
      >
        <PlusIcon size={14} /> Add item
      </button>
    );
  }

  return (
    <div ref={rootRef} className="mt-1 rounded-md border border-fh-border bg-fh-surface shadow-overlay">
      <div className="flex items-center gap-1.5 border-b border-fh-border-muted p-1.5">
        <TextInput
          ref={inputRef}
          sizing="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search issues and PRs by # or title"
        />
        <button
          type="button"
          aria-label="Close"
          onClick={() => setOpen(false)}
          className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md text-fh-fg-muted hover:bg-fh-surface-muted"
        >
          <XIcon size={14} />
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-fh-sm text-fh-fg-muted">
            <Spinner size={14} /> Loading…
          </div>
        ) : results.length === 0 ? (
          <p className="px-3 py-3 text-fh-sm text-fh-fg-muted">
            {candidates && candidates.length === 0 ? "No issues or pull requests yet." : "No matches."}
          </p>
        ) : (
          results.map((c) => {
            const key = `${c.type}:${c.number}`;
            return (
              <button
                key={key}
                type="button"
                onClick={() => add(c)}
                disabled={adding !== null}
                className={cx(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-left text-fh-sm outline-none",
                  "hover:bg-fh-accent-muted focus-visible:bg-fh-accent-muted disabled:opacity-60",
                )}
              >
                <SubjectStateIcon subject={{ type: c.type, number: c.number, title: c.title, state: c.state, labels: [], assignee: null }} size={14} />
                <span className="shrink-0 font-mono text-fh-xs text-fh-fg-subtle">{subjectRef(c.type, c.number)}</span>
                <span className="min-w-0 flex-1 truncate text-fh-fg">{c.title}</span>
                {adding === key && <Spinner size={12} />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
