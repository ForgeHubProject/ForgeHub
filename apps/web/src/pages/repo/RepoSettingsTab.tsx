import { useEffect, useRef, useState } from "react";
import {
  addCollaborator, Collaborator, createLabel, deleteLabel,
  listCollaborators, listLabels, removeCollaborator, search, updateLabel,
} from "../../api";
import type { Label, SearchUserResult, User } from "../../types";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
};

// ─── Predefined label colors (GitHub palette) ─────────────────────────────────

const PRESET_COLORS = [
  "d73a4a", "0075ca", "cfd3d7", "e4e669", "a2eeef",
  "7057ff", "008672", "e11d48", "fb923c", "84cc16",
  "06b6d4", "8b5cf6",
];

function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r, g, b };
}

function labelTextColor(bgHex: string): string {
  const { r, g, b } = hexToRgb(bgHex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#1f2328" : "#ffffff";
}

// ─── Labels ───────────────────────────────────────────────────────────────────

function LabelForm({ initial, onSave, onCancel }: {
  initial?: Label;
  onSave: (name: string, color: string, desc: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? PRESET_COLORS[0]);
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || color.length !== 6) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(name.trim(), color, desc.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setSaving(false);
    }
  }

  const preview = { backgroundColor: `#${color}`, color: labelTextColor(color) };

  return (
    <form onSubmit={submit} className="card p-4 space-y-3">
      <div className="flex items-start gap-3 flex-wrap">
        {/* Preview */}
        <div className="flex-shrink-0 mt-5">
          <span className="badge font-medium text-xs px-3 py-1" style={preview}>
            {name || "Label preview"}
          </span>
        </div>

        {/* Name */}
        <div className="flex-1 min-w-[140px]">
          <label className="label text-xs">Label name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="bug, enhancement…" required />
        </div>

        {/* Description */}
        <div className="flex-1 min-w-[160px]">
          <label className="label text-xs">Description</label>
          <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Optional" />
        </div>

        {/* Color */}
        <div className="min-w-[120px]">
          <label className="label text-xs">Color</label>
          <div className="flex items-center gap-2">
            <input
              className="input w-28 font-mono text-sm"
              value={color}
              onChange={(e) => setColor(e.target.value.replace("#", "").slice(0, 6))}
              maxLength={6}
              placeholder="d73a4a"
            />
            <button
              type="button"
              className="w-7 h-7 rounded border border-gh-border flex-shrink-0"
              style={{ backgroundColor: `#${color}` }}
              title="Pick color"
            />
          </div>
          <div className="flex gap-1 mt-1 flex-wrap">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="w-5 h-5 rounded-sm border-2 transition-transform hover:scale-110"
                style={{ backgroundColor: `#${c}`, borderColor: color === c ? "#0969da" : "transparent" }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
      </div>

      {error && <p className="text-gh-danger text-sm">{error}</p>}

      <div className="flex justify-end gap-2 pt-1 border-t border-gh-border">
        <button type="button" className="btn-default text-sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary text-sm px-4" disabled={saving || !name.trim() || color.length !== 6}>
          {saving ? "Saving…" : initial ? "Save changes" : "Create label"}
        </button>
      </div>
    </form>
  );
}

function LabelsSection({ token, handle, repoName }: { token: string; handle: string; repoName: string }) {
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listLabels(token, handle, repoName)
      .then((d) => setLabels(d.labels))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, handle, repoName]);

  async function handleCreate(name: string, color: string, description: string) {
    const lbl = await createLabel(token, handle, repoName, name, color, description || undefined);
    setLabels((prev) => [...prev, lbl]);
    setShowNew(false);
  }

  async function handleUpdate(id: string, name: string, color: string, description: string) {
    const lbl = await updateLabel(token, handle, repoName, id, { name, color, description: description || undefined });
    setLabels((prev) => prev.map((l) => l.id === id ? lbl : l));
    setEditing(null);
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this label? It will be removed from all issues.")) return;
    await deleteLabel(token, handle, repoName, id);
    setLabels((prev) => prev.filter((l) => l.id !== id));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-gh-text">Labels</h2>
          <p className="text-sm text-gh-muted mt-0.5">Organize and categorize issues with labels.</p>
        </div>
        <button className="btn-primary text-sm" onClick={() => setShowNew(true)}>New label</button>
      </div>

      {showNew && (
        <div className="mb-4">
          <LabelForm onSave={handleCreate} onCancel={() => setShowNew(false)} />
        </div>
      )}

      {loading ? (
        <div className="card divide-y divide-gh-border animate-pulse">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className="w-20 h-6 bg-gray-200 rounded-full" />
              <div className="flex-1 h-4 bg-gray-100 rounded" />
            </div>
          ))}
        </div>
      ) : labels.length === 0 && !showNew ? (
        <div className="card p-12 text-center text-gh-muted text-sm">
          No labels yet. Create your first label to organize issues.
        </div>
      ) : (
        <div className="card divide-y divide-gh-border overflow-hidden">
          {labels.map((label) => (
            <div key={label.id}>
              <div className="flex items-center gap-3 px-4 py-3 hover:bg-gh-bg">
                <span
                  className="badge font-medium text-xs px-2.5 py-1 min-w-[64px] justify-center"
                  style={{ backgroundColor: `#${label.color}`, color: labelTextColor(label.color), borderColor: "transparent" }}
                >
                  {label.name}
                </span>
                <span className="text-sm text-gh-muted flex-1 min-w-0 truncate">
                  {label.description ?? <span className="italic text-gh-muted opacity-60">No description</span>}
                </span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    className="text-xs text-gh-muted hover:text-gh-accent px-2 py-1 rounded-md hover:bg-gh-bg border border-transparent hover:border-gh-border transition-colors"
                    onClick={() => setEditing(label.id)}
                  >
                    Edit
                  </button>
                  <button
                    className="text-xs text-gh-danger hover:text-white hover:bg-gh-danger px-2 py-1 rounded-md border border-transparent hover:border-gh-danger transition-colors"
                    onClick={() => void handleDelete(label.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {editing === label.id && (
                <div className="px-4 pb-4">
                  <LabelForm
                    initial={label}
                    onSave={(name, color, desc) => handleUpdate(label.id, name, color, desc)}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Collaborators ────────────────────────────────────────────────────────────

function UserSearchInput({ token, onSelect }: {
  token: string;
  onSelect: (user: SearchUserResult) => void;
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

    if (val.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    timerRef.current = setTimeout(() => {
      setSearching(true);
      search(token, val.trim(), "users")
        .then((d) => {
          setResults(d.results as SearchUserResult[]);
          setOpen(true);
        })
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 300);
  }

  function pick(user: SearchUserResult) {
    setQuery("");
    setResults([]);
    setOpen(false);
    onSelect(user);
  }

  return (
    <div ref={containerRef} className="relative flex-1 min-w-[200px]">
      <div className="relative">
        <svg
          width="14" height="14" viewBox="0 0 16 16" fill="currentColor"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gh-muted pointer-events-none"
        >
          <path fillRule="evenodd" d="M11.5 7a4.499 4.499 0 11-8.998 0A4.499 4.499 0 0111.5 7zm-.82 4.74a6 6 0 111.06-1.06l3.04 3.04a.75.75 0 11-1.06 1.06L10.68 11.74z" />
        </svg>
        <input
          className="input pl-8 w-full"
          placeholder="Search by username or name…"
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
            <button
              key={u.id}
              type="button"
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gh-bg text-left transition-colors"
              onClick={() => pick(u)}
            >
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

function CollaboratorsSection({ token, repoName }: { token: string; repoName: string }) {
  const [collabs, setCollabs] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SearchUserResult | null>(null);
  const [role, setRole] = useState<"reader" | "writer" | "admin">("writer");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCollaborators(token, repoName)
      .then((d) => setCollabs(d.collaborators))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token, repoName]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setAdding(true);
    setError(null);
    try {
      const c = await addCollaborator(token, repoName, selected.handle, role);
      setCollabs((prev) => {
        const exists = prev.findIndex((x) => x.user.handle === c.user.handle);
        if (exists >= 0) {
          const next = [...prev];
          next[exists] = c;
          return next;
        }
        return [...prev, c];
      });
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add collaborator");
    } finally {
      setAdding(false);
    }
  }

  async function remove(collab: Collaborator) {
    if (!confirm(`Remove @${collab.user.handle} as a collaborator?`)) return;
    await removeCollaborator(token, repoName, collab.user.handle);
    setCollabs((prev) => prev.filter((c) => c.id !== collab.id));
  }

  const roleColors: Record<string, string> = {
    reader: "bg-blue-50 text-blue-700 border-blue-200",
    writer: "bg-green-50 text-green-700 border-green-200",
    admin: "bg-purple-50 text-purple-700 border-purple-200",
  };

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-base font-semibold text-gh-text">Collaborators</h2>
        <p className="text-sm text-gh-muted mt-0.5">Manage who has access to this repository.</p>
      </div>

      {/* Add collaborator */}
      <form onSubmit={add} className="card p-4 mb-4">
        <p className="text-sm font-semibold text-gh-text mb-3">Add a collaborator</p>

        {selected ? (
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {/* Selected user chip */}
            <div className="flex items-center gap-2 bg-gh-bg border border-gh-border rounded-full pl-1 pr-3 py-1">
              <div className="w-6 h-6 rounded-full bg-gh-accent flex items-center justify-center text-white text-xs font-bold">
                {(selected.displayName || selected.handle)[0].toUpperCase()}
              </div>
              <span className="text-sm font-medium text-gh-text">{selected.displayName || selected.handle}</span>
              <span className="text-xs text-gh-muted">@{selected.handle}</span>
              <button
                type="button"
                className="ml-1 text-gh-muted hover:text-gh-danger transition-colors"
                onClick={() => setSelected(null)}
                title="Clear selection"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path fillRule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </svg>
              </button>
            </div>

            <select
              className="input w-28"
              value={role}
              onChange={(e) => setRole(e.target.value as "reader" | "writer" | "admin")}
            >
              <option value="reader">Reader</option>
              <option value="writer">Writer</option>
              <option value="admin">Admin</option>
            </select>

            <button type="submit" className="btn-primary px-4" disabled={adding}>
              {adding ? "Adding…" : "Add collaborator"}
            </button>
          </div>
        ) : (
          <UserSearchInput token={token} onSelect={setSelected} />
        )}

        {error && <p className="text-gh-danger text-sm mt-2">{error}</p>}
        <p className="text-xs text-gh-muted mt-2">
          <strong>Reader</strong> — view · <strong>Writer</strong> — push, create issues/PRs · <strong>Admin</strong> — manage settings
        </p>
      </form>

      {/* Collaborator list */}
      {loading ? (
        <div className="card animate-pulse divide-y divide-gh-border">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className="w-8 h-8 bg-gray-200 rounded-full" />
              <div className="flex-1 h-4 bg-gray-100 rounded w-40" />
            </div>
          ))}
        </div>
      ) : collabs.length === 0 ? (
        <div className="card p-8 text-center text-sm text-gh-muted">No collaborators yet.</div>
      ) : (
        <div className="card divide-y divide-gh-border overflow-hidden">
          {collabs.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gh-bg">
              <div className="w-8 h-8 rounded-full bg-gh-accent flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                {c.user.handle[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gh-text">{c.user.displayName || c.user.handle}</p>
                <p className="text-xs text-gh-muted">@{c.user.handle}</p>
              </div>
              <span className={`badge text-xs ${roleColors[c.role] ?? ""}`}>{c.role}</span>
              <button
                className="text-xs text-gh-danger hover:text-white hover:bg-gh-danger px-2 py-1 rounded-md border border-transparent hover:border-gh-danger transition-colors ml-2"
                onClick={() => void remove(c)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function RepoSettingsTab({ token, handle, repoName, user }: Props) {
  const isOwner = user.handle === handle;
  const [section, setSection] = useState<"labels" | "collaborators">("labels");

  const sections = [
    { key: "labels" as const, label: "Labels" },
    ...(isOwner ? [{ key: "collaborators" as const, label: "Collaborators" }] : []),
  ];

  return (
    <div className="flex gap-6">
      {/* Sidebar nav */}
      <nav className="w-44 flex-shrink-0">
        <ul className="space-y-0.5">
          {sections.map((s) => (
            <li key={s.key}>
              <button
                className={`w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors ${
                  section === s.key
                    ? "font-semibold text-gh-text bg-gh-bg"
                    : "text-gh-muted hover:text-gh-text hover:bg-gh-bg"
                }`}
                onClick={() => setSection(s.key)}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {section === "labels" && (
          <LabelsSection token={token} handle={handle} repoName={repoName} />
        )}
        {section === "collaborators" && isOwner && (
          <CollaboratorsSection token={token} repoName={repoName} />
        )}
      </div>
    </div>
  );
}
