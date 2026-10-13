import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import plaintext from "highlight.js/lib/languages/plaintext";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("svg", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("txt", plaintext);

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", go: "go", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  json: "json", yaml: "yaml", yml: "yaml",
  html: "html", htm: "html", xml: "xml", svg: "xml",
  css: "css", scss: "css", sass: "css",
  sh: "bash", bash: "bash", zsh: "bash",
  md: "markdown", markdown: "markdown",
  txt: "plaintext", "": "plaintext",
};

export function langForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

export function highlightCode(code: string, lang: string): string {
  try {
    if (hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Split highlight.js output into one HTML string per source line, so line N of
 * the file is always entry N. A token that spans lines (a multi-line string or
 * comment) is closed at the end of each line and reopened at the start of the
 * next, so every line's HTML stands on its own and no line starts with the
 * previous one's newline.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = []; // the <span …> tags still open, outermost first
  let line = "";
  // highlight.js escapes the code, so "<" only ever starts a tag here.
  const token = /<span[^>]*>|<\/span>|\n|[^<\n]+|</g;
  for (const m of html.matchAll(token)) {
    const t = m[0];
    if (t === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (t.startsWith("<span")) {
      open.push(t);
      line += t;
    } else if (t === "</span>") {
      open.pop();
      line += t;
    } else {
      line += t;
    }
  }
  lines.push(line + "</span>".repeat(open.length));
  return lines;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { hljs };
