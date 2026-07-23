import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Button, ConfirmDialog, Dialog, EmptyState, RelativeTime, Select, Spinner, useToast,
} from "../../../ui";
import {
  compareDesignVersions, deleteDesign, fetchDesignVersionBlob, listDesigns, uploadDesign,
} from "../../../api";
import type { Design, DesignCompareResult, DiffChange } from "../../../types";
import { gltfChangeType, gltfEntityOf } from "../../../types";
import { summarizeChanges } from "../../../lib/designDiff";

// ─── byte + diff formatting ─────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Tokenized diff colors — the same language the glTF workspace diff inspector uses. */
const DIFF_TOKEN: Record<string, string> = {
  added: "--fh-success-fg",
  removed: "--fh-danger-fg",
  modified: "--fh-fg-muted",
  moved: "--fh-purple-fg",
};
const diffFg = (type: string): string => `rgb(var(${DIFF_TOKEN[type] ?? "--fh-fg-muted"}))`;
const DIFF_ICON: Record<string, string> = { added: "+", removed: "−", modified: "~", moved: "↔" };
const DIFF_LABEL: Record<string, string> = { added: "added", removed: "removed", modified: "modified", moved: "moved" };

function vec(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((n) => (typeof n === "number" ? +n.toFixed(3) : String(n))).join(", ")}]`;
  return v === undefined || v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
}

// ─── local marks ────────────────────────────────────────────────────────────────

function Mark({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const CubeMark = (p: { size?: number }) => <Mark {...p} d="M8.878.392a1.75 1.75 0 0 0-1.756 0l-5.25 3.045A1.75 1.75 0 0 0 1 4.951v6.098c0 .624.332 1.2.872 1.514l5.25 3.045a1.75 1.75 0 0 0 1.756 0l5.25-3.045c.54-.313.872-.89.872-1.514V4.951c0-.624-.332-1.2-.872-1.514L8.878.392ZM7.875 1.69a.25.25 0 0 1 .25 0l4.63 2.685L8 7.133 3.245 4.375l4.63-2.685ZM2.5 5.677v5.372c0 .09.047.171.125.216l4.625 2.683V8.432L2.5 5.677Zm6.25 8.271 4.625-2.683a.25.25 0 0 0 .125-.216V5.677L8.75 8.432v5.516Z" />;
const ImageMark = (p: { size?: number }) => <Mark {...p} d="M16 13.25A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5Zm-1.75.25a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h.94l7.5-7.5 3.31 3.31V2.75Zm-.94 0-3.31-3.31L4.62 13.5h8.69Z" />;
const FileMark = (p: { size?: number }) => <Mark {...p} d="M2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 12.25 16h-8.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8 4.25V1.5Zm5.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" />;
const UploadMark = (p: { size?: number }) => <Mark {...p} d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Zm4.5-6.44v3.69a.75.75 0 0 0 1.5 0V7.56l1.97 1.97a.75.75 0 1 0 1.06-1.06L8.53 5.22a.75.75 0 0 0-1.06 0L4.22 8.47a.75.75 0 1 0 1.06 1.06Z" />;

// ─── authed image loading (object URLs, revoked on unmount) ──────────────────────

function useDesignImageUrl(
  args: { token: string | null; handle: string; repoName: string; number: number; designId: string; version: number; enabled: boolean },
): string | null {
  const { token, handle, repoName, number, designId, version, enabled } = args;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { setUrl(null); return; }
    let cancelled = false;
    let created: string | null = null;
    fetchDesignVersionBlob(token, handle, repoName, number, designId, version)
      .then((blob) => { if (cancelled) return; created = URL.createObjectURL(blob); setUrl(created); })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
  }, [token, handle, repoName, number, designId, version, enabled]);
  return url;
}

// ─── semantic diff (structural change list) ──────────────────────────────────────

function SemanticDiffView({ format, changes }: { format: string; changes: DiffChange[] }) {
  const summary = useMemo(() => summarizeChanges(changes), [changes]);

  if (changes.length === 0) {
    return <p className="text-fh-sm text-fh-fg-muted italic">No structural changes between these versions.</p>;
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 text-fh-xs font-medium">
        {(["added", "removed", "modified", "moved"] as const).map((k) =>
          summary[k] > 0 ? (
            <span key={k} className="inline-flex items-center gap-1 tabular-nums" style={{ color: diffFg(k) }}>
              <span className="font-mono">{DIFF_ICON[k]}</span>
              {summary[k]} {DIFF_LABEL[k]}
            </span>
          ) : null,
        )}
      </div>

      <ul className="space-y-1.5">
        {changes.map((c, i) => {
          const type = format === "gltf-scene" ? gltfChangeType(c) : c.kind;
          const entity = gltfEntityOf(c);
          const name = c.label ?? entity?.name ?? c.path;
          const fields = c.children ?? [];
          return (
            <li key={`${c.path}-${i}`} className="rounded-md border border-fh-border bg-fh-surface px-3 py-2">
              <div className="flex items-center gap-2 text-fh-sm">
                <span
                  className="inline-flex items-center justify-center w-5 h-5 rounded font-mono text-fh-xs shrink-0"
                  style={{ color: diffFg(type), backgroundColor: `rgb(var(${DIFF_TOKEN[type] ?? "--fh-fg-muted"}) / 0.12)` }}
                >
                  {DIFF_ICON[type] ?? "~"}
                </span>
                <span className="font-medium text-fh-fg truncate">{name}</span>
                <span className="text-fh-xs text-fh-fg-subtle capitalize" style={{ color: diffFg(type) }}>{DIFF_LABEL[type] ?? type}</span>
                {c.path !== name && <code className="ml-auto text-fh-xs text-fh-fg-subtle font-mono truncate">{c.path}</code>}
              </div>
              {fields.length > 0 && (
                <dl className="mt-1.5 pl-7 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-fh-xs">
                  {fields.map((f, j) => (
                    <div key={`${f.path}-${j}`} className="contents">
                      <dt className="text-fh-fg-subtle capitalize">{f.path}</dt>
                      <dd className="font-mono text-fh-fg-muted">
                        <span className="line-through opacity-70">{vec(f.before)}</span>
                        <span className="mx-1 text-fh-fg-subtle">→</span>
                        <span style={{ color: diffFg("moved") }}>{vec(f.after)}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── visual diff (before / after images) ─────────────────────────────────────────

function VisualDiffView({
  base, token, handle, repoName, number, designId, fromV, toV,
}: {
  base: string; token: string | null; handle: string; repoName: string; number: number; designId: string; fromV: number; toV: number;
}) {
  const fromUrl = useDesignImageUrl({ token, handle, repoName, number, designId, version: fromV, enabled: true });
  const toUrl = useDesignImageUrl({ token, handle, repoName, number, designId, version: toV, enabled: true });
  const cell = (label: string, url: string | null, tone: string) => (
    <figure className="min-w-0">
      <figcaption className="flex items-center gap-2 mb-1.5 text-fh-xs font-medium">
        <Badge tone={tone as "danger" | "success"}>{label}</Badge>
      </figcaption>
      <div className="flex items-center justify-center rounded-md border border-fh-border bg-fh-canvas p-2 min-h-40">
        {url
          ? <img src={url} alt={label} className="max-w-full max-h-72 object-contain" />
          : <Spinner />}
      </div>
    </figure>
  );
  void base;
  return (
    <div className="grid grid-cols-2 gap-4">
      {cell(`v${fromV}`, fromUrl, "danger")}
      {cell(`v${toV}`, toUrl, "success")}
    </div>
  );
}

// ─── design detail (version history + compare) ───────────────────────────────────

function DesignDetail({
  design, token, handle, repoName, number,
}: {
  design: Design; token: string; handle: string; repoName: string; number: number;
}) {
  const versions = design.versions;
  const hasTwo = versions.length >= 2;
  const [fromV, setFromV] = useState<number>(hasTwo ? versions[versions.length - 2]!.version : 1);
  const [toV, setToV] = useState<number>(design.currentVersion);
  const [result, setResult] = useState<DesignCompareResult | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bothIngested = useMemo(() => {
    const f = versions.find((v) => v.version === fromV);
    const t = versions.find((v) => v.version === toV);
    return !!(f?.hasSnapshot && t?.hasSnapshot);
  }, [versions, fromV, toV]);

  useEffect(() => {
    if (!hasTwo || fromV === toV) { setResult(null); return; }
    let cancelled = false;
    setComparing(true);
    setError(null);
    compareDesignVersions(token, handle, repoName, number, design.id, fromV, toV)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Compare failed"); })
      .finally(() => { if (!cancelled) setComparing(false); });
    return () => { cancelled = true; };
  }, [token, handle, repoName, number, design.id, fromV, toV, hasTwo]);

  const base = `/${handle}/${repoName}`;

  return (
    <div className="space-y-4">
      {/* Version history */}
      <div>
        <h4 className="text-fh-xs font-semibold uppercase tracking-wide text-fh-fg-subtle mb-2">Versions</h4>
        <ul className="divide-y divide-fh-border rounded-md border border-fh-border overflow-hidden">
          {versions.slice().reverse().map((v) => (
            <li key={v.version} className="flex items-center gap-2 px-3 py-2 text-fh-sm bg-fh-surface">
              <Badge tone={v.version === design.currentVersion ? "accent" : "neutral"}>v{v.version}</Badge>
              {v.hasSnapshot && <Badge tone="purple">semantic</Badge>}
              {v.isImage && <Badge tone="neutral">image</Badge>}
              <span className="text-fh-xs text-fh-fg-subtle tabular-nums">{formatBytes(v.size)}</span>
              <span className="ml-auto text-fh-xs text-fh-fg-subtle">
                {v.uploadedBy && <>@{v.uploadedBy} · </>}<RelativeTime date={v.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Compare */}
      {hasTwo ? (
        <div>
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <label className="text-fh-sm">
              <span className="block text-fh-xs text-fh-fg-subtle mb-1">Compare</span>
              <Select value={String(fromV)} onChange={(e) => setFromV(Number(e.target.value))}>
                {versions.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}
              </Select>
            </label>
            <span className="pb-2 text-fh-fg-subtle">→</span>
            <label className="text-fh-sm">
              <span className="block text-fh-xs text-fh-fg-subtle mb-1">with</span>
              <Select value={String(toV)} onChange={(e) => setToV(Number(e.target.value))}>
                {versions.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}
              </Select>
            </label>
          </div>

          <div className="rounded-md border border-fh-border bg-fh-surface-muted p-3 min-h-24">
            {fromV === toV ? (
              <p className="text-fh-sm text-fh-fg-muted italic">Pick two different versions to compare.</p>
            ) : comparing ? (
              <div className="flex items-center gap-2 text-fh-sm text-fh-fg-muted"><Spinner /> Computing diff…</div>
            ) : error ? (
              <p className="text-fh-sm text-fh-danger-fg">{error}</p>
            ) : result?.mode === "semantic" ? (
              <>
                <div className="flex items-center gap-2 mb-2 text-fh-xs text-fh-fg-subtle">
                  <Badge tone="purple">FHR semantic diff</Badge>
                  <span className="font-mono">{result.handlerId}</span>
                </div>
                <SemanticDiffView format={result.format} changes={result.changes} />
              </>
            ) : result?.mode === "visual" ? (
              <>
                <div className="mb-2"><Badge tone="accent">Visual diff</Badge></div>
                <VisualDiffView
                  base={base} token={token} handle={handle} repoName={repoName} number={number}
                  designId={design.id} fromV={result.from.version} toV={result.to.version}
                />
              </>
            ) : result?.mode === "binary" ? (
              <div className="text-fh-sm">
                <div className="mb-2"><Badge tone="neutral">Binary</Badge></div>
                <p className="text-fh-fg-muted">
                  No inline diff for this format. v{result.from.version} is{" "}
                  <span className="tabular-nums font-medium text-fh-fg">{formatBytes(result.from.size)}</span>, v{result.to.version} is{" "}
                  <span className="tabular-nums font-medium text-fh-fg">{formatBytes(result.to.size)}</span>
                  {result.to.size !== result.from.size && (
                    <> ({result.to.size > result.from.size ? "+" : "−"}{formatBytes(Math.abs(result.to.size - result.from.size))}).</>
                  )}
                </p>
              </div>
            ) : null}
          </div>

          {!bothIngested && result?.mode !== "semantic" && result?.mode !== "visual" && fromV !== toV && !comparing && (
            <p className="mt-2 text-fh-xs text-fh-fg-subtle">
              Upload an FHR-recognized format (e.g. glTF) to unlock structural, version-vs-version diffs.
            </p>
          )}
        </div>
      ) : (
        <p className="text-fh-sm text-fh-fg-muted italic">Upload another version to compare changes.</p>
      )}
    </div>
  );
}

// ─── gallery card ─────────────────────────────────────────────────────────────────

function DesignCard({
  design, token, handle, repoName, number, onOpen,
}: {
  design: Design; token: string; handle: string; repoName: string; number: number; onOpen: () => void;
}) {
  const thumbUrl = useDesignImageUrl({
    token, handle, repoName, number, designId: design.id, version: design.currentVersion, enabled: design.isImage,
  });
  const Icon = design.isImage ? ImageMark : design.semantic ? CubeMark : FileMark;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group text-left rounded-md border border-fh-border bg-fh-surface hover:border-fh-accent-fg hover:shadow-sm transition-colors overflow-hidden"
    >
      <div className="flex items-center justify-center h-32 bg-fh-canvas border-b border-fh-border overflow-hidden">
        {design.isImage && thumbUrl ? (
          <img src={thumbUrl} alt={design.name} className="max-w-full max-h-full object-contain" />
        ) : (
          <span className="text-fh-fg-subtle group-hover:text-fh-accent-fg transition-colors"><Icon size={40} /></span>
        )}
      </div>
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-fh-sm text-fh-fg truncate">{design.name}</span>
          <Badge tone="accent">v{design.currentVersion}</Badge>
        </div>
        <div className="mt-1 flex items-center gap-2 text-fh-xs text-fh-fg-subtle">
          {design.semantic && <Badge tone="purple">semantic</Badge>}
          <span>{design.versions.length} version{design.versions.length !== 1 ? "s" : ""}</span>
        </div>
      </div>
    </button>
  );
}

// ─── section ────────────────────────────────────────────────────────────────────

export function DesignsSection({
  token, handle, repoName, number, viewerHandle, canManageRepo, onChanged,
}: {
  token: string;
  handle: string;
  repoName: string;
  number: number;
  viewerHandle: string;
  canManageRepo: boolean;
  /** Called after an upload/delete so the parent can refresh the issue timeline. */
  onChanged?: () => void;
}) {
  const [designs, setDesigns] = useState<Design[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Design | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  function refresh() {
    return listDesigns(token, handle, repoName, number)
      .then((r) => setDesigns(r.designs))
      .catch(() => { /* keep prior list */ });
  }

  useEffect(() => {
    setLoading(true);
    listDesigns(token, handle, repoName, number)
      .then((r) => setDesigns(r.designs))
      .catch(() => setDesigns([]))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, number]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setUploading(true);
    try {
      const { design, version } = await uploadDesign(token, handle, repoName, number, file);
      await refresh();
      toast(
        version.version === 1 ? `Added design ${design.name}` : `Uploaded v${version.version} of ${design.name}`,
        { tone: "success" },
      );
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Upload failed", { tone: "danger" });
    } finally {
      setUploading(false);
    }
  }

  async function doDelete(design: Design) {
    try {
      await deleteDesign(token, handle, repoName, number, design.id);
      setConfirmDelete(null);
      setOpenId((id) => (id === design.id ? null : id));
      await refresh();
      toast(`Deleted ${design.name}`, { tone: "success" });
      onChanged?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", { tone: "danger" });
    }
  }

  const openDesign = designs.find((d) => d.id === openId) ?? null;
  const canManageDesign = (d: Design) => canManageRepo || d.createdBy === viewerHandle;

  return (
    <section className="border border-fh-border rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 bg-fh-surface-muted border-b border-fh-border">
        <span className="text-fh-fg-muted"><CubeMark size={16} /></span>
        <h3 className="text-fh-sm font-semibold text-fh-fg">Designs</h3>
        {designs.length > 0 && <Badge tone="neutral">{designs.length}</Badge>}
        <div className="ml-auto">
          <input ref={fileRef} type="file" className="hidden" onChange={onPick} />
          <Button size="sm" variant="default" loading={uploading} onClick={() => fileRef.current?.click()} leadingIcon={<UploadMark size={16} />}>
            Upload design
          </Button>
        </div>
      </div>

      <div className="p-4 bg-fh-surface">
        {loading ? (
          <div className="flex items-center gap-2 text-fh-sm text-fh-fg-muted"><Spinner /> Loading designs…</div>
        ) : designs.length === 0 ? (
          <EmptyState
            title="No designs yet"
            description="Attach a design or artifact file — glTF and other FHR formats get structural, version-vs-version diffs; images get a visual before/after."
            actions={<Button variant="primary" size="sm" loading={uploading} onClick={() => fileRef.current?.click()} leadingIcon={<UploadMark size={16} />}>Upload a design</Button>}
          />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {designs.map((d) => (
              <DesignCard
                key={d.id}
                design={d}
                token={token} handle={handle} repoName={repoName} number={number}
                onOpen={() => setOpenId(d.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail dialog */}
      <Dialog
        open={openDesign !== null}
        onClose={() => setOpenId(null)}
        title={openDesign?.name ?? "Design"}
        description={openDesign ? `Version ${openDesign.currentVersion} · ${openDesign.versions.length} version${openDesign.versions.length !== 1 ? "s" : ""}` : undefined}
        footer={
          openDesign && canManageDesign(openDesign) ? (
            <>
              <Button variant="danger" onClick={() => setConfirmDelete(openDesign)}>Delete design</Button>
              <Button variant="default" onClick={() => setOpenId(null)}>Close</Button>
            </>
          ) : (
            <Button variant="default" onClick={() => setOpenId(null)}>Close</Button>
          )
        }
      >
        {openDesign && (
          <DesignDetail design={openDesign} token={token} handle={handle} repoName={repoName} number={number} />
        )}
      </Dialog>

      <ConfirmDialog
        open={confirmDelete !== null}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && doDelete(confirmDelete)}
        title="Delete design"
        confirmLabel="Delete"
        tone="danger"
        message={
          confirmDelete ? (
            <>
              Permanently delete <span className="font-semibold text-fh-fg">{confirmDelete.name}</span> and all{" "}
              {confirmDelete.versions.length} of its versions? This cannot be undone.
            </>
          ) : ""
        }
      />
    </section>
  );
}
