import type { FileDiffViewerComponent } from "./fileDiffViewerTypes";
import { FallbackFileDiffViewer } from "./diffViewers/FallbackFileDiffViewer";
import { TextFileDiffViewer } from "./diffViewers/TextFileDiffViewer";
import { SceneFileDiffViewer } from "./diffViewers/SceneFileDiffViewer";

const registry = new Map<string, FileDiffViewerComponent>();

export function registerFileDiffViewer(extensions: string[], component: FileDiffViewerComponent): void {
  for (const ext of extensions) {
    registry.set(ext.toLowerCase(), component);
  }
}

export function resolveFileDiffViewer(filename: string): FileDiffViewerComponent {
  const parts = filename.split(".");
  // No extension (e.g. Dockerfile, Makefile) — use the lowercased full name as key
  const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : filename.toLowerCase();
  return registry.get(ext) ?? TextFileDiffViewer;
}

// ─── default registrations ───────────────────────────────────────────────────

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
// glTF/GLB get a format-aware change tree from the FHR renderer bundle,
// falling back gracefully to a message if the repo hasn't opted the format in.
registerFileDiffViewer(["glb", "gltf"], SceneFileDiffViewer);
