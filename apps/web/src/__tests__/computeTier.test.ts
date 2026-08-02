import { describe, it, expect } from "vitest";
import {
  TIER_B_MAX_COMBINED_BYTES,
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
  baseSize: 84 * 1024 * 1024,
  headSize: 84 * 1024 * 1024,
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
    expect(a).toEqual({ available: true, downloadBytes: 2 * 84 * 1024 * 1024 });
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

  it("is unavailable above the combined blob-size ceiling", () => {
    const half = Math.ceil(TIER_B_MAX_COMBINED_BYTES / 2) + 1;
    const a = assessBrowserTier(meta({ baseSize: half, headSize: half }), true);
    expect(a.available).toBe(false);
    if (!a.available) expect(a.reason).toContain("too large");
  });

  it("counts a missing blob (added/deleted file) as zero bytes", () => {
    const a = assessBrowserTier(meta({ baseSize: null, headSize: 1000 }), true);
    expect(a).toEqual({ available: true, downloadBytes: 1000 });
  });

  it("browserWasmSupported probes the given scope", () => {
    expect(browserWasmSupported({})).toBe(false);
    expect(browserWasmSupported({ WebAssembly: { instantiate: () => {} } })).toBe(true);
    // this test environment (node) genuinely has wasm
    expect(browserWasmSupported()).toBe(true);
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
    expect(browserDownloadLabel(meta())).toBe("downloads 2 × 84 MB");
  });

  it("lists both sizes when they differ", () => {
    expect(browserDownloadLabel(meta({ baseSize: 84 * 1024 * 1024, headSize: 91 * 1024 * 1024 })))
      .toBe("downloads 84 MB + 91 MB");
  });

  it("shows the single blob for an added/deleted file", () => {
    expect(browserDownloadLabel(meta({ baseSize: null }))).toBe("downloads 84 MB");
    expect(browserDownloadLabel(meta({ baseSize: null, headSize: null }))).toBe("downloads nothing");
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
});
