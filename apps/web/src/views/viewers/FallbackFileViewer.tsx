import type { FileViewerProps } from "../fileViewerTypes";

export function FallbackFileViewer({ filename }: FileViewerProps) {
  const ext = filename.includes(".") ? `.${filename.split(".").pop()}` : filename;
  return (
    <div className="p-12 text-center text-gh-muted">
      <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor" className="mx-auto mb-3 opacity-30">
        <path fillRule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z" />
      </svg>
      <p className="text-sm font-medium text-gh-text">
        No viewer registered for <code className="bg-gh-bg border border-gh-border px-1.5 py-0.5 rounded text-xs">{ext}</code> files
      </p>
      <p className="text-xs mt-1.5">Call <code className="text-gh-accent">registerFileViewer(["{ext.replace(".", "")}"], YourViewer)</code> to add one.</p>
    </div>
  );
}
