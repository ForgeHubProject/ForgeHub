/**
 * Regression pin for the tier-scoped 404 fallback (#66 P4 review, blocker #1,
 * second half).
 *
 * `isFormatNotSupported(e)` is literally `e instanceof ApiError && status === 404`.
 * On the SERVER tier that 404 has one meaning — the repo hasn't opted this
 * format in — and the right answer is to render exactly what the file would
 * have shown without semantic support: its base text/binary viewer, no error.
 *
 * On a CLIENT tier the same 404 cannot mean that: `filediff-meta` already
 * answered 200 through the very same gate, so the format IS supported and a
 * 404 arriving from the browser-compute path (e.g. the /handlers proxy has no
 * such build) is a real failure. Swallowing it into the text fallback shows the
 * reader plausible-looking raw bytes in place of a diff that failed — which is
 * the mechanism that made the tier-B blocker silent in the first place.
 *
 * Both halves are asserted below, because the fix is a NARROWING: a test that
 * only checked "browser 404 → error" could be satisfied by deleting the
 * fallback outright, and a test that only checked "server 404 → fallback"
 * passes with or without the fix.
 */
import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./helpers/reactHarness");
  return { ...actual, ...harnessHooks, default: { ...actual, ...harnessHooks } };
});

const { getFileDiffMeta, getFileSemanticDiff, fetchRawBlob, browserWasmDiff } = vi.hoisted(() => ({
  getFileDiffMeta: vi.fn(),
  getFileSemanticDiff: vi.fn(),
  fetchRawBlob: vi.fn(),
  browserWasmDiff: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, getFileDiffMeta, getFileSemanticDiff, fetchRawBlob };
});

vi.mock("../lib/browserWasm", () => ({ browserWasmDiff }));

import type { FileDiff } from "../types";
import { ApiError, type FileDiffMeta } from "../api";
import { mount, findByType, textOf } from "./helpers/reactHarness";
import { FhrFileDiffViewer } from "../views/diffViewers/FhrFileDiffViewer";
import { BrowserComputeGate, __resetFileDiffMetaCache } from "../views/diffViewers/computeTierUi";
import { resolveBaseFileDiffViewer } from "../views/fileDiffViewerRegistry";

// The viewer reaches for `window` timers on the server tier (the slow-server
// nudge). This suite runs in the node environment, so give it just that.
const priorWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
  matchMedia: () => ({ matches: false }),
};

afterAll(() => {
  if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = priorWindow;
});

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "0000000000000000000000000000000000000000";

const file: FileDiff = {
  oldPath: "model.gltf",
  newPath: "model.gltf",
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
  hunks: [],
};

const META: FileDiffMeta = {
  handlerId: "gltf-scene",
  path: "model.gltf",
  baseSha: BASE,
  headSha: HEAD,
  baseSize: 64,
  headSize: 64,
  wasmAvailable: true,
  officialBuild: "e520cc6",
  pinnedBuild: null,
};

const BaseViewer = resolveBaseFileDiffViewer("model.gltf");

beforeEach(() => {
  __resetFileDiffMetaCache();
  getFileDiffMeta.mockReset();
  getFileDiffMeta.mockResolvedValue(META);
  getFileSemanticDiff.mockReset();
  fetchRawBlob.mockReset();
  fetchRawBlob.mockImplementation(() => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])])));
  browserWasmDiff.mockReset();
});

function mountViewer(computeTier: "server" | "browser") {
  return mount(FhrFileDiffViewer, {
    file,
    repoBase: "/alice/scene",
    headRef: HEAD,
    token: "tok",
    computeTier,
  });
}

/** Walk the Tier-B honest-cost gate the way a consenting user does. */
async function consentToBrowserCompute(view: Awaited<ReturnType<typeof mountViewer>>) {
  const gate = findByType(view.element, BrowserComputeGate);
  expect(gate, "Tier B should show its honest-cost consent gate first").not.toBeNull();
  (gate!.props?.["onCompute"] as () => void)();
  await view.settle();
}

describe("the 404 → text-fallback path is scoped to the server tier", () => {
  it("SERVER tier: a 404 renders the file's base viewer, no error", async () => {
    getFileSemanticDiff.mockRejectedValue(new ApiError(404, "No semantic handler for this file"));

    const view = await mountViewer("server");

    // status === "fallback": the component returns the base viewer directly.
    expect((view.element as { type: unknown }).type).toBe(BaseViewer);
    expect(textOf(view.element)).not.toContain("Semantic diff unavailable");
    view.unmount();
  });

  it("BROWSER tier: a 404 surfaces as an error, never as the text fallback", async () => {
    // The /handlers proxy has no such build. Same status code, entirely
    // different meaning — the format is supported (filediff-meta said so).
    browserWasmDiff.mockRejectedValue(new ApiError(404, "Handler build not available"));

    const view = await mountViewer("browser");
    await consentToBrowserCompute(view);

    expect(browserWasmDiff).toHaveBeenCalledTimes(1);
    expect(findByType(view.element, BaseViewer)).toBeNull();
    expect((view.element as { type: unknown }).type).not.toBe(BaseViewer);
    const text = textOf(view.element);
    expect(text).toContain("Semantic diff unavailable");
    expect(text).toContain("Handler build not available");
    view.unmount();
  });

  it("BROWSER tier: a non-404 failure surfaces as an error too (unchanged)", async () => {
    browserWasmDiff.mockRejectedValue(new ApiError(500, "wasm trap"));

    const view = await mountViewer("browser");
    await consentToBrowserCompute(view);

    expect(findByType(view.element, BaseViewer)).toBeNull();
    expect(textOf(view.element)).toContain("wasm trap");
    view.unmount();
  });
});
