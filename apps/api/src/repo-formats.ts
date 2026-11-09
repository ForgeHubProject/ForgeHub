import { execFile as execFileCb } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import { officialFormats } from "./fhr/manifest.js";
import { bareRepoPathFromKey } from "./git-storage.js";
import { prisma } from "./prisma.js";
import { ident } from "./sql.js";

const execFile = promisify(execFileCb);

/**
 * Explore's format filter (#257): the families it offers, as official FHR
 * handler ids. A repo matches a family when its default branch holds any of them.
 */
export const FORMAT_FAMILIES: Record<string, string[]> = {
  psd: ["psd"],
  figcraft: ["figcraft"],
  "3d": ["gltf-scene", "obj", "stl", "ply", "3mf", "off", "dae", "x3d", "fbx", "usd", "3ds", "blend", "amf", "vrml"],
  cad: ["dxf"],
  images: ["png", "jpeg", "gif", "svg"],
  data: ["csv", "geojson"],
  notebooks: ["ipynb"],
  audio: ["wav"],
};

// Config formats every code repo carries; they say nothing about what a repo is.
const GENERIC = new Set(["json", "toml"]);

/** The official formats on a bare repo's default branch, most files first. */
export async function scanRepoFormats(repoPath: string): Promise<string[]> {
  let listing: string;
  try {
    ({ stdout: listing } = await execFile("git", ["ls-tree", "-r", "-z", "--name-only", "HEAD"], {
      cwd: repoPath,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch {
    return []; // empty repo: no HEAD yet
  }
  const byExt = await officialFormats();
  const counts = new Map<string, number>();
  for (const file of listing.split("\0")) {
    const id = file && byExt.get(extname(file).toLowerCase());
    if (id && !GENERIC.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

export function parseFormats(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Scan the repos whose formats are unknown (never scanned, or pushed to since),
 * a batch at a time so one request never walks the whole instance.
 */
export async function fillMissingFormats(where: object, batch = 50): Promise<void> {
  const repos = await prisma.repo.findMany({
    where: { ...where, formats: null, storageKey: { not: null } },
    select: { id: true, storageKey: true },
    take: batch,
  });
  for (const r of repos) {
    let ids: string[];
    try {
      ids = await scanRepoFormats(bareRepoPathFromKey(r.storageKey!));
    } catch {
      ids = [];
    }
    await setFormats(r.id, JSON.stringify(ids));
  }
}

/** A push may change what a repo holds: forget its formats so the next Explore rescans. */
export async function markFormatsStale(repoId: string): Promise<void> {
  await setFormats(repoId, null);
}

// Raw SQL on purpose: a Prisma update would bump the @updatedAt column, and a
// background scan must not make every repository read "Updated just now".
async function setFormats(repoId: string, formats: string | null): Promise<void> {
  await prisma.$executeRaw`UPDATE ${ident("Repo")} SET ${ident("formats")} = ${formats} WHERE ${ident("id")} = ${repoId}`;
}
