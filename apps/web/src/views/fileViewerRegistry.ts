import type { FileViewerComponent } from "./fileViewerTypes";
import { CodeViewer } from "./viewers/CodeViewer";
import { FallbackFileViewer } from "./viewers/FallbackFileViewer";
import { MarkdownFileViewer } from "./viewers/MarkdownFileViewer";

const registry = new Map<string, FileViewerComponent>();

export function registerFileViewer(extensions: string[], component: FileViewerComponent): void {
  for (const ext of extensions) {
    registry.set(ext.toLowerCase(), component);
  }
}

export function resolveFileViewer(filename: string): FileViewerComponent {
  const parts = filename.split(".");
  // No extension (e.g. Dockerfile, Makefile) — use the lowercased full name as key
  const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : filename.toLowerCase();
  return registry.get(ext) ?? CodeViewer; // unknown text files fall back to CodeViewer
}

// ─── default registrations ───────────────────────────────────────────────────

registerFileViewer(
  [
    "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "py", "pyi", "rb", "php", "java", "kt", "swift", "dart",
    "rs", "go", "c", "cpp", "cc", "h", "hpp",
    "cs", "fs", "fsx", "ex", "exs", "erl", "hs",
    "css", "scss", "sass", "less",
    "html", "htm", "xml", "svg",
    "json", "jsonc", "json5",
    "yaml", "yml", "toml", "ini", "env",
    "sh", "bash", "zsh", "fish", "ps1",
    "sql", "graphql", "gql",
    "lua", "vim", "tf", "hcl", "nix",
    // common extensionless files by their full name
    "dockerfile", "makefile", "procfile", "vagrantfile",
    "gemfile", "rakefile", "brewfile", "podfile",
    "gitignore", "gitattributes", "editorconfig",
  ],
  CodeViewer,
);

registerFileViewer(["md", "markdown", "mdx"], MarkdownFileViewer);

// Explicit binary types get the fallback (no garbled content shown)
registerFileViewer(
  ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff"],
  FallbackFileViewer,
);
registerFileViewer(
  ["zip", "tar", "gz", "bz2", "7z", "rar", "wasm"],
  FallbackFileViewer,
);
