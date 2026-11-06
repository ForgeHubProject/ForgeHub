import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, commitContents, fetchRawBlob, listBranches, type ContentChange } from "../../api";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import type { BranchInfo } from "../../types";
import { Button, Dialog, RadioCard, RadioGroup, Skeleton, Textarea, TextInput, cx, useToast } from "../../ui";
import type { EditMode } from "./refs";

/** GitHub's web limit, which the API enforces too. */
const FILE_LIMIT = 25 * 1024 * 1024;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseName = (p: string) => p.split("/").pop() ?? p;
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * Editing a repository in the browser (#254), GitHub's pages:
 *   edit/<branch>/<file>     the file in an editor (Edit / Preview), renameable
 *   new/<branch>[/<folder>]  a new file; a name with slashes makes folders
 *   upload/<branch>[/<folder>] drop or choose files (a same-named file is replaced)
 *   delete/<branch>/<file>   straight to the commit dialog
 * Each ends in "Commit changes": to the branch, or to a new branch and a pull
 * request. A protected branch offers only the second.
 */
export function FileEditor({
  token, handle, repoName, base, mode, gitRef, path, branches, userHandle,
}: {
  token: string;
  handle: string;
  repoName: string;
  base: string;
  mode: EditMode;
  gitRef: string;
  /** The file (edit, delete) or the folder (new, upload). */
  path: string;
  branches: BranchInfo[];
  userHandle: string;
}) {
  const navigate = useNavigate();
  const isFile = mode === "edit" || mode === "delete";
  const dir = isFile ? dirOf(path) : path;

  const [name, setName] = useState(isFile ? baseName(path) : "");
  const [original, setOriginal] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(isFile);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [files, setFiles] = useState<File[]>([]);
  const [committing, setCommitting] = useState(mode === "delete");
  // The tip the change starts from, read when the page opens: a push after
  // that makes the commit fail instead of silently overwriting it. Undefined
  // while loading.
  const [tip, setTip] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    listBranches(token, handle, repoName)
      .then((d) => setTip(d.branches.find((b) => b.name === gitRef)?.sha ?? null))
      .catch(() => setTip(null));
  }, [token, handle, repoName, gitRef]);

  // The file's exact bytes at that tip (the JSON blob endpoint trims them, and
  // the raw one is cached by commit, so a branch name could read stale).
  useEffect(() => {
    if (mode !== "edit" || tip === undefined) return;
    fetchRawBlob(token, handle, repoName, path, tip ?? gitRef)
      .then(async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const text = bytes.subarray(0, 8000).includes(0) ? null : decodeUtf8(bytes);
        if (text === null) throw new Error("This file isn't text, so it can't be edited here. Upload a new version instead.");
        setOriginal(text);
        setContent(text);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load the file"))
      .finally(() => setLoading(false));
  }, [mode, tip, token, handle, repoName, path, gitRef]);

  const target = join(dir, name.trim().replace(/^\/+/, ""));
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(target);
  const changed = mode === "edit" ? content !== original || target !== path : true;
  const branch = branches.find((b) => b.name === gitRef);

  const defaultMessage =
    mode === "delete" ? `Delete ${baseName(path)}`
    : mode === "upload" ? (files.length === 1 ? `Add ${files[0].name}` : "Add files via upload")
    : mode === "new" ? `Create ${baseName(target) || "file"}`
    : target !== path ? `Rename ${baseName(path)} to ${baseName(target)}`
    : `Update ${baseName(path)}`;

  async function buildChanges(): Promise<ContentChange[]> {
    if (mode === "delete") return [{ path, delete: true }];
    if (mode === "upload") {
      return Promise.all(files.map(async (f) => ({
        path: join(dir, (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name),
        content: await toBase64(f),
        encoding: "base64" as const,
      })));
    }
    if (mode === "new") return [{ path: target, content }];
    return target !== path ? [{ path: target, from: path, content }] : [{ path, content }];
  }

  const crumbs = dir ? dir.split("/") : [];
  const canCommit =
    mode === "upload" ? files.length > 0
    : mode === "new" ? !!name.trim()
    : mode === "edit" ? !!name.trim() && changed && original !== null
    : true;

  return (
    <div className="space-y-4">
      {/* The path: repo / folders / file name (editable), as GitHub's editor shows it */}
      <div className="flex flex-wrap items-center gap-1 text-fh-base">
        <Link to={`${base}/tree/${gitRef}`} className="font-semibold text-fh-accent-fg hover:underline">{repoName}</Link>
        {crumbs.map((c, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <span className="text-fh-fg-subtle">/</span>
            <Link to={`${base}/tree/${gitRef}/${crumbs.slice(0, i + 1).join("/")}`} className="text-fh-accent-fg hover:underline">{c}</Link>
          </span>
        ))}
        <span className="text-fh-fg-subtle">/</span>
        {mode === "edit" || mode === "new" ? (
          <TextInput
            aria-label="File name"
            placeholder="Name your file…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-64"
            autoFocus={mode === "new"}
          />
        ) : mode === "delete" ? (
          <span className="font-semibold text-fh-fg">{baseName(path)}</span>
        ) : null}
        <span className="ml-2 text-fh-sm text-fh-fg-muted">in <code className="font-mono text-fh-xs">{gitRef}</code></span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="default"
            onClick={() => navigate(isFile ? `${base}/blob/${gitRef}/${path}` : `${base}/tree/${gitRef}${dir ? `/${dir}` : ""}`)}
          >
            Cancel changes
          </Button>
          <Button variant="primary" disabled={!canCommit} onClick={() => setCommitting(true)}>
            Commit changes…
          </Button>
        </div>
      </div>

      {(mode === "edit" || mode === "new") && (
        loading ? (
          <div className="rounded-md border border-fh-border bg-fh-surface p-4 space-y-2">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="text" width={`${70 - i * 10}%`} />)}
          </div>
        ) : loadError ? (
          <div className="rounded-md border border-fh-border bg-fh-surface p-8 text-center text-fh-sm text-fh-danger-fg">{loadError}</div>
        ) : (
          <div className="rounded-md border border-fh-border bg-fh-surface">
            <div className="flex items-center gap-1 px-2 pt-1.5 border-b border-fh-border bg-fh-canvas rounded-t-md">
              {(["edit", "preview"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cx(
                    "-mb-px px-3 py-1.5 text-fh-sm rounded-t-md border",
                    view === v ? "bg-fh-surface border-fh-border border-b-fh-surface text-fh-fg font-semibold" : "border-transparent text-fh-fg-muted hover:text-fh-fg",
                  )}
                >
                  {v === "edit" ? "Edit" : "Preview"}
                </button>
              ))}
            </div>
            {view === "edit" ? (
              <CodeArea value={content} onChange={setContent} />
            ) : isMarkdown ? (
              <div className="px-6 py-4">
                {content.trim() ? <MarkdownRenderer content={content} repo={{ owner: handle, name: repoName }} /> : <p className="text-fh-sm text-fh-fg-subtle">Nothing to preview</p>}
              </div>
            ) : (
              <ChangesPreview before={original ?? ""} after={content} />
            )}
          </div>
        )
      )}

      {mode === "upload" && <UploadZone files={files} onFiles={setFiles} />}

      {mode === "delete" && (
        <div className="rounded-md border border-fh-border bg-fh-surface p-6 text-fh-sm text-fh-fg-muted">
          Deleting <code className="font-mono">{path}</code> from <code className="font-mono">{gitRef}</code>.
        </div>
      )}

      {committing && (
        <CommitDialog
          defaultMessage={defaultMessage}
          branch={gitRef}
          protectedBranch={!!branch?.protected}
          userHandle={userHandle}
          branches={branches}
          onClose={() => (mode === "delete" ? navigate(`${base}/blob/${gitRef}/${path}`) : setCommitting(false))}
          onCommit={async ({ message, description, newBranch }) => {
            const res = await commitContents(token, handle, repoName, {
              branch: gitRef,
              newBranch: newBranch ?? undefined,
              expectedSha: tip || undefined,
              message,
              description: description || undefined,
              changes: await buildChanges(),
            });
            if (newBranch) {
              const q = new URLSearchParams({ from: res.branch, to: gitRef, title: message });
              navigate(`${base}/pulls/new?${q}`);
            } else if (mode === "delete") {
              navigate(`${base}/tree/${res.branch}${dir ? `/${dir}` : ""}`);
            } else if (mode === "upload") {
              navigate(`${base}/tree/${res.branch}${dir ? `/${dir}` : ""}`);
            } else {
              navigate(`${base}/blob/${res.branch}/${target}`);
            }
          }}
        />
      )}
    </div>
  );
}

/** A plain code editor: monospace, no wrapping, Tab indents. */
function CodeArea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lines = Math.max(value.split("\n").length, 20);
  return (
    <div className="flex font-mono text-fh-sm leading-6">
      <div aria-hidden className="select-none py-2 pl-3 pr-2 text-right text-fh-fg-subtle bg-fh-canvas border-r border-fh-border-muted">
        {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <textarea
        ref={ref}
        aria-label="File contents"
        value={value}
        spellCheck={false}
        wrap="off"
        rows={lines}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Tab" || e.shiftKey) return;
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: s, selectionEnd: end } = el;
          onChange(value.slice(0, s) + "  " + value.slice(end));
          requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
        }}
        className="flex-1 min-w-0 resize-none overflow-x-auto bg-transparent px-3 py-2 text-fh-fg focus:outline-none"
      />
    </div>
  );
}

/** What changed, line by line, for a file that isn't Markdown. */
function ChangesPreview({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => lineDiff(before.split("\n"), after.split("\n")), [before, after]);
  if (!rows.some((r) => r.kind !== "same")) {
    return <p className="px-6 py-4 text-fh-sm text-fh-fg-subtle">No changes to show.</p>;
  }
  return (
    <pre className="overflow-x-auto py-2 font-mono text-fh-sm leading-6">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cx(
            "px-3 whitespace-pre",
            r.kind === "add" && "bg-fh-success-muted text-fh-fg",
            r.kind === "del" && "bg-fh-danger-muted text-fh-fg",
            r.kind === "same" && "text-fh-fg-muted",
          )}
        >
          {r.kind === "add" ? "+ " : r.kind === "del" ? "- " : "  "}
          {r.text}
        </div>
      ))}
    </pre>
  );
}

/** A longest-common-subsequence line diff; fine for files a browser can edit. */
export function lineDiff(a: string[], b: string[]): Array<{ kind: "same" | "add" | "del"; text: string }> {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Array<{ kind: "same" | "add" | "del"; text: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

function UploadZone({ files, onFiles }: { files: File[]; onFiles: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const tooBig = files.filter((f) => f.size > FILE_LIMIT);

  function add(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      const i = next.findIndex((x) => x.name === f.name);
      if (i >= 0) next[i] = f; else next.push(f);
    }
    onFiles(next);
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
        className={cx(
          "rounded-md border-2 border-dashed px-6 py-14 text-center transition-colors",
          over ? "border-fh-accent-emphasis bg-fh-accent-subtle" : "border-fh-border bg-fh-surface",
        )}
      >
        <p className="text-fh-lg font-semibold text-fh-fg">Drag files here to add them to your repository</p>
        <p className="mt-1 text-fh-sm text-fh-fg-muted">
          Or{" "}
          <button type="button" onClick={() => input.current?.click()} className="text-fh-accent-fg hover:underline">choose your files</button>
          . A file with the same name replaces the one in the folder.
        </p>
        <input ref={input} type="file" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      </div>
      {files.length > 0 && (
        <ul className="rounded-md border border-fh-border bg-fh-surface divide-y divide-fh-border-muted">
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-3 px-4 py-2 text-fh-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-fh-fg">{f.name}</span>
              <span className={cx("shrink-0 text-fh-xs", f.size > FILE_LIMIT ? "text-fh-danger-fg" : "text-fh-fg-subtle")}>
                {formatSize(f.size)}{f.size > FILE_LIMIT && " — over the 25 MB limit"}
              </span>
              <button type="button" onClick={() => onFiles(files.filter((x) => x !== f))} className="text-fh-xs text-fh-danger-fg hover:underline">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {tooBig.length > 0 && (
        <p className="text-fh-sm text-fh-danger-fg">Files over 25 MB can't be added on the web. Push them with git instead.</p>
      )}
    </div>
  );
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The next free `<user>-patch-N` name, GitHub's default for a proposal branch. */
export function patchBranchName(userHandle: string, branches: Array<{ name: string }>): string {
  const taken = new Set(branches.map((b) => b.name));
  for (let n = 1; ; n++) {
    const name = `${userHandle}-patch-${n}`;
    if (!taken.has(name)) return name;
  }
}

/** GitHub's "Commit changes" dialog. */
function CommitDialog({
  defaultMessage, branch, protectedBranch, userHandle, branches, onClose, onCommit,
}: {
  defaultMessage: string;
  branch: string;
  protectedBranch: boolean;
  userHandle: string;
  branches: BranchInfo[];
  onClose: () => void;
  onCommit: (c: { message: string; description: string; newBranch: string | null }) => Promise<void>;
}) {
  const { toast } = useToast();
  const [message, setMessage] = useState(defaultMessage);
  const [description, setDescription] = useState("");
  const [where, setWhere] = useState<"direct" | "branch">(protectedBranch ? "branch" : "direct");
  const [newBranch, setNewBranch] = useState(() => patchBranchName(userHandle, branches));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCommit({
        message: message.trim() || defaultMessage,
        description: description.trim(),
        newBranch: where === "branch" ? newBranch.trim() : null,
      });
      toast("Changes committed", { tone: "success" });
    } catch (err) {
      const moved = err instanceof ApiError && err.status === 409 && /changed since/i.test(err.message);
      setError(moved ? `${err.message}` : err instanceof Error ? err.message : "Commit failed");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Commit changes"
      footer={
        <>
          <Button variant="default" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" form="commit-changes" loading={busy} disabled={where === "branch" && !newBranch.trim()}>
            {where === "branch" ? "Propose changes" : "Commit changes"}
          </Button>
        </>
      }
    >
      <form id="commit-changes" onSubmit={submit} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-fh-sm font-semibold text-fh-fg">Commit message</span>
          <TextInput value={message} onChange={(e) => setMessage(e.target.value)} placeholder={defaultMessage} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-fh-sm font-semibold text-fh-fg">Extended description</span>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add an optional extended description…" />
        </label>
        <RadioGroup name="commit-where" value={where} onChange={(v) => setWhere(v as "direct" | "branch")}>
          <RadioCard
            value="direct"
            disabled={protectedBranch}
            title={<>Commit directly to the <code className="font-mono">{branch}</code> branch</>}
            description={protectedBranch ? "This branch is protected: changes to it go through a pull request." : undefined}
          />
          <RadioCard
            value="branch"
            title="Create a new branch for this commit and start a pull request"
            description={
              where === "branch" ? (
                <TextInput aria-label="New branch name" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} className="mt-2 font-mono" />
              ) : undefined
            }
          />
        </RadioGroup>
        {error && <p className="text-fh-sm text-fh-danger-fg">{error}</p>}
      </form>
    </Dialog>
  );
}
