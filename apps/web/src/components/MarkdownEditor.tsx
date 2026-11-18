import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listIssues, listPulls, listRepoMembers, uploadAttachment } from "../api";
import { attachmentBase } from "../lib/attachments";
import type { RepoRef } from "../lib/autolink";
import {
  activeTrigger, applyFormat, attachmentMarkdown, completeTrigger, EMOJI, replacePlaceholder, uploadPlaceholder, type Format, type Trigger,
} from "../lib/markdownEditing";
import { SavedRepliesMenu } from "./SavedRepliesMenu";
import { Avatar, cx } from "../ui";
import { MarkdownRenderer } from "./MarkdownRenderer";

type Suggestion = { key: string; insert: string; label: React.ReactNode; hint?: string };

/**
 * The comment box (#253), GitHub's: Write / Preview tabs, a formatting
 * toolbar, `@` (people), `#` (issues and pull requests) and `:` (emoji)
 * autocomplete, Ctrl/⌘+Enter to submit, and files pasted, dropped or picked
 * (signed in, in a repository). Every place people write Markdown in a
 * conversation uses it.
 */
export function MarkdownEditor({
  value,
  onValueChange,
  onSubmit,
  onCancel,
  draftKey,
  token,
  repo,
  placeholder = "Leave a comment",
  rows = 4,
  autoFocus,
  ariaLabel,
  id,
  className,
  suggest,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** Ctrl/⌘+Enter. Omit where the box has no single submit action. */
  onSubmit?: () => void;
  /** Escape, when no suggestion list is open: cancel an edit (#253). */
  onCancel?: () => void;
  /**
   * Keep unsent text for this box in the tab's session storage (#253), so a
   * mis-click or a trip to another tab doesn't lose it. Cleared when the box empties.
   */
  draftKey?: string;
  token?: string | null;
  /** The repo `#N` and `@name` refer to: autolinks in Preview, and the autocomplete's source. */
  repo?: RepoRef;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  ariaLabel?: string;
  /** The textarea's id, for a `<label htmlFor>`. */
  id?: string;
  className?: string;
  /** Review comments on a line: the toolbar's "Suggest a change" toggle (#253). */
  suggest?: { active: boolean; onToggle: () => void };
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useDraft(draftKey, value, onValueChange);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const pendingSelection = useRef<[number, number] | null>(null);
  const sources = useSuggestionSources(token ?? null, repo, trigger?.char ?? null);
  // Uploads finish after renders that took newer text: they edit this, not a stale `value`.
  const latest = useRef(value);
  latest.current = value;
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const canAttach = Boolean(token && repo);

  // Restore the selection a toolbar action or completion computed, after React writes the value.
  useLayoutEffect(() => {
    const sel = pendingSelection.current;
    if (!sel || !ref.current) return;
    pendingSelection.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(sel[0], sel[1]);
  });

  // The token is gone (the box was cleared after submitting, or text replaced): close its list.
  useEffect(() => {
    if (trigger && value[trigger.start] !== trigger.char) setTrigger(null);
  }, [value, trigger]);

  const suggestions = trigger ? suggestionsFor(trigger, sources) : [];
  const open = mode === "write" && trigger !== null && suggestions.length > 0;

  function syncTrigger(el: HTMLTextAreaElement) {
    const t = el.selectionStart === el.selectionEnd ? activeTrigger(el.value, el.selectionStart) : null;
    setTrigger(t);
    setActive(0);
  }

  function format(f: Format) {
    const el = ref.current;
    if (!el) return;
    const next = applyFormat({ text: value, selStart: el.selectionStart, selEnd: el.selectionEnd }, f);
    pendingSelection.current = [next.selStart, next.selEnd];
    onValueChange(next.text);
  }

  /** Put text at the caret, replacing any selection (a saved reply, #258). */
  function insertText(text: string) {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const caret = start + text.length;
    pendingSelection.current = [caret, caret];
    latest.current = value.slice(0, start) + text + value.slice(end);
    onValueChange(latest.current);
    el?.focus();
  }

  /** Upload files (#253): a placeholder at the caret for each, then its link, or nothing and a message. */
  function attach(files: File[]) {
    if (!token || !repo || files.length === 0) return;
    setAttachError(null);
    const placeholders = files.map((f) => uploadPlaceholder(f.name));
    insertText(placeholders.join("\n"));
    files.forEach((file, i) => {
      uploadAttachment(token, repo.owner, repo.name, file).then(
        (a) => settle(placeholders[i], attachmentMarkdown(a, attachmentBase() + a.id)),
        (err: unknown) => {
          settle(placeholders[i], "");
          setAttachError(`${file.name}: ${err instanceof Error ? err.message : "the upload failed"}`);
        },
      );
    });
  }

  function settle(placeholder: string, replacement: string) {
    const el = ref.current;
    const now = { text: latest.current, selStart: el?.selectionStart ?? 0, selEnd: el?.selectionEnd ?? 0 };
    const next = replacePlaceholder(now, placeholder, replacement);
    if (next.text === now.text) return;
    // Keep the caret of someone typing on; don't pull focus back otherwise.
    if (el && document.activeElement === el) pendingSelection.current = [next.selStart, next.selEnd];
    latest.current = next.text;
    onValueChange(next.text);
  }

  /** Type a trigger character at the caret and open its list (the toolbar's @ and #). */
  function insertTrigger(char: "@" | "#") {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const needsSpace = start > 0 && !/\s/.test(value[start - 1]);
    const insert = (needsSpace ? " " : "") + char;
    const text = value.slice(0, start) + insert + value.slice(el.selectionEnd);
    const caret = start + insert.length;
    pendingSelection.current = [caret, caret];
    onValueChange(text);
    setTrigger({ char, query: "", start: caret - 1 });
    setActive(0);
  }

  function pick(s: Suggestion) {
    const el = ref.current;
    if (!el || !trigger) return;
    const done = completeTrigger(value, el.selectionStart, trigger, s.insert);
    pendingSelection.current = [done.caret, done.caret];
    onValueChange(done.text);
    setTrigger(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = suggestions.length;
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[Math.min(active, suggestions.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "Enter" && onSubmit) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey) {
      const shortcut: Record<string, Format> = { b: "bold", i: "italic", k: "link", e: "code" };
      const f = shortcut[e.key.toLowerCase()];
      if (f) {
        e.preventDefault();
        format(f);
      }
    }
  }

  const caret = useCaretPosition(ref, open ? value : null, trigger?.start ?? 0);

  return (
    <div className={cx("rounded-md border border-fh-border bg-fh-surface", className)}>
      <div className="flex items-center gap-1 px-2 pt-1.5 border-b border-fh-border bg-fh-canvas rounded-t-md">
        <EditorTab active={mode === "write"} onClick={() => setMode("write")}>Write</EditorTab>
        <EditorTab active={mode === "preview"} onClick={() => setMode("preview")}>Preview</EditorTab>
        {mode === "write" && (
          <div className="ml-auto flex items-center gap-0.5 pb-1 overflow-x-auto" role="toolbar" aria-label="Formatting">
            <ToolButton label="Add heading text" onClick={() => format("heading")}><b className="font-serif">H</b></ToolButton>
            <ToolButton label="Add bold text (Ctrl+B)" onClick={() => format("bold")}><b>B</b></ToolButton>
            <ToolButton label="Add italic text (Ctrl+I)" onClick={() => format("italic")}><i className="font-serif">I</i></ToolButton>
            <ToolButton label="Add a quote" onClick={() => format("quote")}><QuoteGlyph /></ToolButton>
            <ToolButton label="Add code (Ctrl+E)" onClick={() => format("code")}><CodeGlyph /></ToolButton>
            <ToolButton label="Add a link (Ctrl+K)" onClick={() => format("link")}><LinkGlyph /></ToolButton>
            <span className="mx-1 h-4 w-px bg-fh-border" aria-hidden />
            <ToolButton label="Add a bulleted list" onClick={() => format("bulleted")}><ListGlyph /></ToolButton>
            <ToolButton label="Add a numbered list" onClick={() => format("numbered")}><NumberedGlyph /></ToolButton>
            <ToolButton label="Add a task list" onClick={() => format("task")}><TaskGlyph /></ToolButton>
            <span className="mx-1 h-4 w-px bg-fh-border" aria-hidden />
            <ToolButton label="Mention someone" onClick={() => insertTrigger("@")}><span className="font-semibold">@</span></ToolButton>
            <ToolButton label="Reference an issue or pull request" onClick={() => insertTrigger("#")}><span className="font-semibold">#</span></ToolButton>
            {canAttach && (
              <>
                <span className="mx-1 h-4 w-px bg-fh-border" aria-hidden />
                <ToolButton label="Attach files" onClick={() => fileInput.current?.click()}><PaperclipGlyph /></ToolButton>
              </>
            )}
            {suggest && (
              <>
                <span className="mx-1 h-4 w-px bg-fh-border" aria-hidden />
                <ToolButton label="Suggest a change" pressed={suggest.active} onClick={suggest.onToggle}><SuggestGlyph /></ToolButton>
              </>
            )}
          </div>
        )}
        {mode === "write" && canAttach && (
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attach([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
        )}
        {/* Outside the toolbar: its sideways scroll would clip the menu's panel. */}
        {mode === "write" && token && (
          <div className="pb-1">
            <SavedRepliesMenu token={token} onInsert={insertText} />
          </div>
        )}
      </div>

      {mode === "write" ? (
        <div className="relative">
          <textarea
            ref={ref}
            id={id}
            rows={rows}
            value={value}
            placeholder={placeholder}
            aria-label={ariaLabel ?? placeholder}
            autoFocus={autoFocus}
            onChange={(e) => {
              onValueChange(e.target.value);
              syncTrigger(e.target);
            }}
            onKeyDown={onKeyDown}
            onClick={(e) => syncTrigger(e.currentTarget)}
            onKeyUp={(e) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) syncTrigger(e.currentTarget);
            }}
            onBlur={() => setTimeout(() => setTrigger(null), 150)}
            onPaste={(e) => {
              // Text copied from an office app carries a picture of itself too: paste the text.
              if (!canAttach || e.clipboardData.files.length === 0 || e.clipboardData.types.includes("text/plain")) return;
              e.preventDefault();
              attach([...e.clipboardData.files]);
            }}
            onDragOver={(e) => {
              if (canAttach && e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              if (!canAttach || e.dataTransfer.files.length === 0) return;
              e.preventDefault();
              attach([...e.dataTransfer.files]);
            }}
            className="block w-full resize-y bg-transparent px-3 py-2 text-fh-base leading-normal text-fh-fg placeholder:text-fh-fg-subtle focus:outline-none"
          />
          {open && (
            <ul
              role="listbox"
              aria-label="Suggestions"
              className="absolute z-20 w-72 max-h-64 overflow-y-auto rounded-md border border-fh-border bg-fh-surface py-1 shadow-lg"
              style={{ top: caret.top, left: caret.left }}
            >
              {suggestions.map((s, i) => (
                <li key={s.key} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); pick(s); }}
                    onMouseEnter={() => setActive(i)}
                    className={cx(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-left text-fh-sm",
                      i === active ? "bg-fh-accent-emphasis text-white" : "text-fh-fg hover:bg-fh-surface-muted",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    {s.hint && <span className={cx("shrink-0 text-fh-xs", i === active ? "text-white/80" : "text-fh-fg-subtle")}>{s.hint}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="px-3 py-2" style={{ minHeight: `${rows * 1.5 + 1}rem` }}>
          {value.trim() ? (
            <MarkdownRenderer content={value} repo={repo} />
          ) : (
            <p className="text-fh-sm text-fh-fg-subtle">Nothing to preview</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-fh-border-muted text-fh-xs text-fh-fg-subtle">
        <MarkdownGlyph />
        <span>Markdown is supported</span>
        {attachError && <span role="alert" className="text-fh-danger-fg">{attachError}</span>}
        {onSubmit && (
          <span className="ml-auto hidden sm:inline">
            <kbd className="font-mono">Ctrl</kbd>+<kbd className="font-mono">Enter</kbd> to submit
          </span>
        )}
      </div>
    </div>
  );
}

function EditorTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx(
        "-mb-px px-3 py-1.5 text-fh-sm rounded-t-md border",
        active
          ? "bg-fh-surface border-fh-border border-b-fh-surface text-fh-fg font-semibold"
          : "border-transparent text-fh-fg-muted hover:text-fh-fg",
      )}
    >
      {children}
    </button>
  );
}

/** Forget a kept draft: a form that leaves the page on success can't rely on emptying its box. */
export function clearDraft(key: string): void {
  try {
    sessionStorage.removeItem(`fh-draft:${key}`);
  } catch {
    /* storage blocked: no drafts */
  }
}

/** Restore a kept draft once, then keep it in step with the box (`draftKey`). */
function useDraft(key: string | undefined, value: string, onValueChange: (v: string) => void) {
  const restored = useRef(false);
  useEffect(() => {
    if (!key || restored.current) return;
    restored.current = true;
    if (value) return; // the page brought its own text
    try {
      const kept = sessionStorage.getItem(`fh-draft:${key}`);
      if (kept) onValueChange(kept);
    } catch {
      /* storage blocked: no drafts */
    }
    // Restore on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!key || !restored.current) return;
    try {
      if (value.trim()) sessionStorage.setItem(`fh-draft:${key}`, value);
      else sessionStorage.removeItem(`fh-draft:${key}`);
    } catch {
      /* storage blocked: no drafts */
    }
  }, [key, value]);
}

function ToolButton({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      // Keep the textarea's selection: a mousedown would blur it first.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx(
        "inline-flex items-center justify-center w-7 h-7 rounded text-fh-sm hover:text-fh-accent-fg hover:bg-fh-surface-muted",
        pressed ? "text-fh-accent-fg bg-fh-surface-muted" : "text-fh-fg-muted",
      )}
    >
      {children}
    </button>
  );
}

type Sources = {
  people: Array<{ handle: string; displayName: string | null; team?: boolean }>;
  refs: Array<{ number: number; title: string; kind: "issue" | "pull"; state: string }>;
};

/** The autocomplete's lists, loaded the first time their trigger is typed. */
function useSuggestionSources(token: string | null, repo: RepoRef | undefined, char: Trigger["char"] | null): Sources {
  const [people, setPeople] = useState<Sources["people"] | null>(null);
  const [refs, setRefs] = useState<Sources["refs"] | null>(null);
  useEffect(() => {
    if (!repo) return;
    if (char === "@" && people === null) {
      setPeople([]);
      listRepoMembers(token, repo.owner, repo.name)
        .then((d) => setPeople([
          ...d.members.map((m) => ({ handle: m.handle, displayName: m.displayName })),
          // Teams (#253): @org/team notifies its members.
          ...(d.teams ?? []).map((t) => ({ handle: t.handle, displayName: t.name, team: true })),
        ]))
        .catch(() => {});
    }
    if (char === "#" && refs === null) {
      setRefs([]);
      Promise.all([
        listIssues(token, repo.owner, repo.name, "all").catch(() => ({ issues: [] })),
        listPulls(token, repo.owner, repo.name, "all").catch(() => ({ pulls: [] })),
      ]).then(([i, p]) => setRefs([
        ...i.issues.map((x) => ({ number: x.number, title: x.title, kind: "issue" as const, state: x.state })),
        ...p.pulls.map((x) => ({ number: x.number, title: x.title, kind: "pull" as const, state: x.state })),
      ].sort((a, b) => b.number - a.number)));
    }
  }, [char, repo?.owner, repo?.name, token, people, refs, repo]);
  return { people: people ?? [], refs: refs ?? [] };
}

function suggestionsFor(trigger: Trigger, sources: Sources): Suggestion[] {
  const q = trigger.query.toLowerCase();
  if (trigger.char === "@") {
    return sources.people
      .filter((p) => p.handle.toLowerCase().includes(q) || (p.displayName ?? "").toLowerCase().includes(q))
      .slice(0, 8)
      .map((p) => ({
        key: p.handle,
        insert: `@${p.handle}`,
        label: <span className="inline-flex items-center gap-2"><Avatar name={p.handle} size={16} square={p.team} /><b>{p.handle}</b> {p.displayName && <span className="opacity-70">{p.displayName}</span>}</span>,
      }));
  }
  if (trigger.char === "#") {
    return sources.refs
      .filter((r) => String(r.number).startsWith(q) || r.title.toLowerCase().includes(q))
      .slice(0, 8)
      .map((r) => ({
        key: `${r.kind}-${r.number}`,
        insert: `#${r.number}`,
        label: <><span className="opacity-70">#{r.number}</span> {r.title}</>,
        hint: r.kind === "pull" ? "pull request" : "issue",
      }));
  }
  return EMOJI.filter(([name]) => name.includes(q))
    .slice(0, 8)
    .map(([name, char]) => ({ key: name, insert: char, label: <><span className="mr-1">{char}</span>:{name}:</> }));
}

/**
 * Where the suggestion list goes: just under the caret's line, measured with a
 * mirror of the textarea (the usual trick, since a textarea can't report it).
 */
function useCaretPosition(ref: React.RefObject<HTMLTextAreaElement | null>, value: string | null, index: number) {
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || value === null) return;
    const style = getComputedStyle(el);
    const mirror = document.createElement("div");
    for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderLeftWidth", "boxSizing", "whiteSpace", "wordWrap", "tabSize"] as const) {
      mirror.style[p] = style[p];
    }
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.width = `${el.clientWidth}px`;
    mirror.textContent = value.slice(0, index);
    const mark = document.createElement("span");
    mark.textContent = "​";
    mirror.appendChild(mark);
    document.body.appendChild(mirror);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const top = mark.offsetTop - el.scrollTop + lineHeight + 4;
    const left = Math.min(mark.offsetLeft, Math.max(0, el.clientWidth - 288));
    document.body.removeChild(mirror);
    setPos({ top, left });
  }, [ref, value, index]);
  return pos;
}

const glyph = "w-4 h-4";
function QuoteGlyph() {
  return <svg className={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M1.75 2.5h10.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Zm4 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5ZM2.5 7.75v6a.75.75 0 0 1-1.5 0v-6a.75.75 0 0 1 1.5 0Z" /></svg>;
}
function CodeGlyph() {
  return <svg className={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06-1.06L13.94 8l-3.72-3.72a.749.749 0 0 1 1.06-1.06Zm-6.56 0a.751.751 0 0 1 1.06 1.06L2.06 8l3.72 3.72a.749.749 0 0 1-1.06 1.06L.47 8.53a.75.75 0 0 1 0-1.06Z" /></svg>;
}
function LinkGlyph() {
  return <svg className={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 1.06-1.06 2 2 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.06-1.06Zm-4.69 9.64a2 2 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.06 1.06l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-1.06 1.06 2 2 0 0 0-2.83 0l-2.5 2.5a2 2 0 0 0 0 2.83Z" /></svg>;
}
function ListGlyph() {
  return <svg className={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M5.75 2.5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Zm0 5h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5ZM2 14a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM2 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" /></svg>;
}
function NumberedGlyph() {
  return <svg className={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M5 3.25a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 5 3.25Zm0 5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 5 8.25Zm0 5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1-.75-.75ZM.924 10.32a.5.5 0 0 1-.851-.525l.001-.001.001-.002.002-.004.007-.011c.097-.144.215-.273.348-.384.228-.19.588-.392 1.068-.392.468 0 .858.181 1.126.484.259.294.377.673.377 1.038 0 .987-.686 1.495-1.156 1.845l-.047.035c-.303.225-.522.4-.654.597h1.357a.5.5 0 0 1 0 1H.5a.5.5 0 0 1-.5-.5c0-1.005.692-1.52 1.167-1.875l.035-.025c.531-.396.8-.625.8-1.078a.57.57 0 0 0-.128-.376C1.806 10.068 1.695 10 1.5 10a.658.658 0 0 0-.429.163.835.835 0 0 0-.144.153ZM2.003 2.5V6h.503a.5.5 0 0 1 0 1H.5a.5.5 0 0 1 0-1h.503V3.308l-.28.14a.5.5 0 0 1-.446-.895l1.003-.5a.5.5 0 0 1 .723.447Z" /></svg>;
}
function SuggestGlyph() {
  return <svg className={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8.75 1.75V5H12a.75.75 0 0 1 0 1.5H8.75v3.25a.75.75 0 0 1-1.5 0V6.5H4A.75.75 0 0 1 4 5h3.25V1.75a.75.75 0 0 1 1.5 0ZM4 13h8a.75.75 0 0 1 0 1.5H4A.75.75 0 0 1 4 13Z" /></svg>;
}
function TaskGlyph() {
  return <svg className={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M2.5 1.75v11.5c0 .138.112.25.25.25h3.17a.75.75 0 0 1 0 1.5H2.75A1.75 1.75 0 0 1 1 13.25V1.75C1 .784 1.784 0 2.75 0h8.5C12.216 0 13 .784 13 1.75v7.736a.75.75 0 0 1-1.5 0V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13.274 9.537v-.001l-4.557 4.45a.75.75 0 0 1-1.055-.008l-1.943-1.95a.75.75 0 0 1 1.062-1.058l1.419 1.425 4.026-3.932a.75.75 0 1 1 1.048 1.074Z" /></svg>;
}
function PaperclipGlyph() {
  return <svg className={glyph} viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M12.212 3.02a1.753 1.753 0 0 0-2.478.003l-5.83 5.83a3.007 3.007 0 0 0-.88 2.127c0 .795.315 1.551.88 2.116.567.567 1.333.89 2.126.89.79 0 1.548-.321 2.116-.89l5.48-5.48a.75.75 0 0 1 1.061 1.06l-5.48 5.48a4.492 4.492 0 0 1-3.177 1.33c-1.2 0-2.345-.487-3.187-1.33a4.483 4.483 0 0 1-1.32-3.177c0-1.195.475-2.341 1.32-3.186l5.83-5.83a3.25 3.25 0 0 1 5.553 2.297c0 .863-.343 1.691-.953 2.301L7.439 12.39c-.375.377-.884.59-1.416.593a1.998 1.998 0 0 1-1.412-.593 1.992 1.992 0 0 1 0-2.828l5.48-5.48a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-5.48 5.48a.492.492 0 0 0 0 .707.499.499 0 0 0 .352.154.51.51 0 0 0 .356-.154l5.833-5.827a1.755 1.755 0 0 0 0-2.481Z" /></svg>;
}
function MarkdownGlyph() {
  return <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M14.85 3c.63 0 1.15.52 1.14 1.15v7.7c0 .63-.51 1.15-1.15 1.15H1.15C.52 13 0 12.48 0 11.84V4.15C0 3.52.52 3 1.15 3ZM9 11V5H7L5.5 7 4 5H2v6h2V8l1.5 1.92L7 8v3Zm2.99.5L14.5 8H13V5h-2v3H9.5Z" /></svg>;
}
