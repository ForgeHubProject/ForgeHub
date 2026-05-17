import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBlob } from "../api";
import { highlightCode, langForFilename } from "../lib/highlight";
import { MarkdownRenderer } from "./MarkdownRenderer";

type Props = {
  token: string;
  handle: string;
  repoName: string;
  ref: string;
  path: string;
  /** e.g. "/:handle/:repoName" */
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

function RawContent({ code, lang }: { code: string; lang: string }) {
  const lines = code.split("\n");
  const highlighted = highlightCode(code, lang);
  const highlightedLines = splitHighlightedLines(highlighted);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs font-mono" style={{ lineHeight: "20px" }}>
        <tbody>
          {lines.map((_, i) => (
            <tr key={i} className="hover:bg-blue-50 group">
              <td
                className="select-none text-right text-gh-muted pr-4 pl-3 w-[1%] whitespace-nowrap border-r border-gh-border"
                style={{ userSelect: "none", minWidth: 40 }}
              >
                {i + 1}
              </td>
              <td className="pl-4 pr-4 whitespace-pre">
                <span
                  dangerouslySetInnerHTML={{
                    __html: highlightedLines[i] ?? "",
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function splitHighlightedLines(highlighted: string): string[] {
  const result: string[] = [];
  let currentLine = "";
  let depth = 0;

  const parts = highlighted.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    currentLine += (i > 0 ? "\n" : "") + part;

    const openTags = (part.match(/<span[^>]*>/g) ?? []).length;
    const closeTags = (part.match(/<\/span>/g) ?? []).length;
    depth += openTags - closeTags;

    if (depth <= 0) {
      result.push(currentLine);
      currentLine = "";
      depth = 0;
    }
  }
  if (currentLine) result.push(currentLine);
  return result;
}

export function BlobViewer({ token, handle, repoName, ref, path, repoBase }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const filename = path.split("/").pop() ?? path;
  const lang = langForFilename(filename);
  const isMarkdown = ["md", "markdown"].includes(filename.split(".").pop()?.toLowerCase() ?? "");
  const [renderMode, setRenderMode] = useState<"preview" | "raw">(isMarkdown ? "preview" : "raw");

  const pathParts = path.split("/");
  const lineCount = content?.split("\n").length ?? 0;

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

  // Breadcrumb
  const breadcrumb = (
    <div className="flex items-center gap-1 text-sm flex-wrap mb-3">
      <Link to={repoBase} className="text-gh-accent hover:underline font-medium">
        {repoName}
      </Link>
      {pathParts.map((part, i) => {
        const partPath = pathParts.slice(0, i + 1).join("/");
        return (
          <span key={i} className="flex items-center gap-1">
            <span className="text-gh-muted">/</span>
            {i === pathParts.length - 1 ? (
              <span className="font-semibold text-gh-text">{part}</span>
            ) : (
              <Link
                to={`${repoBase}/tree/${ref}/${partPath}`}
                className="text-gh-accent hover:underline"
              >
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
              <div key={i} className="h-3 bg-gray-100 rounded" style={{ width: `${60 + Math.random() * 40}%` }} />
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
        <div className="card p-8 text-center text-gh-danger">
          {error ?? "File not found"}
        </div>
      </div>
    );
  }

  return (
    <div>
      {breadcrumb}
      <div className="card overflow-hidden">
        {/* File header */}
        <div className="flex items-center justify-between px-4 py-2 bg-gh-bg border-b border-gh-border">
          <div className="flex items-center gap-3 text-xs text-gh-muted">
            <span><span className="font-semibold text-gh-text">{lineCount}</span> lines</span>
            <span><span className="font-semibold text-gh-text">{(content.length / 1024).toFixed(1)}</span> KB</span>
          </div>
          <div className="flex items-center gap-2">
            {isMarkdown && (
              <div className="flex items-center border border-gh-border rounded-md overflow-hidden text-xs">
                <button
                  className={`px-2 py-1 transition-colors ${renderMode === "preview" ? "bg-gh-accent text-white" : "text-gh-muted hover:bg-gh-bg"}`}
                  onClick={() => setRenderMode("preview")}
                >
                  Preview
                </button>
                <button
                  className={`px-2 py-1 transition-colors ${renderMode === "raw" ? "bg-gh-accent text-white" : "text-gh-muted hover:bg-gh-bg"}`}
                  onClick={() => setRenderMode("raw")}
                >
                  Raw
                </button>
              </div>
            )}
            <button
              className="flex items-center gap-1.5 text-xs text-gh-muted hover:text-gh-text px-2 py-1 border border-gh-border rounded-md hover:bg-gh-bg transition-colors"
              onClick={copy}
            >
              <CopyIcon />
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        {/* Content */}
        {isMarkdown && renderMode === "preview" ? (
          <div className="px-8 py-6">
            <MarkdownRenderer content={content} />
          </div>
        ) : (
          <RawContent code={content} lang={lang} />
        )}
      </div>
    </div>
  );
}
