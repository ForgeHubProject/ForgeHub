import { highlightCode, langForFilename } from "../../lib/highlight";
import type { FileViewerProps } from "../fileViewerTypes";

function splitHighlightedLines(highlighted: string): string[] {
  const result: string[] = [];
  let currentLine = "";
  let depth = 0;
  const parts = highlighted.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    currentLine += (i > 0 ? "\n" : "") + part;
    depth += (part.match(/<span[^>]*>/g) ?? []).length;
    depth -= (part.match(/<\/span>/g) ?? []).length;
    if (depth <= 0) {
      result.push(currentLine);
      currentLine = "";
      depth = 0;
    }
  }
  if (currentLine) result.push(currentLine);
  return result;
}

export function CodeViewer({ content, filename }: FileViewerProps) {
  const lang = langForFilename(filename);
  const lines = content.split("\n");
  const highlighted = highlightCode(content, lang);
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
                <span dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? "" }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
