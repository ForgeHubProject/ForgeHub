/**
 * Changed-file tree model for the PR files navigator (issue #119). Pure data +
 * helpers (no React, no DOM) so the shaping — nesting, dirs-first ordering, and
 * single-child directory-chain compression ("src/components" as one row, the
 * GitHub anatomy) — is unit-testable in the node test env.
 */

export type FileTreeFile<T> = {
  kind: "file";
  /** Display name (basename, or the compressed tail). */
  name: string;
  /** Full repo-relative path. */
  path: string;
  entry: T;
};

export type FileTreeDir<T> = {
  kind: "dir";
  /** Display name — may span compressed segments, e.g. "src/components". */
  name: string;
  path: string;
  dirs: FileTreeDir<T>[];
  files: FileTreeFile<T>[];
};

export type FileTree<T> = { dirs: FileTreeDir<T>[]; files: FileTreeFile<T>[] };

/**
 * Build the nested tree for a flat changed-file list. Directories sort before
 * files, both alphabetically; a directory whose only content is one child
 * directory is compressed into it so deep single-branch paths stay one row.
 */
export function buildFileTree<T extends { path: string }>(entries: T[]): FileTree<T> {
  const root: FileTreeDir<T> = { kind: "dir", name: "", path: "", dirs: [], files: [] };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const path = segments.slice(0, i + 1).join("/");
      let next = node.dirs.find((d) => d.path === path);
      if (!next) {
        next = { kind: "dir", name: seg, path, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push({ kind: "file", name: segments[segments.length - 1], path: entry.path, entry });
  }

  compress(root);
  sortDir(root);
  return { dirs: root.dirs, files: root.files };
}

/** Fold every dir with exactly one child dir and no files into that child. */
function compress<T>(dir: FileTreeDir<T>): void {
  dir.dirs = dir.dirs.map(compressChain);
  for (const d of dir.dirs) compress(d);
}

function compressChain<T>(dir: FileTreeDir<T>): FileTreeDir<T> {
  let node = dir;
  let name = dir.name;
  while (node.dirs.length === 1 && node.files.length === 0) {
    node = node.dirs[0];
    name = `${name}/${node.name}`;
  }
  return node === dir ? dir : { ...node, name };
}

function sortDir<T>(dir: FileTreeDir<T>): void {
  dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
  dir.files.sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dir.dirs) sortDir(d);
}

/** Total file count under a directory (for the collapsed-row badge). */
export function countFiles<T>(dir: FileTreeDir<T>): number {
  return dir.files.length + dir.dirs.reduce((sum, d) => sum + countFiles(d), 0);
}

/** DOM id a file card anchors on, so the tree can scroll the card into view. */
export function fileAnchorId(path: string): string {
  // Encode into a stable, selector-safe id (btoa-free — paths may be non-ASCII).
  return `pr-file-${path.replace(/[^a-zA-Z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;
}
