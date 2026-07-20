import type { FileDiffViewerComponent } from "./fileDiffViewerTypes";
import { FallbackFileDiffViewer } from "./diffViewers/FallbackFileDiffViewer";
import { TextFileDiffViewer } from "./diffViewers/TextFileDiffViewer";
import { FhrFileDiffViewer } from "./diffViewers/FhrFileDiffViewer";

const registry = new Map<string, FileDiffViewerComponent>();

export function registerFileDiffViewer(extensions: string[], component: FileDiffViewerComponent): void {
  for (const ext of extensions) {
    registry.set(ext.toLowerCase(), component);
  }
}

/**
 * Routing key for a filename: the lowercased extension, or — for extensionless
 * files (Dockerfile, Makefile) — the lowercased full name.
 */
export function extensionForFilename(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : filename.toLowerCase();
}

/**
 * The viewer a file would use with NO semantic (FHR) support: its registered
 * text/binary viewer, or TextFileDiffViewer by default. This is both the routing
 * result for non-semantic files and the graceful fallback the FhrFileDiffViewer
 * renders when a repo hasn't opted a format in (404 from /filediff).
 */
export function resolveBaseFileDiffViewer(filename: string): FileDiffViewerComponent {
  return registry.get(extensionForFilename(filename)) ?? TextFileDiffViewer;
}

/**
 * Resolve the viewer for a file. ForgeHub holds NO per-format knowledge of its
 * own: the set of semantic extensions comes solely from the FHR manifest (via
 * the API), passed in as `semanticExtensions` (lowercase, no leading dot — see
 * useSemanticExtensions). A file whose extension is semantic gets the
 * manifest-driven FhrFileDiffViewer, which takes precedence over any text/binary
 * registration; every other file keeps its base viewer.
 *
 * When the set is empty or omitted (manifest still loading, or unavailable),
 * every file resolves to its base viewer, so the UI never blocks or crashes —
 * semantic viewers appear on the next render once the set is known.
 */
export function resolveFileDiffViewer(
  filename: string,
  semanticExtensions?: ReadonlySet<string>,
): FileDiffViewerComponent {
  if (semanticExtensions?.has(extensionForFilename(filename))) {
    return FhrFileDiffViewer;
  }
  return resolveBaseFileDiffViewer(filename);
}

// ─── default registrations (base viewers only) ─────────────────────────────────
// NOTE: no semantic-format list lives here. Which extensions have a rich diff is
// decided entirely by the FHR manifest (API /fhr/formats), never hardcoded.

registerFileDiffViewer(
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
    "md", "markdown", "mdx", "txt", "rst",
    // common extensionless files by their full name
    "dockerfile", "makefile", "procfile", "vagrantfile",
    "gemfile", "rakefile", "brewfile", "podfile",
    "gitignore", "gitattributes", "editorconfig",
  ],
  TextFileDiffViewer,
);

// Explicit binary types get the fallback (no garbled content shown)
registerFileDiffViewer(
  ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff"],
  FallbackFileDiffViewer,
);
registerFileDiffViewer(
  ["zip", "tar", "gz", "bz2", "7z", "rar", "wasm"],
  FallbackFileDiffViewer,
);
