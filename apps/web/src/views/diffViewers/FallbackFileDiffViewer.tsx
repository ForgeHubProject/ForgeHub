import type { FileDiffViewerProps } from "../fileDiffViewerTypes";

export function FallbackFileDiffViewer({ file }: FileDiffViewerProps) {
  const path = file.status === "deleted" ? file.oldPath : file.newPath;
  const ext = path.includes(".") ? `.${path.split(".").pop()}` : path;
  const extName = ext.replace(/^\./, "");
  return (
    <div className="px-4 py-3 text-sm text-gh-muted italic">
      No diff viewer registered for <code className="bg-gh-bg border border-gh-border px-1 py-0.5 rounded text-xs">{ext}</code> files.
      {" "}Register one with <code className="text-gh-accent text-xs">registerFileDiffViewer([&quot;{extName}&quot;], YourViewer)</code>
    </div>
  );
}
