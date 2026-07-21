import { extname } from "node:path";
import { activeFormatsAtCommit, defaultBranch, listBlobSizes, resolveBranchSha, type BlobSize } from "./git-utils.js";
import { officialFormats } from "./fhr/manifest.js";
import { GLTF_SCENE_HANDLER_ID, PLAIN_TEXT_HANDLER_ID } from "./handlers/types.js";

// ForgeHub's answer to GitHub's language bar: bin a repo's bytes by artifact
// FORMAT/DOMAIN rather than programming language. Formats the repo opted into
// semantic handling (`.forge/formats`) that the FHR manifest maps to an official
// handler are grouped by that handler's *domain* (e.g. all opted-in .gltf/.glb →
// one "glTF scene" segment, flagged optedIn) — the visible payoff of the FHR
// premise. Everything else falls back to its extension, with a long tail folded
// into "Other".

/** One slice of the composition bar. `optedIn` = semantic diffing is on for it. */
export type CompositionSegment = {
  /** Stable key for deterministic client coloring: handler id, ".ext", or "other". */
  format: string;
  label: string;
  bytes: number;
  fileCount: number;
  /** Share of total bytes, 0–100, one decimal. */
  pct: number;
  optedIn: boolean;
};

export type Composition = {
  ref: string;
  sha: string;
  totalBytes: number;
  totalFiles: number;
  segments: CompositionSegment[];
};

// Human labels for the two official handler domains. Unknown ids get a
// prettified fallback so a future handler still reads sensibly.
const HANDLER_LABELS: Record<string, string> = {
  [GLTF_SCENE_HANDLER_ID]: "glTF scene",
  [PLAIN_TEXT_HANDLER_ID]: "Plain text",
};

function handlerLabel(id: string): string {
  return HANDLER_LABELS[id] ?? id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// A pragmatic friendly-name map for common extensions. Not authoritative (that's
// the manifest's job for semantic formats) — just nicer legend labels.
const EXT_LABELS: Record<string, string> = {
  ".md": "Markdown", ".markdown": "Markdown", ".mdx": "Markdown", ".rst": "reStructuredText", ".adoc": "AsciiDoc",
  ".txt": "Text", ".json": "JSON", ".jsonc": "JSON", ".geojson": "GeoJSON",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript",
  ".css": "CSS", ".scss": "Sass", ".sass": "Sass", ".less": "Less",
  ".html": "HTML", ".htm": "HTML", ".svg": "SVG", ".xml": "XML",
  ".py": "Python", ".rb": "Ruby", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
  ".c": "C", ".h": "C", ".cpp": "C++", ".cc": "C++", ".hpp": "C++", ".cs": "C#", ".php": "PHP", ".swift": "Swift",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
  ".yml": "YAML", ".yaml": "YAML", ".toml": "TOML", ".ini": "INI", ".cfg": "Config",
  ".csv": "CSV", ".tsv": "TSV", ".sql": "SQL", ".graphql": "GraphQL", ".proto": "Protocol Buffers",
  ".gltf": "glTF", ".glb": "glTF", ".stl": "STL", ".obj": "OBJ", ".ply": "PLY", ".fbx": "FBX",
  ".step": "STEP", ".stp": "STEP", ".iges": "IGES", ".igs": "IGES", ".3mf": "3MF", ".dae": "COLLADA", ".usd": "USD", ".usdz": "USD",
  ".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".gif": "GIF", ".webp": "WebP", ".ico": "Icon",
  ".wasm": "WebAssembly", ".lock": "Lockfile",
};

function extLabel(ext: string): string {
  if (!ext) return "Other";
  return EXT_LABELS[ext] ?? ext.replace(/^\./, "").toUpperCase();
}

// Long-tail folding: never hide an opted-in segment; fold small/leftover
// non-opted segments into "Other" so the bar reads as an identity, not a rainbow.
const MIN_PCT = 1.0;
const MAX_SEGMENTS = 10;

type Agg = { format: string; label: string; bytes: number; fileCount: number; optedIn: boolean };

/**
 * Pure composition math over a list of blob sizes. Exposed for unit testing;
 * `getComposition` wraps it with the git + manifest lookups. `official` maps a
 * lowercased extension (".gltf") to its handler id; `activeExts` is the repo's
 * `.forge/formats` opt-in set.
 */
export function buildComposition(
  blobs: BlobSize[],
  activeExts: Set<string>,
  official: Map<string, string>,
): Pick<Composition, "totalBytes" | "totalFiles" | "segments"> {
  const groups = new Map<string, Agg>();
  let totalBytes = 0;

  for (const { path, size } of blobs) {
    totalBytes += size;
    const ext = extname(path).toLowerCase();
    const opted = ext !== "" && activeExts.has(ext);
    const handlerId = ext ? official.get(ext) : undefined;

    let format: string;
    let label: string;
    let optedIn: boolean;
    if (opted && handlerId) {
      // Opted-in AND officially handled → group by semantic domain.
      format = handlerId;
      label = handlerLabel(handlerId);
      optedIn = true;
    } else {
      format = ext || "other";
      label = extLabel(ext);
      optedIn = opted; // opted-in but no official handler is still marked
    }

    const g = groups.get(format) ?? { format, label, bytes: 0, fileCount: 0, optedIn };
    g.bytes += size;
    g.fileCount += 1;
    g.optedIn = g.optedIn || optedIn;
    groups.set(format, g);
  }

  const totalFiles = blobs.length;
  const safeTotal = totalBytes > 0 ? totalBytes : 1;
  const round1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;

  const all = [...groups.values()].sort((a, b) => b.bytes - a.bytes);

  // Keep every opted-in segment; keep the biggest non-opted ones; fold the rest.
  const kept: Agg[] = [];
  let otherBytes = 0;
  let otherFiles = 0;
  for (const g of all) {
    const pct = (g.bytes / safeTotal) * 100;
    const keepForSize = kept.filter((k) => !k.optedIn).length < MAX_SEGMENTS && pct >= MIN_PCT && g.format !== "other";
    if (g.optedIn || keepForSize) {
      kept.push(g);
    } else {
      otherBytes += g.bytes;
      otherFiles += g.fileCount;
    }
  }

  const segments: CompositionSegment[] = kept.map((g) => ({
    format: g.format,
    label: g.label,
    bytes: g.bytes,
    fileCount: g.fileCount,
    pct: round1((g.bytes / safeTotal) * 100),
    optedIn: g.optedIn,
  }));

  if (otherBytes > 0) {
    segments.push({
      format: "other",
      label: "Other",
      bytes: otherBytes,
      fileCount: otherFiles,
      pct: round1((otherBytes / safeTotal) * 100),
      optedIn: false,
    });
  }

  return { totalBytes, totalFiles, segments };
}

// Composition of a fixed commit never changes → cache per repo + head sha.
const cache = new Map<string, Composition>();

/** Test hook: drop cached compositions. */
export function __resetCompositionCache(): void {
  cache.clear();
}

/**
 * Compute the format composition at a repo's default branch (or an explicit
 * ref). Returns null for an empty repo / unresolvable ref. The manifest lookup
 * is best-effort: if it's unreachable, opted-in formats simply fall back to
 * their extension label (still flagged optedIn), so the bar never fails over the
 * network.
 */
export async function getComposition(storageKey: string, ref?: string): Promise<Composition | null> {
  const branch = ref ?? (await defaultBranch(storageKey));
  const sha = await resolveBranchSha(storageKey, branch);
  if (!sha) return null;

  const key = `${storageKey}@${sha}`;
  const cached = cache.get(key);
  if (cached) return { ...cached, ref: branch };

  const [blobs, activeExts, official] = await Promise.all([
    listBlobSizes(storageKey, sha),
    activeFormatsAtCommit(storageKey, sha),
    officialFormats().catch(() => new Map<string, string>()),
  ]);

  const comp: Composition = { ref: branch, sha, ...buildComposition(blobs, activeExts, official) };
  cache.set(key, comp);
  return comp;
}
