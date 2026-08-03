/**
 * The PR files navigator (issue #119): a collapsible tree of the changed files
 * with per-file status dots and viewed ticks, plus a viewed progress meter.
 * Clicking a file scrolls its diff card into view (anchored by fileAnchorId).
 * Token-only chrome, mirroring the repo code tree's visual language.
 */
import { useMemo, useState } from "react";
import type { PRFileEntry } from "../../../types";
import { cx } from "../../../ui";
import { ChevronRightIcon } from "./prShared";
import { buildFileTree, countFiles, fileAnchorId, type FileTreeDir, type FileTreeFile } from "./fileTree";
import { CheckMark } from "./reviewShared";

/** Folder glyph (token-tinted, currentColor). */
function FolderIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden="true">
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z" />
    </svg>
  );
}

const STATUS_DOT: Record<PRFileEntry["status"], string> = {
  added: "bg-fh-success-emphasis",
  deleted: "bg-fh-danger-emphasis",
  renamed: "bg-fh-warning-emphasis",
  modified: "bg-fh-accent-emphasis",
};

function scrollToFile(path: string): void {
  document.getElementById(fileAnchorId(path))?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function FileRow({ file }: { file: FileTreeFile<PRFileEntry> }) {
  return (
    <li>
      <button
        type="button"
        title={file.path}
        onClick={() => scrollToFile(file.path)}
        className={cx(
          "w-full flex items-center gap-1.5 pl-5 pr-2 py-1 rounded text-left cursor-pointer",
          "bg-transparent border-none text-fh-sm hover:bg-fh-surface-muted transition-colors",
          file.entry.viewed ? "text-fh-fg-subtle" : "text-fh-fg",
        )}
      >
        <span className={cx("w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[file.entry.status])} aria-hidden />
        <span className="min-w-0 truncate font-mono text-fh-xs">{file.name}</span>
        {file.entry.viewed && <CheckMark size={12} className="ml-auto shrink-0 text-fh-success-fg" />}
      </button>
    </li>
  );
}

function DirRow({ dir }: { dir: FileTreeDir<PRFileEntry> }) {
  const [open, setOpen] = useState(true);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cx(
          "w-full flex items-center gap-1 px-1.5 py-1 rounded text-left cursor-pointer",
          "bg-transparent border-none text-fh-sm text-fh-fg-muted hover:bg-fh-surface-muted transition-colors",
        )}
      >
        <ChevronRightIcon size={10} className={cx("shrink-0 transition-transform", open && "rotate-90")} />
        <FolderIcon size={13} className="shrink-0 text-fh-accent-fg/70" />
        <span className="min-w-0 truncate font-medium">{dir.name}</span>
        {!open && <span className="ml-auto text-fh-xs text-fh-fg-subtle">{countFiles(dir)}</span>}
      </button>
      {open && (
        <ul className="list-none m-0 p-0 pl-3 border-l border-fh-border ml-2.5">
          {dir.dirs.map((d) => <DirRow key={d.path} dir={d} />)}
          {dir.files.map((f) => <FileRow key={f.path} file={f} />)}
        </ul>
      )}
    </li>
  );
}

export function PRFileTree({ files }: { files: PRFileEntry[] }) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const viewedCount = files.filter((f) => f.viewed).length;
  const pct = files.length === 0 ? 0 : Math.round((viewedCount / files.length) * 100);

  return (
    <nav aria-label="Changed files" className="text-fh-sm">
      {/* Viewed progress meter */}
      <div className="px-1 pb-2 mb-2 border-b border-fh-border">
        <p className="text-fh-xs text-fh-fg-muted mb-1">
          <span className="font-semibold text-fh-fg">{viewedCount}</span> / {files.length} files viewed
        </p>
        <div className="h-1.5 rounded-full bg-fh-surface-muted overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-fh-success-emphasis transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ul className="list-none m-0 p-0">
        {tree.dirs.map((d) => <DirRow key={d.path} dir={d} />)}
        {tree.files.map((f) => <FileRow key={f.path} file={f} />)}
      </ul>
    </nav>
  );
}
