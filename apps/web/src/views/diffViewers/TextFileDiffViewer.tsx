import type { FileDiffViewerProps } from "../fileDiffViewerTypes";

export function TextFileDiffViewer({ file }: FileDiffViewerProps) {
  if (file.binary) {
    return <p className="px-4 py-3 text-sm text-gh-muted italic">Binary file changed</p>;
  }

  if (file.hunks.length === 0) {
    return <p className="px-4 py-3 text-sm text-gh-muted italic">No textual changes</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
        <tbody>
          {file.hunks.map((hunk, hi) => (
            <>
              <tr key={`h${hi}`} style={{ backgroundColor: "#eaf5ff" }}>
                <td className="select-none px-2 py-0.5 text-right border-r" style={{ color: "#57606a", borderColor: "#d0d7de", width: 40 }} />
                <td className="select-none px-2 py-0.5 text-right border-r" style={{ color: "#57606a", borderColor: "#d0d7de", width: 40 }} />
                <td className="px-3 py-0.5" style={{ color: "#ea580c" }}>{hunk.header}</td>
              </tr>
              {hunk.lines.map((line, li) => {
                const bg = line.type === "add" ? "#e6ffec" : line.type === "remove" ? "#ffebe9" : "#ffffff";
                const fg = line.type === "add" ? "#1a7f37" : line.type === "remove" ? "#cf222e" : "#1f2328";
                const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
                return (
                  <tr key={`${hi}-${li}`} style={{ backgroundColor: bg }}>
                    <td className="select-none text-right px-2 py-0 border-r" style={{ color: "#57606a", borderColor: "#d0d7de", width: 40, minWidth: 40 }}>
                      {line.oldLineNo ?? ""}
                    </td>
                    <td className="select-none text-right px-2 py-0 border-r" style={{ color: "#57606a", borderColor: "#d0d7de", width: 40, minWidth: 40 }}>
                      {line.newLineNo ?? ""}
                    </td>
                    <td className="pl-2 pr-4 whitespace-pre" style={{ color: fg }}>
                      <span className="select-none mr-2" style={{ opacity: 0.7 }}>{prefix}</span>
                      {line.content}
                    </td>
                  </tr>
                );
              })}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
