import { useState } from "react";
import { MarkdownRenderer } from "../../components/MarkdownRenderer";
import type { FileViewerProps } from "../fileViewerTypes";
import { CodeViewer } from "./CodeViewer";

export function MarkdownFileViewer(props: FileViewerProps) {
  const [mode, setMode] = useState<"preview" | "raw">("preview");

  return (
    <div>
      <div className="flex items-center justify-end px-4 py-2 bg-gh-bg border-b border-gh-border">
        <div className="flex items-center border border-gh-border rounded-md overflow-hidden text-xs">
          <button
            className={`px-2 py-1 transition-colors ${mode === "preview" ? "bg-gh-accent text-white" : "text-gh-muted hover:bg-gh-bg"}`}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
          <button
            className={`px-2 py-1 transition-colors ${mode === "raw" ? "bg-gh-accent text-white" : "text-gh-muted hover:bg-gh-bg"}`}
            onClick={() => setMode("raw")}
          >
            Raw
          </button>
        </div>
      </div>
      {mode === "preview" ? (
        <div className="px-8 py-6">
          <MarkdownRenderer content={props.content} />
        </div>
      ) : (
        <CodeViewer {...props} />
      )}
    </div>
  );
}
