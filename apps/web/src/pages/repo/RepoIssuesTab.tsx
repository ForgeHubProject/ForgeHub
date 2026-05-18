import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  addIssueLabel, createIssue, createIssueComment, getIssue,
  listIssueComments, listIssues, listLabels, listRepoMembers, removeIssueLabel,
  RepoMember, updateIssue,
} from "../../api";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import type { Issue, IssueComment, Label, SearchUserResult, User } from "../../types";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
  splat: string;
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function LabelChip({ label, onRemove }: { label: Label; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full font-medium"
      style={{ backgroundColor: `#${label.color}22`, color: `#${label.color}`, border: `1px solid #${label.color}44` }}
    >
      {label.name}
      {onRemove && (
        <button type="button" onClick={onRemove} className="hover:opacity-70 ml-0.5 leading-none">×</button>
      )}
    </span>
  );
}

function OpenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-gh-success">
      <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
      <path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
    </svg>
  );
}

function ClosedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="text-purple-600">
      <path d="M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z" />
      <path fillRule="evenodd" d="M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-gh-muted">
      <path fillRule="evenodd" d="M7.429 1.525a6.593 6.593 0 011.142 0c.036.003.108.036.137.146l.289 1.105c.147.56.55.967.997 1.189.174.086.341.183.501.29.455.3.964.39 1.486.23l1.11-.319c.11-.031.175.016.195.046.219.31.41.641.567.987.063.14.025.21-.007.245l-.793.827c-.397.414-.528.975-.43 1.52.023.127.035.257.035.388s-.012.261-.035.388c-.098.546.033 1.107.43 1.52l.793.827c.032.035.07.105.007.245a6.08 6.08 0 01-.567.987c-.02.03-.085.077-.195.046l-1.11-.32c-.522-.158-1.031-.068-1.486.23-.16.108-.327.205-.501.29-.447.222-.85.629-.997 1.189l-.289 1.105c-.029.11-.1.143-.137.146a6.613 6.613 0 01-1.142 0c-.036-.003-.108-.036-.137-.146l-.289-1.105c-.147-.56-.55-.967-.997-1.189a4.502 4.502 0 01-.501-.29c-.455-.299-.964-.39-1.486-.23l-1.11.32c-.11.031-.175-.016-.195-.046a6.08 6.08 0 01-.567-.987c-.063-.14-.025-.21.007-.245l.793-.827c.397-.413.528-.974.43-1.52A3.999 3.999 0 014 8c0-.131.012-.261.035-.388.098-.546-.033-1.106-.43-1.52l-.793-.827c-.032-.034-.07-.104-.007-.244.157-.346.348-.677.567-.987.02-.03.085-.077.195-.046l1.11.319c.522.158 1.031.068 1.486-.23.16-.107.327-.204.501-.29.447-.222.85-.629.997-1.189l.289-1.105c.029-.11.1-.143.137-.146zM8 6a2 2 0 100 4 2 2 0 000-4z" />
    </svg>
  );
}

// ─── Sidebar label picker ──────────────────────────────────────────────────────

function LabelPicker({ token, handle, repoName, issue, canEdit, onUpdate }: {
  token: string; handle: string; repoName: string;
  issue: Issue; canEdit: boolean; onUpdate: (updated: Issue) => void;
}) {
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listLabels(token, handle, repoName).then((d) => setAllLabels(d.labels)).catch(() => {});
  }, [token, handle, repoName]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function toggle(label: Label) {
    const has = issue.labels.some((l) => l.id === label.id);
    try {
      if (has) {
        await removeIssueLabel(token, handle, repoName, issue.number, label.id);
        onUpdate({ ...issue, labels: issue.labels.filter((l) => l.id !== label.id) });
      } else {
        await addIssueLabel(token, handle, repoName, issue.number, label.id);
        onUpdate({ ...issue, labels: [...issue.labels, label] });
      }
    } catch { /* ignore */ }
  }

  return (
    <div className="mb-4" ref={ref}>
      <div className="flex items-center justify-between mb-2 pb-2 border-b border-gh-border">
        <p className="text-xs font-semibold text-gh-text uppercase tracking-wide">Labels</p>
        {canEdit && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-gh-muted hover:text-gh-text">
            <GearIcon />
          </button>
        )}
      </div>

      {open && allLabels.length > 0 && (
        <div className="absolute z-50 mt-1 w-56 bg-gh-canvas border border-gh-border rounded-lg shadow-xl overflow-hidden">
          {allLabels.map((lbl) => {
            const checked = issue.labels.some((l) => l.id === lbl.id);
            return (
              <button
                key={lbl.id}
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gh-bg text-left"
                onClick={() => toggle(lbl)}
              >
                <span className="w-4 h-4 flex items-center justify-center border border-gh-border rounded flex-shrink-0" style={{ backgroundColor: checked ? `#${lbl.color}` : undefined }}>
                  {checked && <svg width="10" height="10" viewBox="0 0 16 16" fill="white"><path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>}
                </span>
                <LabelChip label={lbl} />
              </button>
            );
          })}
        </div>
      )}

      {open && allLabels.length === 0 && (
        <div className="absolute z-50 mt-1 w-56 bg-gh-canvas border border-gh-border rounded-lg shadow-xl px-3 py-2 text-sm text-gh-muted">
          No labels yet. Create them in Settings.
        </div>
      )}

      {issue.labels.length === 0 ? (
        <p className="text-xs text-gh-muted">None yet</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((lbl) => (
            <LabelChip key={lbl.id} label={lbl} onRemove={canEdit ? () => toggle(lbl) : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Member picker (only repo owner + collaborators) ──────────────────────────

function MemberPicker({ token, handle, repoName, selected, onSelect, onClear, placeholder = "Assign to…" }: {
  token: string; handle: string; repoName: string;
  selected?: string | null;
  onSelect: (m: RepoMember) => void;
  onClear?: () => void;
  placeholder?: string;
}) {
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRepoMembers(token, handle, repoName).then((d) => setMembers(d.members)).catch(() => {});
  }, [token, handle, repoName]);

  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQuery(""); }
    }
    document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, []);

  const filtered = query.trim()
    ? members.filter((m) => m.handle.includes(query.toLowerCase()) || (m.displayName ?? "").toLowerCase().includes(query.toLowerCase()))
    : members;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="w-full text-left text-xs text-gh-accent hover:underline"
        onClick={() => setOpen((o) => !o)}
      >
        {selected ?? placeholder}
      </button>
      {open && (
        <div className="absolute z-50 left-0 top-[calc(100%+4px)] w-56 bg-gh-canvas border border-gh-border rounded-lg shadow-xl overflow-hidden">
          <div className="p-2 border-b border-gh-border">
            <input
              autoFocus
              className="input text-xs py-1"
              placeholder="Filter members…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {filtered.map((m) => (
            <button
              key={m.id}
              type="button"
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gh-bg text-left"
              onClick={() => { onSelect(m); setOpen(false); setQuery(""); }}
            >
              <div className="w-6 h-6 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                {(m.displayName || m.handle)[0].toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-gh-text truncate">{m.displayName || m.handle}</p>
                <p className="text-xs text-gh-muted">@{m.handle}</p>
              </div>
              {selected === m.handle && <svg className="ml-auto flex-shrink-0" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>}
            </button>
          ))}
          {onClear && selected && (
            <button type="button" className="w-full px-3 py-2 text-xs text-gh-danger hover:bg-gh-bg text-left border-t border-gh-border" onClick={() => { onClear(); setOpen(false); }}>
              Clear assignee
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sidebar assignee picker ───────────────────────────────────────────────────

function AssigneePicker({ token, handle, repoName, issue, canEdit, onUpdate }: {
  token: string; handle: string; repoName: string;
  issue: Issue; canEdit: boolean; onUpdate: (updated: Issue) => void;
}) {
  async function assign(id: string | null) {
    try {
      const updated = await updateIssue(token, handle, repoName, issue.number, { assigneeId: id });
      onUpdate(updated);
    } catch { /* ignore */ }
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2 pb-2 border-b border-gh-border">
        <p className="text-xs font-semibold text-gh-text uppercase tracking-wide">Assignee</p>
      </div>
      {canEdit ? (
        <MemberPicker
          token={token} handle={handle} repoName={repoName}
          selected={issue.assignee}
          onSelect={(m) => assign(m.id)}
          onClear={() => assign(null)}
        />
      ) : issue.assignee ? (
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold">
            {issue.assignee[0]?.toUpperCase()}
          </div>
          <span className="text-xs text-gh-text">{issue.assignee}</span>
        </div>
      ) : (
        <p className="text-xs text-gh-muted">No one assigned</p>
      )}
    </div>
  );
}

// ─── Issue Detail ─────────────────────────────────────────────────────────────

function IssueDetail({ token, handle, repoName, user, number }: {
  token: string; handle: string; repoName: string; user: User; number: number;
}) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;

  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [commentBody, setCommentBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getIssue(token, handle, repoName, number),
      listIssueComments(token, handle, repoName, number),
    ])
      .then(([iss, cmts]) => { setIssue(iss); setComments(cmts.comments); })
      .catch((e) => setError(e instanceof Error ? e.message : "Not found"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, number]);

  async function submitComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setSubmitting(true);
    try {
      const c = await createIssueComment(token, handle, repoName, number, commentBody.trim());
      setComments((prev) => [...prev, c]);
      setCommentBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleState() {
    if (!issue) return;
    setToggling(true);
    try {
      const updated = await updateIssue(token, handle, repoName, number, {
        state: issue.state === "open" ? "closed" : "open",
      });
      setIssue(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-2/3" />
        <div className="h-4 bg-gray-100 rounded w-1/3" />
        <div className="card p-6 space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-4 bg-gray-100 rounded" />)}
        </div>
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="card p-8 text-center">
        <p className="text-gh-danger">{error ?? "Issue not found"}</p>
        <button className="btn-default mt-4" onClick={() => navigate(`${base}/issues`)}>← Back to issues</button>
      </div>
    );
  }

  const isOpen = issue.state === "open";
  const canEdit = issue.author === user.handle || handle === user.handle;

  return (
    <div>
      <Link to={`${base}/issues`} className="inline-flex items-center gap-1.5 text-sm text-gh-muted hover:text-gh-accent mb-4 no-underline">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path fillRule="evenodd" d="M9.78 12.78a.75.75 0 01-1.06 0L4.47 8.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L6.06 8l3.72 3.72a.75.75 0 010 1.06z" />
        </svg>
        Issues
      </Link>

      <div className="flex items-start gap-3 mb-4">
        <h1 className="text-2xl font-semibold text-gh-text flex-1 leading-tight">
          {issue.title}
          <span className="text-gh-muted font-light ml-2">#{issue.number}</span>
        </h1>
      </div>

      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 text-sm font-medium rounded-full text-white"
          style={{ backgroundColor: isOpen ? "#1a7f37" : "#8250df" }}
        >
          {isOpen ? <OpenIcon /> : <ClosedIcon />}
          {isOpen ? "Open" : "Closed"}
        </span>
        <span className="text-sm text-gh-muted">
          <span className="font-semibold text-gh-text">{issue.author}</span>
          {" opened this issue "}
          {timeAgo(issue.createdAt)}
          {" · "}
          {comments.length} comment{comments.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="flex gap-6">
        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-4">
          <div className="card overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2 border-b border-gh-border text-sm" style={{ backgroundColor: "#ddf4ff" }}>
              <div className="w-6 h-6 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold">
                {issue.author[0]?.toUpperCase()}
              </div>
              <span className="font-semibold text-gh-text">{issue.author}</span>
              <span className="text-gh-muted">commented {timeAgo(issue.createdAt)}</span>
            </div>
            <div className="px-6 py-5">
              {issue.body ? (
                <MarkdownRenderer content={issue.body} />
              ) : (
                <p className="text-gh-muted text-sm italic">No description provided.</p>
              )}
            </div>
          </div>

          {comments.map((c) => (
            <div key={c.id} className="card overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-2 border-b border-gh-border bg-gh-bg text-sm">
                <div className="w-6 h-6 rounded-full bg-gray-400 flex items-center justify-center text-white text-xs font-bold">
                  {c.author[0]?.toUpperCase()}
                </div>
                <span className="font-semibold text-gh-text">{c.author}</span>
                <span className="text-gh-muted">commented {timeAgo(c.createdAt)}</span>
              </div>
              <div className="px-6 py-5">
                <MarkdownRenderer content={c.body} />
              </div>
            </div>
          ))}

          {canEdit && (
            <div className="flex items-center gap-3 pt-2">
              <div className="flex-1 h-px bg-gh-border" />
              <button
                className={isOpen ? "btn-danger text-sm" : "btn-default text-sm"}
                onClick={toggleState}
                disabled={toggling}
              >
                {toggling ? "Updating…" : isOpen ? "Close issue" : "Reopen issue"}
              </button>
            </div>
          )}

          <form onSubmit={submitComment} className="card overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2 border-b border-gh-border bg-gh-bg text-sm">
              <div className="w-6 h-6 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold">
                {user.handle[0]?.toUpperCase()}
              </div>
              <span className="font-semibold text-gh-text">{user.handle}</span>
            </div>
            <div className="p-4">
              <textarea
                className="input resize-none h-28 font-mono text-sm"
                placeholder="Leave a comment…"
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
              />
              {error && <p className="text-gh-danger text-sm mt-2">{error}</p>}
              <div className="flex justify-end mt-3">
                <button type="submit" className="btn-primary px-4" disabled={submitting || !commentBody.trim()}>
                  {submitting ? "Posting…" : "Comment"}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Sidebar */}
        <aside className="w-56 flex-shrink-0 hidden lg:block relative text-sm">
          <LabelPicker
            token={token} handle={handle} repoName={repoName}
            issue={issue} canEdit={canEdit} onUpdate={setIssue}
          />
          <AssigneePicker
            token={token} handle={handle} repoName={repoName}
            issue={issue} canEdit={canEdit} onUpdate={setIssue}
          />
        </aside>
      </div>
    </div>
  );
}

// ─── New Issue Modal ──────────────────────────────────────────────────────────

function NewIssueModal({ token, handle, repoName, onCreated, onClose }: {
  token: string; handle: string; repoName: string;
  onCreated: (issue: Issue) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<Label[]>([]);
  const [assignee, setAssignee] = useState<RepoMember | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listLabels(token, handle, repoName).then((d) => setAllLabels(d.labels)).catch(() => {});
  }, [token, handle, repoName]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const issue = await createIssue(
        token, handle, repoName,
        title.trim(),
        body.trim() || undefined,
        selectedLabels.map((l) => l.id),
      );
      onCreated(issue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleLabel(lbl: Label) {
    setSelectedLabels((prev) =>
      prev.some((l) => l.id === lbl.id) ? prev.filter((l) => l.id !== lbl.id) : [...prev, lbl],
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 px-4 pt-16" onClick={onClose}>
      <div className="bg-gh-canvas border border-gh-border rounded-xl w-full max-w-2xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gh-border">
          <h2 className="text-base font-semibold">New issue</h2>
          <button className="text-gh-muted hover:text-gh-text bg-transparent border-none cursor-pointer p-1 rounded" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
            </svg>
          </button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 flex flex-col gap-4">
          <div>
            <label className="label" htmlFor="issue-title">Title <span className="text-gh-danger">*</span></label>
            <input id="issue-title" className="input" placeholder="Issue title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
          </div>
          <div>
            <label className="label" htmlFor="issue-body">Description</label>
            <textarea id="issue-body" className="input resize-none font-mono" placeholder="Leave a comment (supports Markdown)" value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
          </div>

          {allLabels.length > 0 && (
            <div>
              <label className="label">Labels</label>
              <div className="flex flex-wrap gap-1.5">
                {allLabels.map((lbl) => {
                  const active = selectedLabels.some((l) => l.id === lbl.id);
                  return (
                    <button
                      key={lbl.id}
                      type="button"
                      onClick={() => toggleLabel(lbl)}
                      className={`transition-opacity ${active ? "opacity-100 ring-2 ring-offset-1" : "opacity-60 hover:opacity-100"}`}
                      style={{ ["--tw-ring-color" as string]: `#${lbl.color}` }}
                    >
                      <LabelChip label={lbl} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label className="label">Assignee</label>
            <div className="flex items-center gap-2">
              <MemberPicker
                token={token} handle={handle} repoName={repoName}
                selected={assignee?.handle ?? null}
                onSelect={setAssignee}
                onClear={() => setAssignee(null)}
                placeholder="No assignee"
              />
              {assignee && (
                <button type="button" className="text-xs text-gh-muted hover:text-gh-danger" onClick={() => setAssignee(null)}>×</button>
              )}
            </div>
          </div>

          {error && <p className="text-gh-danger text-sm bg-gh-danger-muted rounded-md px-3 py-2">{error}</p>}
          <div className="flex justify-end gap-2 pt-2 border-t border-gh-border">
            <button type="button" className="btn-default" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary px-4" disabled={submitting || !title.trim()}>
              {submitting ? "Submitting…" : "Submit new issue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Issues List ──────────────────────────────────────────────────────────────

type FilterDropdownProps = {
  label: string;
  active: boolean;
  children: React.ReactNode;
};

function FilterDropdown({ label, active, children }: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOut);
    return () => document.removeEventListener("mousedown", onOut);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={`flex items-center gap-1 text-sm px-3 py-1.5 hover:text-gh-text transition-colors ${active ? "text-gh-text font-semibold" : "text-gh-muted"}`}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+2px)] z-50 min-w-[180px] bg-gh-canvas border border-gh-border rounded-lg shadow-xl overflow-hidden" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

function IssuesList({ token, handle, repoName, user }: Omit<Props, "splat">) {
  const navigate = useNavigate();
  const base = `/${handle}/${repoName}`;
  const [stateFilter, setStateFilter] = useState<"open" | "closed">("open");
  const [labelFilter, setLabelFilter] = useState<{ id: string; name: string } | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [members, setMembers] = useState<RepoMember[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    listLabels(token, handle, repoName).then((d) => setAllLabels(d.labels)).catch(() => {});
    listRepoMembers(token, handle, repoName).then((d) => setMembers(d.members)).catch(() => {});
  }, [token, handle, repoName]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    listIssues(token, handle, repoName, stateFilter, labelFilter?.name, assigneeFilter ?? undefined, authorFilter ?? undefined, sort)
      .then((d) => setIssues(d.issues))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, stateFilter, labelFilter, assigneeFilter, authorFilter, sort]);

  const hasFilter = !!(labelFilter || assigneeFilter || authorFilter);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1">
          {(["open", "closed"] as const).map((s) => (
            <button
              key={s}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${stateFilter === s ? "font-semibold text-gh-text" : "text-gh-muted hover:text-gh-text"}`}
              onClick={() => setStateFilter(s)}
            >
              {s === "open"
                ? <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-gh-success"><path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" /><path fillRule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" /></svg>
                : <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-purple-600"><path d="M11.28 6.78a.75.75 0 00-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 00-1.06 1.06l2 2a.75.75 0 001.06 0l3.5-3.5z" /><path fillRule="evenodd" d="M16 8A8 8 0 110 8a8 8 0 0116 0zm-1.5 0a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" /></svg>
              }
              {s === "open" ? "Open" : "Closed"}
            </button>
          ))}
        </div>
        <button className="btn-primary px-3 text-sm" onClick={() => setShowNew(true)}>New issue</button>
      </div>

      {/* Filter bar + issue list as one connected block */}
      <div className="flex items-center justify-between bg-gh-bg border border-gh-border rounded-t-md px-3 py-1.5 -mt-px">
        <div className="flex items-center gap-0.5">
          {/* Author */}
          <FilterDropdown label={authorFilter ? `Author: ${authorFilter}` : "Author"} active={!!authorFilter}>
            <p className="text-xs font-semibold text-gh-text px-3 pt-2 pb-1">Filter by author</p>
            {authorFilter && (
              <button className="w-full text-left px-3 py-1.5 text-sm hover:bg-gh-bg text-gh-muted" onClick={() => setAuthorFilter(null)}>
                All authors
              </button>
            )}
            {members.map((m) => (
              <button key={m.id} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gh-bg" onClick={() => setAuthorFilter(m.handle)}>
                <div className="w-5 h-5 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                  {(m.displayName || m.handle)[0].toUpperCase()}
                </div>
                <span className="truncate">{m.handle}</span>
                {authorFilter === m.handle && <svg className="ml-auto flex-shrink-0" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>}
              </button>
            ))}
          </FilterDropdown>

          {/* Labels */}
          <FilterDropdown label={labelFilter ? `Label: ${labelFilter.name}` : "Label"} active={!!labelFilter}>
            <p className="text-xs font-semibold text-gh-text px-3 pt-2 pb-1">Filter by label</p>
            {labelFilter && (
              <button className="w-full text-left px-3 py-1.5 text-sm hover:bg-gh-bg text-gh-muted" onClick={() => setLabelFilter(null)}>
                All labels
              </button>
            )}
            {allLabels.length === 0 && <p className="px-3 py-2 text-sm text-gh-muted">No labels yet</p>}
            {allLabels.map((lbl) => (
              <button key={lbl.id} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gh-bg" onClick={() => setLabelFilter({ id: lbl.id, name: lbl.name })}>
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: `#${lbl.color}` }} />
                <span className="truncate">{lbl.name}</span>
                {labelFilter?.id === lbl.id && <svg className="ml-auto flex-shrink-0" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>}
              </button>
            ))}
          </FilterDropdown>

          {/* Assignees */}
          <FilterDropdown label={assigneeFilter ? `Assignee: ${assigneeFilter}` : "Assignee"} active={!!assigneeFilter}>
            <p className="text-xs font-semibold text-gh-text px-3 pt-2 pb-1">Filter by assignee</p>
            {assigneeFilter && (
              <button className="w-full text-left px-3 py-1.5 text-sm hover:bg-gh-bg text-gh-muted" onClick={() => setAssigneeFilter(null)}>
                All assignees
              </button>
            )}
            {members.map((m) => (
              <button key={m.id} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gh-bg" onClick={() => setAssigneeFilter(m.handle)}>
                <div className="w-5 h-5 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                  {(m.displayName || m.handle)[0].toUpperCase()}
                </div>
                <span className="truncate">{m.handle}</span>
                {assigneeFilter === m.handle && <svg className="ml-auto flex-shrink-0" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>}
              </button>
            ))}
          </FilterDropdown>
        </div>

        {/* Sort */}
        <FilterDropdown label={sort === "newest" ? "Newest" : "Oldest"} active={sort === "oldest"}>
          <button className="w-full text-left px-3 py-1.5 text-sm hover:bg-gh-bg flex items-center justify-between" onClick={() => setSort("newest")}>
            Newest {sort === "newest" && <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>}
          </button>
          <button className="w-full text-left px-3 py-1.5 text-sm hover:bg-gh-bg flex items-center justify-between" onClick={() => setSort("oldest")}>
            Oldest {sort === "oldest" && <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>}
          </button>
        </FilterDropdown>
      </div>

      <div className="card overflow-hidden rounded-t-none border-t-0">
        {loading ? (
          <div className="divide-y divide-gh-border">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-start gap-3 p-4 animate-pulse">
                <div className="w-4 h-4 bg-gray-200 rounded-full mt-0.5" />
                <div className="flex-1 space-y-2"><div className="h-4 bg-gray-200 rounded w-2/3" /><div className="h-3 bg-gray-100 rounded w-1/3" /></div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-8 text-center text-gh-danger">{error}</div>
        ) : issues.length === 0 ? (
          <div className="p-16 text-center">
            <p className="text-lg font-semibold text-gh-text">{hasFilter ? "No results match your filters" : stateFilter === "open" ? "No open issues" : "No closed issues"}</p>
            {stateFilter === "open" && !hasFilter && (
              <p className="text-gh-muted text-sm mt-1">Open a new issue to start tracking work.</p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-gh-border">
            {issues.map((issue) => (
              <button
                key={issue.id}
                className="w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-gh-bg transition-colors"
                onClick={() => navigate(`${base}/issues/${issue.number}`)}
              >
                <span className="mt-0.5 flex-shrink-0">{issue.state === "open" ? <OpenIcon /> : <ClosedIcon />}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gh-text">
                    {issue.title}
                    {issue.labels.map((lbl) => (
                      <span key={lbl.id} className="ml-1.5 inline-flex items-center px-1.5 py-0.5 text-xs rounded-full font-medium" style={{ backgroundColor: `#${lbl.color}22`, color: `#${lbl.color}`, border: `1px solid #${lbl.color}44` }}>
                        {lbl.name}
                      </span>
                    ))}
                  </p>
                  <p className="text-xs text-gh-muted mt-0.5">
                    #{issue.number} {stateFilter === "open" ? "opened" : "closed"} {timeAgo(issue.createdAt)} by {issue.author}
                    {issue.assignee && ` · ${issue.assignee}`}
                  </p>
                </div>
                {issue.commentCount > 0 && (
                  <div className="flex items-center gap-1 text-xs text-gh-muted flex-shrink-0 mt-0.5">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z" /></svg>
                    {issue.commentCount}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <NewIssueModal token={token} handle={handle} repoName={repoName}
          onCreated={(issue) => { setShowNew(false); setIssues((p) => [issue, ...p]); }}
          onClose={() => setShowNew(false)}
        />
      )}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function RepoIssuesTab({ token, handle, repoName, user, splat }: Props) {
  const match = splat.match(/^issues\/(\d+)$/);
  if (match) {
    return <IssueDetail token={token} handle={handle} repoName={repoName} user={user} number={Number(match[1])} />;
  }
  return <IssuesList token={token} handle={handle} repoName={repoName} user={user} />;
}
