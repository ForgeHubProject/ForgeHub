import type { FileViewerComponent } from "./fileViewerTypes";
import { CodeViewer } from "./viewers/CodeViewer";
import { FallbackFileViewer } from "./viewers/FallbackFileViewer";
import { FhrFileViewer } from "./viewers/FhrFileViewer";
import { MarkdownFileViewer } from "./viewers/MarkdownFileViewer";

const registry = new Map<string, FileViewerComponent>();

export function registerFileViewer(extensions: string[], component: FileViewerComponent): void {
  for (const ext of extensions) {
    registry.set(ext.toLowerCase(), component);
  }
}

/** The registry key for a filename: its extension, or the whole name when extensionless. */
function extensionKey(filename: string): string {
  const parts = filename.split(".");
  // No extension (e.g. Dockerfile, Makefile) — use the lowercased full name as key
  return parts.length > 1 ? parts.pop()!.toLowerCase() : filename.toLowerCase();
}

/**
 * Does the FHR manifest advertise a semantic handler for this file? Mirrors the
 * diff registry's precedence rule: manifest knowledge beats any static
 * registration. Exposed so BlobViewer can also skip its text fetch — decoding
 * model bytes as a string is the failure this viewer exists to end.
 */
export function isSemanticFilename(filename: string, semanticExtensions: ReadonlySet<string>): boolean {
  return semanticExtensions.has(extensionKey(filename));
}

export function resolveFileViewer(
  filename: string,
  semanticExtensions?: ReadonlySet<string>,
): FileViewerComponent {
  if (semanticExtensions && isSemanticFilename(filename, semanticExtensions)) return FhrFileViewer;
  return registry.get(extensionKey(filename)) ?? CodeViewer; // unknown text files fall back to CodeViewer
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
// .glb is a binary container — if the FHR manifest is unavailable (semantic
// routing above never engages), the fallback card is the honest floor, never
// the bytes decoded as text. .gltf stays with CodeViewer: it is JSON.
registerFileViewer(["glb"], FallbackFileViewer);
