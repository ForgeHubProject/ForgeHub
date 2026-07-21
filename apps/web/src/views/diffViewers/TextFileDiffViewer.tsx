import { Fragment } from "react";
import type { FileDiffViewerProps } from "../fileDiffViewerTypes";

export function TextFileDiffViewer({ file }: FileDiffViewerProps) {
  if (file.binary) {
    return <p className="px-4 py-3 text-sm text-fh-fg-muted italic">Binary file changed</p>;
  }

  if (file.hunks.length === 0) {
    return <p className="px-4 py-3 text-sm text-fh-fg-muted italic">No textual changes</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
        <tbody>
          {file.hunks.map((hunk, hi) => (
            <Fragment key={`h${hi}`}>
              <tr className="bg-fh-accent-muted">
                <td className="select-none px-2 py-0.5 text-right border-r border-fh-border text-fh-fg-subtle" style={{ width: 40 }} />
                <td className="select-none px-2 py-0.5 text-right border-r border-fh-border text-fh-fg-subtle" style={{ width: 40 }} />
                <td className="px-3 py-0.5 text-fh-accent-fg">{hunk.header}</td>
              </tr>
              {hunk.lines.map((line, li) => {
                const rowBg =
                  line.type === "add" ? "bg-fh-success-muted"
                  : line.type === "remove" ? "bg-fh-danger-muted"
                  : "";
                const rowFg =
                  line.type === "add" ? "text-fh-success-fg"
                  : line.type === "remove" ? "text-fh-danger-fg"
                  : "text-fh-fg";
                const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
                return (
                  <tr key={`${hi}-${li}`} className={rowBg}>
                    <td className="select-none text-right px-2 py-0 border-r border-fh-border text-fh-fg-subtle" style={{ width: 40, minWidth: 40 }}>
                      {line.oldLineNo ?? ""}
                    </td>
                    <td className="select-none text-right px-2 py-0 border-r border-fh-border text-fh-fg-subtle" style={{ width: 40, minWidth: 40 }}>
                      {line.newLineNo ?? ""}
                    </td>
                    <td className={`pl-2 pr-4 whitespace-pre ${rowFg}`}>
                      <span className="select-none mr-2" style={{ opacity: 0.7 }}>{prefix}</span>
                      {line.content}
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
