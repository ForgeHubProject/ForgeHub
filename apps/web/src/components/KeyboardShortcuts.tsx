import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { resolveShortcut, SHORTCUTS } from "../lib/shortcuts";
import { Dialog } from "../ui";

/** Keys typed into a field are text, not shortcuts. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * GitHub's keyboard shortcuts across the site (#255): `/` search, `g` then a
 * letter to go somewhere, `t` to find a file, `?` for the list.
 */
export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [help, setHelp] = useState(false);
  const pending = useRef<{ keys: string[]; at: number } | null>(null);
  const where = useRef(pathname);
  where.current = pathname;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key.length !== 1) return;
      const now = Date.now();
      // A second key must follow the first within a moment, as on GitHub.
      const keys = pending.current && now - pending.current.at < 1500 ? [...pending.current.keys, e.key] : [e.key];
      pending.current = null;
      const action = resolveShortcut(keys, where.current);
      if (!action) return;
      e.preventDefault();
      if (action.kind === "pending") pending.current = { keys, at: now };
      else if (action.kind === "help") setHelp(true);
      else if (action.kind === "navigate") navigate(action.to);
      else {
        const el = document.querySelector<HTMLElement>(action.selector);
        el?.focus();
        if (el instanceof HTMLInputElement) el.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <Dialog open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
      {(["site", "repo"] as const).map((where) => (
        <section key={where} className="mb-4 last:mb-0">
          <h3 className="mb-2 text-fh-sm font-semibold text-fh-fg">{where === "site" ? "Site-wide" : "In a repository"}</h3>
          <dl className="divide-y divide-fh-border-muted rounded-md border border-fh-border">
            {SHORTCUTS.filter((s) => s.where === where).map((s) => (
              <div key={s.keys} className="flex items-center justify-between gap-4 px-3 py-1.5 text-fh-sm">
                <dt className="text-fh-fg-muted">{s.what}</dt>
                <dd className="flex gap-1">
                  {s.keys.split(" ").map((k, i) => (
                    <kbd key={i} className="min-w-[1.5rem] rounded border border-fh-border bg-fh-canvas px-1.5 text-center font-mono text-fh-xs text-fh-fg">{k}</kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Dialog>
  );
}
