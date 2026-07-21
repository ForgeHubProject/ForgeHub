import { useEffect, useMemo, useRef, useState } from "react";
import {
  createRelease, deleteRelease, listReleases,
  uploadReleaseAsset, deleteReleaseAsset, downloadReleaseAsset, generateReleaseNotes,
} from "../../api";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import type { Release, ReleaseAsset, User } from "../../types";
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

// ── helpers ────────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// ── local Octicon-style marks (functional, currentColor) ──────────────────────

function TagIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M2.5 7.775V2.75a.25.25 0 01.25-.25h5.025a.25.25 0 01.177.073l6.25 6.25a.25.25 0 010 .354l-5.025 5.025a.25.25 0 01-.354 0l-6.25-6.25a.25.25 0 01-.073-.177zm-1.5 0V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 010 2.474l-5.026 5.026a1.75 1.75 0 01-2.474 0l-6.25-6.25A1.75 1.75 0 011 7.775zM6 5a1 1 0 100 2 1 1 0 000-2z" />
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

function DownloadIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2.75 14A1.75 1.75 0 011 12.25v-2.5a.75.75 0 011.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25v-2.5a.75.75 0 011.5 0v2.5A1.75 1.75 0 0113.25 14H2.75z" />
      <path d="M7.25 7.689V2a.75.75 0 011.5 0v5.689l1.97-1.969a.749.749 0 111.06 1.06l-3.25 3.25a.749.749 0 01-1.06 0L4.22 6.78a.749.749 0 111.06-1.06l1.97 1.969z" />
    </svg>
  );
}

function UploadIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2.75 14A1.75 1.75 0 011 12.25v-2.5a.75.75 0 011.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25v-2.5a.75.75 0 011.5 0v2.5A1.75 1.75 0 0113.25 14H2.75z" />
      <path d="M8.75 8.311V14a.75.75 0 01-1.5 0V8.311L5.28 10.28a.749.749 0 11-1.06-1.06l3.25-3.25a.749.749 0 011.06 0l3.25 3.25a.749.749 0 11-1.06 1.06L8.75 8.311z" />
    </svg>
  );
}

function FileIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 16h-8.5A1.75 1.75 0 012 14.25V1.75z" />
    </svg>
  );
}

function TrashIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675l.66 6.6a.25.25 0 00.249.225h5.19a.25.25 0 00.249-.225l.66-6.6a.75.75 0 011.492.149l-.66 6.6A1.75 1.75 0 0110.595 15h-5.19a1.75 1.75 0 01-1.741-1.575l-.66-6.6a.75.75 0 111.492-.15zM6.5 1.75V3h3V1.75a.25.25 0 00-.25-.25h-2.5a.25.25 0 00-.25.25z" />
    </svg>
  );
}

function SparkleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M7.53.146a.5.5 0 01.94 0l1.2 3.234 3.234 1.2a.5.5 0 010 .94l-3.234 1.2-1.2 3.234a.5.5 0 01-.94 0l-1.2-3.234-3.234-1.2a.5.5 0 010-.94l3.234-1.2 1.2-3.234zM3.5 10.5a.4.4 0 01.75 0l.55 1.45 1.45.55a.4.4 0 010 .75l-1.45.55-.55 1.45a.4.4 0 01-.75 0l-.55-1.45-1.45-.55a.4.4 0 010-.75l1.45-.55.55-1.45z" />
    </svg>
  );
}

// ── one asset row inside a release card ───────────────────────────────────────

function AssetRow({
  releaseId, asset, token, handle, repoName, canManage, onDelete,
}: {
  releaseId: string;
  asset: ReleaseAsset;
  token: string;
  handle: string;
  repoName: string;
  canManage: boolean;
  onDelete: (a: ReleaseAsset) => void;
}) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      await downloadReleaseAsset(token || null, handle, repoName, releaseId, asset);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Download failed", { tone: "danger" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <button
        type="button"
        onClick={() => void download()}
        disabled={downloading}
        className="group flex items-center gap-2 min-w-0 text-left"
      >
        <span className="text-fh-fg-subtle group-hover:text-fh-accent-fg">
          <FileIcon size={16} />
        </span>
        <span className="truncate font-mono text-fh-sm text-fh-accent-fg group-hover:underline">
          {asset.name}
        </span>
      </button>
      <div className="flex items-center gap-3 shrink-0 text-fh-xs text-fh-fg-subtle">
        <span className="tabular-nums">{formatBytes(asset.size)}</span>
        <span className="hidden sm:inline tabular-nums">
          {asset.downloadCount} {asset.downloadCount === 1 ? "download" : "downloads"}
        </span>
        <Button
          variant="invisible"
          size="sm"
          leadingIcon={<DownloadIcon size={14} />}
          loading={downloading}
          onClick={() => void download()}
          aria-label={`Download ${asset.name}`}
        >
          <span className="hidden sm:inline">Download</span>
        </Button>
        {canManage && (
          <Button
            variant="invisible"
            size="sm"
            onClick={() => onDelete(asset)}
            aria-label={`Delete ${asset.name}`}
            className="text-fh-fg-muted hover:text-fh-danger-fg"
          >
            <TrashIcon size={14} />
          </Button>
        )}
      </div>
    </li>
  );
}

// ── create-release form ───────────────────────────────────────────────────────

type CreateValues = {
  tagName: string; target: string; name: string; body: string;
  isDraft: boolean; isPrerelease: boolean;
};

function CreateReleaseForm({
  token, handle, repoName, onCreate, onComplete, onCancel,
}: {
  token: string;
  handle: string;
  repoName: string;
  onCreate: (v: CreateValues) => Promise<Release>;
  onComplete: (release: Release, failedUploads: string[]) => void;
  onCancel: () => void;
}) {
  const [tagName, setTagName] = useState("");
  const [target, setTarget] = useState("main");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [isDraft, setIsDraft] = useState(false);
  const [isPrerelease, setIsPrerelease] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState<File[]>([]);
  const [progress, setProgress] = useState<Record<number, number>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  async function generate() {
    if (!tagName.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await generateReleaseNotes(token, handle, repoName, tagName.trim(), target.trim() || "main");
      setBody(res.body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate notes");
    } finally {
      setGenerating(false);
    }
  }

  function pickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list) return;
    setStaged((prev) => [...prev, ...Array.from(list)]);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!tagName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const release = await onCreate({
        tagName: tagName.trim(), target: target.trim() || "main",
        name: name.trim(), body, isDraft, isPrerelease,
      });
      const failed: string[] = [];
      for (let i = 0; i < staged.length; i++) {
        try {
          await uploadReleaseAsset(token, handle, repoName, release.id, staged[i], (f) =>
            setProgress((p) => ({ ...p, [i]: f })),
          );
        } catch {
          failed.push(staged[i].name);
        }
      }
      onComplete(release, failed);
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

      {/* Release notes with a generate button */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="release-notes-body" className="text-fh-sm font-medium text-fh-fg">Release notes</label>
          <Button
            variant="default"
            size="sm"
            leadingIcon={<SparkleIcon size={13} />}
            loading={generating}
            disabled={!tagName.trim() || saving}
            onClick={() => void generate()}
          >
            Generate release notes
          </Button>
        </div>
        <Textarea id="release-notes-body" value={body} onChange={(e) => setBody(e.target.value)} rows={6}
          placeholder="Describe what changed in this release…" className="font-mono text-fh-sm" />
        <p className="text-fh-sm text-fh-fg-subtle">Markdown supported. Generated notes are editable before you publish.</p>
      </div>

      {/* Attach binaries */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-fh-sm font-medium text-fh-fg">Attach binaries</span>
          <label className="inline-flex items-center gap-1.5 text-fh-sm text-fh-accent-fg cursor-pointer hover:underline">
            <UploadIcon size={13} /> Add files
            <input ref={fileInput} type="file" multiple className="sr-only" onChange={pickFiles} disabled={saving} />
          </label>
        </div>
        {staged.length > 0 && (
          <ul className="border border-fh-border rounded-md divide-y divide-fh-border-muted">
            {staged.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-fh-fg-subtle"><FileIcon size={14} /></span>
                  <span className="truncate font-mono text-fh-sm text-fh-fg">{f.name}</span>
                  <span className="text-fh-xs text-fh-fg-subtle shrink-0">{formatBytes(f.size)}</span>
                </span>
                {saving ? (
                  <span className="text-fh-xs text-fh-fg-subtle tabular-nums shrink-0">
                    {progress[i] != null ? `${Math.round(progress[i] * 100)}%` : "…"}
                  </span>
                ) : (
                  <Button variant="invisible" size="sm" onClick={() => setStaged((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="text-fh-fg-muted hover:text-fh-danger-fg shrink-0">
                    <TrashIcon size={13} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-fh-sm text-fh-fg-subtle">Uploaded to the release once it's created. Up to 100 MB each.</p>
      </div>

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
  release, isLatest, canManage, token, handle, repoName, onDelete, onChanged,
}: {
  release: Release;
  isLatest: boolean;
  canManage: boolean;
  token: string;
  handle: string;
  repoName: string;
  onDelete: (r: Release) => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const title = release.name || release.tagName;
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [pendingAsset, setPendingAsset] = useState<ReleaseAsset | null>(null);
  const [deletingAsset, setDeletingAsset] = useState(false);
  const assetInput = useRef<HTMLInputElement>(null);

  const badges = (
    <>
      {isLatest && <Badge tone="success">Latest</Badge>}
      {release.isPrerelease && <Badge tone="warning">Pre-release</Badge>}
      {release.isDraft && <Badge tone="neutral">Draft</Badge>}
    </>
  );

  async function uploadFiles(files: FileList) {
    setUploading(true);
    let anyFail = false;
    for (const file of Array.from(files)) {
      setUploadPct(0);
      try {
        await uploadReleaseAsset(token, handle, repoName, release.id, file, setUploadPct);
      } catch (err) {
        anyFail = true;
        toast(err instanceof Error ? `${file.name}: ${err.message}` : `Failed to upload ${file.name}`, { tone: "danger" });
      }
    }
    setUploading(false);
    if (!anyFail) toast("Asset uploaded", { tone: "success" });
    if (assetInput.current) assetInput.current.value = "";
    onChanged();
  }

  async function confirmDeleteAsset() {
    if (!pendingAsset) return;
    setDeletingAsset(true);
    try {
      await deleteReleaseAsset(token, handle, repoName, release.id, pendingAsset.id);
      toast(`Deleted ${pendingAsset.name}`, { tone: "success" });
      setPendingAsset(null);
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete asset", { tone: "danger" });
    } finally {
      setDeletingAsset(false);
    }
  }

  const hasAssets = release.assets.length > 0;

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

          {/* Assets */}
          {(hasAssets || canManage) && (
            <div className="border-t border-fh-border">
              <div className="flex items-center justify-between gap-2 px-4 py-2.5">
                <span className="inline-flex items-center gap-1.5 text-fh-sm font-semibold text-fh-fg">
                  Assets
                  {hasAssets && (
                    <span className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1.5 rounded-full text-fh-xs font-semibold bg-fh-neutral-muted text-fh-fg-muted">
                      {release.assets.length}
                    </span>
                  )}
                </span>
                {canManage && (
                  <label className={`inline-flex items-center gap-1.5 text-fh-sm cursor-pointer ${uploading ? "text-fh-fg-subtle" : "text-fh-accent-fg hover:underline"}`}>
                    <UploadIcon size={13} />
                    {uploading ? `Uploading… ${Math.round(uploadPct * 100)}%` : "Upload asset"}
                    <input
                      ref={assetInput}
                      type="file"
                      multiple
                      className="sr-only"
                      disabled={uploading}
                      onChange={(e) => { if (e.target.files && e.target.files.length) void uploadFiles(e.target.files); }}
                    />
                  </label>
                )}
              </div>
              {hasAssets ? (
                <ul className="border-t border-fh-border-muted divide-y divide-fh-border-muted">
                  {release.assets.map((asset) => (
                    <AssetRow
                      key={asset.id}
                      releaseId={release.id}
                      asset={asset}
                      token={token}
                      handle={handle}
                      repoName={repoName}
                      canManage={canManage}
                      onDelete={setPendingAsset}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-4 pb-3 text-fh-sm text-fh-fg-subtle">
                  No binaries attached. Upload compiled artifacts, datasets, or exported models.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {pendingAsset && (
        <ConfirmDialog
          title="Delete asset"
          message={<>Delete <span className="font-mono font-semibold">{pendingAsset.name}</span> from this release? This cannot be undone.</>}
          confirmLabel="Delete asset"
          loading={deletingAsset}
          onConfirm={() => void confirmDeleteAsset()}
          onCancel={() => setPendingAsset(null)}
        />
      )}
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

  function createReleaseFromForm(v: CreateValues): Promise<Release> {
    return createRelease(token, handle, repoName, v.tagName, v.name || v.tagName, v.body || undefined, v.isDraft, v.isPrerelease, v.target);
  }

  function onReleaseComplete(release: Release, failedUploads: string[]) {
    setShowCreate(false);
    if (failedUploads.length > 0) {
      toast(`Released ${release.tagName}, but ${failedUploads.length} asset(s) failed to upload`, { tone: "danger" });
    } else {
      toast(release.isDraft ? "Draft saved" : `Released ${release.tagName}`, { tone: "success" });
    }
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
          <CreateReleaseForm
            token={token}
            handle={handle}
            repoName={repoName}
            onCreate={createReleaseFromForm}
            onComplete={onReleaseComplete}
            onCancel={() => setShowCreate(false)}
          />
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
              token={token}
              handle={handle}
              repoName={repoName}
              onDelete={setPendingDelete}
              onChanged={load}
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
