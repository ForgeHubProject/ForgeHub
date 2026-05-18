import { useEffect, useRef, useState } from "react";
import { search } from "../api";
import type { SearchUserResult } from "../types";

export function UserSearchInput({ token, onSelect, placeholder = "Search by username or name…" }: {
  token: string;
  onSelect: (user: SearchUserResult) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchUserResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (val.trim().length < 2) { setResults([]); setOpen(false); return; }
    timerRef.current = setTimeout(() => {
      setSearching(true);
      search(token, val.trim(), "users")
        .then((d) => { setResults(d.results as SearchUserResult[]); setOpen(true); })
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 300);
  }

  function pick(user: SearchUserResult) {
    setQuery(""); setResults([]); setOpen(false);
    onSelect(user);
  }

  return (
    <div ref={containerRef} className="relative flex-1 min-w-[200px]">
      <div className="relative">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gh-muted pointer-events-none">
          <path fillRule="evenodd" d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06L10.68 11.74z" />
        </svg>
        <input
          className="input pl-8 w-full"
          placeholder={placeholder}
          value={query}
          onChange={handleChange}
          onFocus={() => results.length > 0 && setOpen(true)}
          autoComplete="off"
        />
        {searching && (
          <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-gh-muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        )}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 top-[calc(100%+4px)] left-0 right-0 bg-gh-canvas border border-gh-border rounded-lg shadow-xl overflow-hidden max-h-64 overflow-y-auto">
          {results.map((u) => (
            <button key={u.id} type="button" className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gh-bg text-left transition-colors" onClick={() => pick(u)}>
              <div className="w-8 h-8 rounded-full bg-gh-accent flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                {(u.displayName || u.handle)[0].toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gh-text truncate">{u.displayName || u.handle}</p>
                <p className="text-xs text-gh-muted">@{u.handle}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      {open && !searching && query.trim().length >= 2 && results.length === 0 && (
        <div className="absolute z-50 top-[calc(100%+4px)] left-0 right-0 bg-gh-canvas border border-gh-border rounded-lg shadow-xl px-4 py-3 text-sm text-gh-muted">
          No users found for "{query}"
        </div>
      )}
    </div>
  );
}
