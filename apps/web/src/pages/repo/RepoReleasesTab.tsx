import { useEffect, useMemo, useState } from "react";
import { createRelease, deleteRelease, listReleases } from "../../api";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import type { Release, User } from "../../types";
import {
  Avatar, Badge, Button, ConfirmDialog, DropdownMenu, DropdownItem,
  EmptyState, Field, Skeleton, TextInput, Textarea, RelativeTime, useToast,
} from "../../ui";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  user: User;
};

// ── local Octicon-style marks (functional, currentColor) ──────────────────────

function TagIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z" />
    </svg>
  );
}

function CommitIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M10.5 7.75a2.5 2.5 0 00-4.9-.75H1.75a.75.75 0 000 1.5h3.85a2.5 2.5 0 004.9-.75zm-2.5 1a1 1 0 110-2 1 1 0 010 2zm2.4-1.75h3.85a.75.75 0 010 1.5H10.4a.75.75 0 010-1.5z" />
    </svg>
  );
}

function KebabIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM1.5 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3zm13 0a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
    </svg>
  );
}

// ── create-release form ───────────────────────────────────────────────────────

function CreateReleaseForm({
  onCreate, onCancel,
}: {
  onCreate: (v: {
    tagName: string; target: string; name: string; body: string;
    isDraft: boolean; isPrerelease: boolean;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [tagName, setTagName] = useState("");
  const [target, setTarget] = useState("main");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [isDraft, setIsDraft] = useState(false);
  const [isPrerelease, setIsPrerelease] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!tagName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate({ tagName: tagName.trim(), target: target.trim() || "main", name: name.trim(), body, isDraft, isPrerelease });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create release");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-fh-surface border border-fh-border rounded-md p-4 space-y-4">
      <div className="flex items-center gap-2">
        <TagIcon />
        <h3 className="text-fh-base font-semibold text-fh-fg">Draft a new release</h3>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tag name" required hint="e.g. v1.2.0 — created from the target if it doesn't exist.">
          {(id) => (
            <TextInput id={id} value={tagName} onChange={(e) => setTagName(e.target.value)}
              placeholder="v1.0.0" className="font-mono" autoFocus />
          )}
        </Field>
        <Field label="Target" hint="Branch or commit the tag points at.">
          {(id) => (
            <TextInput id={id} value={target} onChange={(e) => setTarget(e.target.value)}
              placeholder="main" className="font-mono" />
          )}
        </Field>
      </div>

      <Field label="Release title" hint="Defaults to the tag name when left blank.">
        {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="v1.0.0 — First stable release" />}
      </Field>

      <Field label="Release notes" hint="Markdown supported.">
        {(id) => (
          <Textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} rows={6}
            placeholder="Describe what changed in this release…" className="font-mono text-fh-sm" />
        )}
      </Field>

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-fh-base text-fh-fg cursor-pointer select-none">
          <input type="checkbox" className="h-4 w-4 accent-fh-accent-emphasis rounded"
            checked={isPrerelease} onChange={(e) => setIsPrerelease(e.target.checked)} />
          Set as a pre-release
          <span className="text-fh-sm text-fh-fg-muted">— not production ready.</span>
        </label>
        <label className="flex items-center gap-2 text-fh-base text-fh-fg cursor-pointer select-none">
          <input type="checkbox" className="h-4 w-4 accent-fh-accent-emphasis rounded"
            checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} />
          Save as draft
          <span className="text-fh-sm text-fh-fg-muted">— hidden until you publish.</span>
        </label>
      </div>

      {error && <p className="text-fh-sm text-fh-danger-fg">{error}</p>}

      <div className="flex justify-end gap-2 pt-1 border-t border-fh-border">
        <Button variant="default" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" loading={saving} disabled={!tagName.trim()}>
          {isDraft ? "Save draft" : "Publish release"}
        </Button>
      </div>
    </form>
  );
}

// ── one release row on the timeline rail ──────────────────────────────────────

function ReleaseRow({
  release, isLatest, canManage, onDelete,
}: {
  release: Release;
  isLatest: boolean;
  canManage: boolean;
  onDelete: (r: Release) => void;
}) {
  const title = release.name || release.tagName;
  const badges = (
    <>
      {isLatest && <Badge tone="success">Latest</Badge>}
      {release.isPrerelease && <Badge tone="warning">Pre-release</Badge>}
      {release.isDraft && <Badge tone="neutral">Draft</Badge>}
    </>
  );

  return (
    <div className="flex gap-4 md:gap-6">
      {/* Timeline meta rail — desktop only */}
      <div className="hidden md:flex w-40 shrink-0 flex-col items-end gap-2 pt-1 text-right">
        <span className="inline-flex items-center gap-1.5 text-fh-sm font-mono font-medium text-fh-accent-fg">
          <TagIcon size={14} />
          <span className="truncate">{release.tagName}</span>
        </span>
        <RelativeTime date={release.createdAt} className="text-fh-xs text-fh-fg-subtle" />
        <span className="inline-flex items-center gap-1.5 text-fh-xs text-fh-fg-subtle">
          <Avatar name={release.author} size={16} />
          <span className="truncate">{release.author}</span>
        </span>
      </div>

      {/* Node + card */}
      <div className="relative flex-1 min-w-0 border-l border-fh-border pl-5 md:pl-6 pb-8">
        <span
          className="absolute -left-[6px] top-2 w-[11px] h-[11px] rounded-full bg-fh-accent-emphasis ring-4 ring-fh-canvas"
          aria-hidden="true"
        />
        <div className="bg-fh-surface border border-fh-border rounded-md">
          <div className="flex items-start justify-between gap-3 px-4 pt-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1.5">{badges}</div>
              <h3 className="text-fh-xl font-semibold text-fh-fg leading-tight break-words">{title}</h3>
              {/* Compact meta — mobile only */}
              <div className="md:hidden mt-2 flex items-center gap-2 flex-wrap text-fh-sm text-fh-fg-muted">
                <span className="inline-flex items-center gap-1 font-mono text-fh-accent-fg">
                  <TagIcon size={13} />{release.tagName}
                </span>
                <span aria-hidden>·</span>
                <RelativeTime date={release.createdAt} className="text-fh-fg-subtle" />
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1 text-fh-fg-subtle">
                  <Avatar name={release.author} size={14} />{release.author}
                </span>
              </div>
            </div>
            {canManage && (
              <DropdownMenu
                trigger={
                  <Button variant="invisible" size="sm" aria-label="Release actions" className="text-fh-fg-muted">
                    <KebabIcon />
                  </Button>
                }
              >
                <DropdownItem danger onSelect={() => onDelete(release)}>Delete release</DropdownItem>
              </DropdownMenu>
            )}
          </div>

          {release.body ? (
            <div className="mt-3 px-4 pb-4 border-t border-fh-border pt-4">
              <MarkdownRenderer content={release.body} />
            </div>
          ) : (
            <div className="mt-3 px-4 pb-4 border-t border-fh-border pt-4">
              <p className="text-fh-sm text-fh-fg-subtle italic">No release notes.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function RepoReleasesTab({ token, handle, repoName, user }: Props) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Release | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();

  const canManage = user.handle === handle;

  function load() {
    setLoading(true);
    listReleases(token, handle, repoName)
      .then((d) => setReleases(d.releases))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load releases"))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, handle, repoName]);

  // Newest first; the newest published (non-draft, non-prerelease) is "Latest".
  const sorted = useMemo(
    () => [...releases].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [releases],
  );
  const latestId = useMemo(
    () => sorted.find((r) => !r.isDraft && !r.isPrerelease)?.id ?? null,
    [sorted],
  );

  async function handleCreate(v: {
    tagName: string; target: string; name: string; body: string; isDraft: boolean; isPrerelease: boolean;
  }) {
    await createRelease(token, handle, repoName, v.tagName, v.name || v.tagName, v.body || undefined, v.isDraft, v.isPrerelease, v.target);
    setShowCreate(false);
    toast(v.isDraft ? "Draft saved" : `Released ${v.tagName}`, { tone: "success" });
    load();
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteRelease(token, handle, repoName, pendingDelete.tagName);
      setReleases((prev) => prev.filter((r) => r.id !== pendingDelete.id));
      toast(`Deleted ${pendingDelete.tagName}`, { tone: "success" });
      setPendingDelete(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete release", { tone: "danger" });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-6">
        <h2 className="flex items-center gap-2 text-fh-lg font-semibold text-fh-fg">
          Releases
          {!loading && releases.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full text-fh-xs font-semibold bg-fh-neutral-muted text-fh-fg-muted">
              {releases.length}
            </span>
          )}
        </h2>
        {canManage && !showCreate && (
          <Button variant="primary" leadingIcon={<TagIcon size={14} />} onClick={() => setShowCreate(true)}>
            Draft a new release
          </Button>
        )}
      </div>

      {showCreate && (
        <div className="mb-6">
          <CreateReleaseForm onCreate={handleCreate} onCancel={() => setShowCreate(false)} />
        </div>
      )}

      {loading ? (
        <div className="space-y-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-6">
              <div className="hidden md:flex w-40 shrink-0 flex-col items-end gap-2 pt-1">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3 w-16" />
              </div>
              <div className="flex-1 border-l border-fh-border pl-6 pb-2">
                <div className="bg-fh-surface border border-fh-border rounded-md p-4 space-y-3">
                  <Skeleton className="h-6 w-1/2" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-1/3" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="bg-fh-surface border border-fh-border rounded-md px-6 py-12 text-center text-fh-danger-fg text-fh-base">
          {error}
        </div>
      ) : releases.length === 0 ? (
        <div className="bg-fh-surface border border-fh-border rounded-md">
          <EmptyState
            icon={<TagIcon size={32} />}
            title="No releases published"
            description="Releases bundle a tag with notes and downloadable software so people can adopt a specific version of this repository."
            actions={canManage ? (
              <Button variant="primary" leadingIcon={<TagIcon size={14} />} onClick={() => setShowCreate(true)}>
                Create a new release
              </Button>
            ) : undefined}
          />
        </div>
      ) : (
        <div>
          {sorted.map((release) => (
            <ReleaseRow
              key={release.id}
              release={release}
              isLatest={release.id === latestId}
              canManage={canManage}
              onDelete={setPendingDelete}
            />
          ))}
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete release"
          message={<>Delete the release <span className="font-mono font-semibold">{pendingDelete.tagName}</span>? The underlying git tag is kept.</>}
          confirmLabel="Delete release"
          loading={deleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
