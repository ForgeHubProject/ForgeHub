import { useEffect, useState } from "react";
import { getBlob } from "../api";
import { Breadcrumbs, Skeleton, useToast } from "../ui";
import type { Crumb } from "../ui";
import { resolveFileViewer } from "../views/fileViewerRegistry";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  ref: string;
  path: string;
  repoBase: string;
};

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z" />
      <path fillRule="evenodd" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M7.47 10.78a.75.75 0 001.06 0l3.75-3.75a.75.75 0 00-1.06-1.06L8.75 8.44V1.75a.75.75 0 00-1.5 0v6.69L4.78 5.97a.75.75 0 00-1.06 1.06l3.75 3.75zM3.75 13a.75.75 0 000 1.5h8.5a.75.75 0 000-1.5h-8.5z" />
    </svg>
  );
}

/** A small button in the blob header action row. */
function HeaderAction({ onClick, icon, children, href }: {
  onClick?: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  href?: string;
}) {
  const cls =
    "inline-flex items-center gap-1.5 h-6 px-2 text-fh-sm text-fh-fg-muted bg-fh-surface " +
    "border border-fh-border rounded-md hover:bg-fh-surface-muted hover:text-fh-fg " +
    "hover:border-fh-border-strong transition-colors cursor-pointer whitespace-nowrap";
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {icon}
      {children}
    </button>
  );
}

export function BlobViewer({ token, handle, repoName, ref, path, repoBase }: Props) {
  const { toast } = useToast();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const filename = path.split("/").pop() ?? path;
  const pathParts = path.split("/");
  const lineCount = content?.split("\n").length ?? 0;
  const sizeKb = content ? content.length / 1024 : 0;

  const Viewer = resolveFileViewer(filename);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBlob(token, handle, repoName, path, ref)
      .then((d) => { if (!cancelled) setContent(d.content); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load file"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, handle, repoName, path, ref]);

  function copy() {
    if (!content) return;
    void navigator.clipboard.writeText(content).then(() => toast("File contents copied", { tone: "success" }));
  }

  function download() {
    if (content === null) return;
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openRaw() {
    if (content === null) return;
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    window.open(url, "_blank", "noopener,noreferrer");
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const crumbs: Crumb[] = [
    { label: repoName, to: repoBase },
    ...pathParts.slice(0, -1).map((part, i) => ({
      label: part,
      to: `${repoBase}/tree/${ref}/${pathParts.slice(0, i + 1).join("/")}`,
    })),
    { label: filename },
  ];

  const breadcrumb = <Breadcrumbs items={crumbs} className="mb-3" />;

  if (loading) {
    return (
      <div>
        {breadcrumb}
        <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
          <div className="h-9 bg-fh-canvas border-b border-fh-border" />
          <div className="p-4 space-y-2">
            {[...Array(12)].map((_, i) => (
              <Skeleton key={i} className="h-3" width={`${55 + ((i * 17) % 40)}%`} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || content === null) {
    return (
      <div>
        {breadcrumb}
        <div className="border border-fh-border rounded-md bg-fh-surface p-8 text-center text-fh-danger-fg">
          {error ?? "File not found"}
        </div>
      </div>
    );
  }

  return (
    <div>
      {breadcrumb}
      <div className="border border-fh-border rounded-md overflow-hidden bg-fh-surface">
        {/* File header bar */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-fh-canvas border-b border-fh-border">
          <div className="flex items-center gap-3 text-fh-sm text-fh-fg-muted min-w-0">
            <span className="whitespace-nowrap"><span className="font-semibold text-fh-fg">{lineCount}</span> lines</span>
            <span className="text-fh-border-strong">·</span>
            <span className="whitespace-nowrap"><span className="font-semibold text-fh-fg">{sizeKb.toFixed(sizeKb < 10 ? 1 : 0)}</span> KB</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <HeaderAction icon={<CodeGlyph />} onClick={openRaw}>Raw</HeaderAction>
            <HeaderAction icon={<CopyIcon />} onClick={copy}>Copy</HeaderAction>
            <HeaderAction icon={<DownloadIcon />} onClick={download}>Download</HeaderAction>
          </div>
        </div>

        {/* Delegated to the registered viewer */}
        <Viewer content={content} path={path} filename={filename} gitRef={ref} />
      </div>
    </div>
  );
}

function CodeGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M4.72 3.22a.75.75 0 011.06 1.06L2.06 8l3.72 3.72a.75.75 0 11-1.06 1.06L.47 8.53a.75.75 0 010-1.06l4.25-4.25zm6.56 0a.75.75 0 10-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 101.06 1.06l4.25-4.25a.75.75 0 000-1.06l-4.25-4.25z" />
    </svg>
  );
}
