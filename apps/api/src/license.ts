import { defaultBranch, listTree, readFileAtBranch, resolveBranchSha } from "./git-utils.js";

/** A best-effort license detection result. Display-only — no enforcement (#112). */
export type DetectedLicense = { spdxId: string; path: string };

// Top-level filenames (case-insensitive) that hold a repo's license text.
const LICENSE_FILENAMES = new Set([
  "license",
  "license.md",
  "license.txt",
  "licence",
  "licence.md",
  "licence.txt",
  "copying",
  "copying.md",
  "copying.txt",
  "unlicense",
]);

/**
 * Best-effort SPDX id from a license file's text. A small, ordered keyword table
 * (v0) — good enough to power the header chip, never authoritative. Returns null
 * when nothing recognizable matches (e.g. a custom/proprietary license). Order
 * matters: the more specific families are checked before the looser ones.
 */
export function matchSpdx(text: string): string | null {
  // Collapse whitespace so multi-line phrases match regardless of wrapping.
  const t = text.replace(/\s+/g, " ").trim();
  const has = (re: RegExp) => re.test(t);

  if (has(/apache license/i) && has(/version 2\.0/i)) return "Apache-2.0";
  if (has(/mozilla public license/i) && has(/version 2\.0/i)) return "MPL-2.0";

  if (has(/gnu general public license/i)) {
    if (has(/version 3/i)) return "GPL-3.0";
    if (has(/version 2/i)) return "GPL-2.0";
  }

  if (has(/redistribution and use in source and binary forms/i)) {
    // The 3-clause variant adds the "no endorsement" clause; the 2-clause omits it.
    return has(/neither the name of/i) ? "BSD-3-Clause" : "BSD-2-Clause";
  }

  if (has(/this is free and unencumbered software released into the public domain/i) || has(/unlicense/i)) {
    return "Unlicense";
  }

  // MIT's distinctive grant, or a bare "MIT License" header (common truncated form).
  if (has(/permission is hereby granted, free of charge/i) || has(/\bMIT License\b/i)) {
    return "MIT";
  }

  // ISC — checked after MIT since both share a "Permission to use" style grant.
  if (has(/ISC License/i) || has(/permission to use, copy, modify, and\/or distribute this software/i)) {
    return "ISC";
  }

  return null;
}

// Cache per repo + head sha. The composition/license of a fixed commit never
// changes, so a bounded in-memory map is safe and cheap across requests.
const cache = new Map<string, DetectedLicense | null>();

/** Test hook: drop cached detections. */
export function __resetLicenseCache(): void {
  cache.clear();
}

/**
 * Detect the license at a repo's default branch (or an explicit ref): find a
 * top-level LICENSE/COPYING file and best-effort match it to an SPDX id. Fully
 * defensive — any git/read failure yields null so the repo payload never fails
 * over license detection. Cached per repo + head sha.
 */
export async function detectRepoLicense(
  storageKey: string | null,
  ref?: string,
): Promise<DetectedLicense | null> {
  if (!storageKey) return null;
  try {
    const branch = ref ?? (await defaultBranch(storageKey));
    const sha = await resolveBranchSha(storageKey, branch);
    if (!sha) return null;

    const key = `${storageKey}@${sha}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const entries = await listTree(storageKey, sha, "");
    const entry = Array.isArray(entries)
      ? entries.find((e) => e.type === "blob" && LICENSE_FILENAMES.has(e.name.toLowerCase()))
      : undefined;
    if (!entry) {
      cache.set(key, null);
      return null;
    }

    const content = await readFileAtBranch(storageKey, sha, entry.path);
    const spdxId = content ? matchSpdx(content) : null;
    const result = spdxId ? { spdxId, path: entry.path } : null;
    cache.set(key, result);
    return result;
  } catch {
    return null;
  }
}
