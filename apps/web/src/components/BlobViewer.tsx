import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBlob } from "../api";
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
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z" />
      <path fillRule="evenodd" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z" />
    </svg>
  );
}

export function BlobViewer({ token, handle, repoName, ref, path, repoBase }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const filename = path.split("/").pop() ?? path;
  const pathParts = path.split("/");
  const lineCount = content?.split("\n").length ?? 0;

  const Viewer = resolveFileViewer(filename);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getBlob(token, handle, repoName, path, ref)
      .then((d) => setContent(d.content))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load file"))
      .finally(() => setLoading(false));
  }, [token, handle, repoName, path, ref]);

  function copy() {
    if (!content) return;
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const breadcrumb = (
    <div className="flex items-center gap-1 text-sm flex-wrap mb-3">
      <Link to={repoBase} className="text-gh-accent hover:underline font-medium">
        {repoBase.split("/").pop()}
      </Link>
      {pathParts.map((part, i) => {
        const partPath = pathParts.slice(0, i + 1).join("/");
        return (
          <span key={i} className="flex items-center gap-1">
            <span className="text-gh-muted">/</span>
            {i === pathParts.length - 1 ? (
              <span className="font-semibold text-gh-text">{part}</span>
            ) : (
              <Link to={`${repoBase}/tree/${ref}/${partPath}`} className="text-gh-accent hover:underline">
                {part}
              </Link>
            )}
          </span>
        );
      })}
    </div>
  );

  if (loading) {
    return (
      <div>
        {breadcrumb}
        <div className="card animate-pulse">
          <div className="h-10 bg-gh-bg border-b border-gh-border rounded-t-md" />
          <div className="p-4 space-y-2">
            {[...Array(12)].map((_, i) => (
              <div key={i} className="h-3 bg-gray-100 rounded" style={{ width: `${60 + (i * 17) % 40}%` }} />
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
        <div className="card p-8 text-center text-gh-danger">{error ?? "File not found"}</div>
      </div>
    );
  }

  return (
    <div>
      {breadcrumb}
      <div className="card overflow-hidden">
        {/* Universal file header */}
        <div className="flex items-center justify-between px-4 py-2 bg-gh-bg border-b border-gh-border">
          <div className="flex items-center gap-3 text-xs text-gh-muted">
            <span><span className="font-semibold text-gh-text">{lineCount}</span> lines</span>
            <span><span className="font-semibold text-gh-text">{(content.length / 1024).toFixed(1)}</span> KB</span>
          </div>
          <button
            className="flex items-center gap-1.5 text-xs text-gh-muted hover:text-gh-text px-2 py-1 border border-gh-border rounded-md hover:bg-gh-bg transition-colors"
            onClick={copy}
          >
            <CopyIcon />
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>

        {/* Delegated to the registered viewer */}
        <Viewer content={content} path={path} filename={filename} gitRef={ref} />
      </div>
    </div>
  );
}
