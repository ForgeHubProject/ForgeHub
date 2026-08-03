import { describe, it, expect } from "vitest";
import {
  TIER_B_MAX_BLOB_BYTES,
  abbreviateRev,
  assessBrowserTier,
  browserDownloadLabel,
  browserWasmSupported,
  buildMismatch,
  clearTierPreference,
  forgeDiffCommand,
  formatBytes,
  getGlobalTierPreference,
  getTierPreference,
  isComputeTier,
  listTierPreferences,
  needsFileDiffMeta,
  resolveTierPreference,
  setGlobalTierPreference,
  setTierPreference,
  type EnumerableTierStorage,
} from "../lib/computeTier";
import type { FileDiffMeta } from "../api";

// A Map-backed Storage stand-in — these tests run in a node environment.
function fakeStorage(): EnumerableTierStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
  };
}

const meta = (over: Partial<FileDiffMeta> = {}): FileDiffMeta => ({
  handlerId: "gltf-scene",
  path: "scene/model.gltf",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseSize: 2 * 1024 * 1024,
  headSize: 2 * 1024 * 1024,
  wasmAvailable: true,
  officialBuild: "e520cc6",
  pinnedBuild: null,
  ...over,
});

describe("isComputeTier", () => {
  it("accepts exactly the three tiers", () => {
    expect(isComputeTier("server")).toBe(true);
    expect(isComputeTier("browser")).toBe(true);
    expect(isComputeTier("local")).toBe(true);
    expect(isComputeTier("edge")).toBe(false);
    expect(isComputeTier(null)).toBe(false);
  });
});

describe("sticky preferences (per-format + global)", () => {
  it("defaults to Tier S — the canonical tier — with nothing stored", () => {
    const s = fakeStorage();
    expect(resolveTierPreference("gltf", s)).toBe("server");
    expect(getTierPreference("gltf", s)).toBeNull();
    expect(getGlobalTierPreference(s)).toBeNull();
  });

  it("persists and resolves a per-format choice", () => {
    const s = fakeStorage();
    setTierPreference("gltf", "browser", s);
    expect(resolveTierPreference("gltf", s)).toBe("browser");
    // other formats are unaffected
    expect(resolveTierPreference("stl", s)).toBe("server");
  });

  it("falls back to the global setting when the format has no choice", () => {
    const s = fakeStorage();
    setGlobalTierPreference("local", s);
    expect(resolveTierPreference("gltf", s)).toBe("local");
  });

  it("lets a per-format choice override the global setting", () => {
    const s = fakeStorage();
    setGlobalTierPreference("local", s);
    setTierPreference("gltf", "server", s);
    expect(resolveTierPreference("gltf", s)).toBe("server");
    expect(resolveTierPreference("stl", s)).toBe("local");
  });

  it("clears per-format and global choices independently", () => {
    const s = fakeStorage();
    setTierPreference("gltf", "browser", s);
    setGlobalTierPreference("local", s);
    clearTierPreference("gltf", s);
    expect(resolveTierPreference("gltf", s)).toBe("local");
    setGlobalTierPreference(null, s);
    expect(resolveTierPreference("gltf", s)).toBe("server");
  });

  it("ignores a corrupted stored value rather than propagating it", () => {
    const s = fakeStorage();
    s.setItem("fh.computeTier.gltf", "cloud");
    s.setItem("fh.computeTier", "42");
    expect(resolveTierPreference("gltf", s)).toBe("server");
  });

  it("normalizes the extension key case", () => {
    const s = fakeStorage();
    setTierPreference("GLTF", "browser", s);
    expect(getTierPreference("gltf", s)).toBe("browser");
  });

  it("survives a null storage (privacy mode) without throwing", () => {
    expect(resolveTierPreference("gltf", null)).toBe("server");
    expect(() => setTierPreference("gltf", "browser", null)).not.toThrow();
    expect(() => setGlobalTierPreference("local", null)).not.toThrow();
  });

  it("lists per-format choices for the settings page, sorted, skipping foreign keys", () => {
    const s = fakeStorage();
    setTierPreference("stl", "local", s);
    setTierPreference("gltf", "browser", s);
    setGlobalTierPreference("server", s); // global key is NOT a per-format row
    s.setItem("unrelated", "x");
    expect(listTierPreferences(s)).toEqual([
      { ext: "gltf", tier: "browser" },
      { ext: "stl", tier: "local" },
    ]);
  });
});

describe("assessBrowserTier (capability detection)", () => {
  it("is available with wasm support, a published build, and blobs under the ceiling", () => {
    const a = assessBrowserTier(meta(), true);
    expect(a).toEqual({ available: true, downloadBytes: 4 * 1024 * 1024 });
  });

  it("is unavailable without WebAssembly support", () => {
    const a = assessBrowserTier(meta(), false);
    expect(a.available).toBe(false);
    if (!a.available) expect(a.reason).toContain("WebAssembly");
  });

  it("is unavailable when the handler publishes no wasm build", () => {
    const a = assessBrowserTier(meta({ wasmAvailable: false }), true);
    expect(a.available).toBe(false);
    if (!a.available) expect(a.reason).toContain("gltf-scene");
  });

  // Regression (#66 P4 review): the ceiling is PER BLOB and matches the
  // server's MAX_WASM_BYTES — the browser runs the same synchronous wasm call
  // on its main thread, with no worker to kill, so it may not accept an input
  // the server refuses. A pair that only breaches when summed is still fine.
  it("is unavailable above the per-blob ceiling", () => {
    const a = assessBrowserTier(meta({ headSize: TIER_B_MAX_BLOB_BYTES + 1 }), true);
    expect(a.available).toBe(false);
    if (!a.available) expect(a.reason).toContain("too large");
  });

  it("matches the server's per-blob wasm ceiling exactly", () => {
    expect(TIER_B_MAX_BLOB_BYTES).toBe(8 * 1024 * 1024);
  });

  it("allows a pair whose combined size exceeds one blob's ceiling", () => {
    const each = TIER_B_MAX_BLOB_BYTES - 1;
    expect(assessBrowserTier(meta({ baseSize: each, headSize: each }), true)).toEqual({
      available: true,
      downloadBytes: 2 * each,
    });
  });

  it("counts a missing blob (added/deleted file) as zero bytes", () => {
    const a = assessBrowserTier(meta({ baseSize: null, headSize: 1000 }), true);
    expect(a).toEqual({ available: true, downloadBytes: 1000 });
  });

  // Regression (#66 P4 review): two null sizes used to read as a free download
  // of nothing and let the compute proceed. It is an unknown, not a zero.
  it("withholds Tier B when neither blob has a known size", () => {
    const a = assessBrowserTier(meta({ baseSize: null, headSize: null }), true);
    expect(a.available).toBe(false);
    if (!a.available) expect(a.reason).toContain("unknown");
  });

  it("browserWasmSupported probes the given scope", () => {
    expect(browserWasmSupported({})).toBe(false);
    expect(browserWasmSupported({ WebAssembly: { instantiate: () => {} } })).toBe(true);
    // this test environment (node) genuinely has wasm
    expect(browserWasmSupported()).toBe(true);
  });
});

// Regression (#66 P4 review): filediff-meta was requested at row level for
// every semantic file in a commit/PR, collapsed ones included — ~6 git spawns
// each, all concurrent, to populate a dropdown most viewers never open.
describe("needsFileDiffMeta (laziness)", () => {
  it("asks for nothing for an untouched semantic row — the default", () => {
    expect(needsFileDiffMeta({ semantic: true })).toBe(false);
  });

  it("a PR of N untouched semantic assets asks zero times", () => {
    const rows = Array.from({ length: 25 }, () => ({ semantic: true }));
    expect(rows.filter(needsFileDiffMeta)).toHaveLength(0);
  });

  it("asks once the pill is engaged", () => {
    expect(needsFileDiffMeta({ semantic: true, pillEngaged: true })).toBe(true);
  });

  it("asks when a client tier is actually rendering — it is built from meta", () => {
    expect(needsFileDiffMeta({ semantic: true, clientTierActive: true })).toBe(true);
  });

  it("asks when Tier S drags long enough for the nudge to offer alternatives", () => {
    expect(needsFileDiffMeta({ semantic: true, serverSlow: true })).toBe(true);
  });

  it("never asks for a file with no semantic handler, whatever else is true", () => {
    expect(
      needsFileDiffMeta({ semantic: false, pillEngaged: true, clientTierActive: true, serverSlow: true }),
    ).toBe(false);
  });
});

describe("honest cost disclosure", () => {
  it("formats byte counts at a human scale", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(84 * 1024 * 1024)).toBe("84 MB");
    expect(formatBytes(Math.round(1.2 * 1024 * 1024 * 1024))).toBe("1.2 GB");
  });

  it('reads "2 × 84 MB" when both blobs round to the same size', () => {
    const size = 84 * 1024 * 1024;
    expect(browserDownloadLabel(meta({ baseSize: size, headSize: size }))).toBe("downloads 2 × 84 MB");
  });

  it("lists both sizes when they differ", () => {
    expect(browserDownloadLabel(meta({ baseSize: 84 * 1024 * 1024, headSize: 91 * 1024 * 1024 })))
      .toBe("downloads 84 MB + 91 MB");
  });

  it("shows the single blob for an added/deleted file", () => {
    expect(browserDownloadLabel(meta({ baseSize: null, headSize: 84 * 1024 * 1024 }))).toBe(
      "downloads 84 MB",
    );
  });

  // Defensive only: assessBrowserTier now refuses a both-null pair, so the
  // consent screen can no longer offer to download "nothing" and then download.
  it("never reaches the consent screen with no known sizes at all", () => {
    const both = meta({ baseSize: null, headSize: null });
    expect(browserDownloadLabel(both)).toBe("downloads nothing");
    expect(assessBrowserTier(both, true).available).toBe(false);
  });
});

describe("buildMismatch (pin vs. executing build)", () => {
  it("is null when the repo pins nothing", () => {
    expect(buildMismatch(meta({ pinnedBuild: null }))).toBeNull();
  });

  it("is null when the pin matches the manifest build", () => {
    expect(buildMismatch(meta({ pinnedBuild: "e520cc6" }))).toBeNull();
  });

  it("surfaces both sides when they differ — never silent", () => {
    expect(buildMismatch(meta({ pinnedBuild: "0ldbld1" }))).toEqual({
      pinned: "0ldbld1",
      official: "e520cc6",
    });
  });

  it("is null when the manifest carries no build stamp to compare against", () => {
    expect(buildMismatch(meta({ officialBuild: null, pinnedBuild: "0ldbld1" }))).toBeNull();
  });
});

describe("forgeDiffCommand (Tier L hand-off)", () => {
  it("emits the documented forge diff --web shape with an abbreviated range", () => {
    expect(forgeDiffCommand("scene/model.gltf", "a".repeat(40), "b".repeat(40))).toBe(
      `forge diff --web scene/model.gltf ${"a".repeat(12)}..${"b".repeat(12)}`,
    );
  });

  it("drops the range when there is no base (added file / root commit)", () => {
    expect(forgeDiffCommand("model.gltf", null, "b".repeat(40))).toBe("forge diff --web model.gltf");
  });

  it("quotes a path that needs it", () => {
    expect(forgeDiffCommand("my scene/model.gltf", null, "b".repeat(40))).toBe(
      'forge diff --web "my scene/model.gltf"',
    );
  });

  // Regression (#66 P4 review): the PR file view hands down the head BRANCH,
  // and slicing 12 characters off "claude/hub-66-p4-compute-tiers" produced
  // "claude/hub-6" — a command that either errors in forge or, worse, resolves
  // to something else. Only a real SHA has an unambiguous-prefix property.
  it("never truncates a revision that is not a full SHA", () => {
    expect(forgeDiffCommand("model.gltf", "a".repeat(40), "claude/hub-66-p4-compute-tiers")).toBe(
      `forge diff --web model.gltf ${"a".repeat(12)}..claude/hub-66-p4-compute-tiers`,
    );
    expect(forgeDiffCommand("model.gltf", "main", "feature/x")).toBe(
      "forge diff --web model.gltf main..feature/x",
    );
  });

  it("abbreviateRev shortens only 40-hex SHAs", () => {
    expect(abbreviateRev("c".repeat(40))).toBe("c".repeat(12));
    expect(abbreviateRev("main")).toBe("main");
    expect(abbreviateRev("v1.2.3")).toBe("v1.2.3");
    // A short SHA is already unambiguous-ish and is not ours to re-cut.
    expect(abbreviateRev("c68a22e")).toBe("c68a22e");
  });
});
