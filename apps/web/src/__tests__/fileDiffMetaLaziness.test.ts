/**
 * Regression pin for the eager `filediff-meta` defect (#66 P4 review, major #2).
 *
 * The defect: the commit and PR diff rows asked `/repos/:h/:n/filediff-meta`
 * for EVERY semantic file the moment the page mounted, purely to populate a
 * dropdown almost nobody opens. That request is ~6 git subprocess spawns
 * server-side, so a commit touching N 3D assets — the exact case these formats
 * exist for — fired N of them concurrently, for rows the reader never touched.
 *
 * Why it needs a test like this one: the fix changes nothing you can see. The
 * markup is byte-identical whether the request fires or not (the pill renders
 * either way; it just shows "checking capability…" until meta lands). Only the
 * CALL PATTERN differs. So this file mounts the real row components through the
 * DOM-free harness and counts calls to `getFileDiffMeta` — reverting either
 * call site back to the eager `useFileDiffMeta(token, base, path, sha)` form
 * makes these fail, which is the whole point.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./helpers/reactHarness");
  return { ...actual, ...harnessHooks, default: { ...actual, ...harnessHooks } };
});

const { getFileDiffMeta, getFhrFormats } = vi.hoisted(() => ({
  getFileDiffMeta: vi.fn(),
  getFhrFormats: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, getFileDiffMeta, getFhrFormats };
});

import type { FileDiff, PRFileEntry, ReviewComment } from "../types";
import type { FileDiffMeta } from "../api";
import { mount, findByType } from "./helpers/reactHarness";
import { FileDiffCard } from "../pages/repo/RepoCommitsTab";
import { PRFileRow } from "../pages/repo/pulls/PRFileRow";
import { ComputeTierPill, __resetFileDiffMetaCache } from "../views/diffViewers/computeTierUi";
import { resetSemanticExtensionsCache } from "../lib/fhrFormats";
import type { ReviewInteraction } from "../pages/repo/pulls/reviewShared";

const HEAD = "1111111111111111111111111111111111111111";

const meta = (path: string): FileDiffMeta => ({
  handlerId: "gltf-scene",
  path,
  baseSha: "0000000000000000000000000000000000000000",
  headSha: HEAD,
  baseSize: 1024,
  headSize: 2048,
  wasmAvailable: true,
  officialBuild: "e520cc6",
  pinnedBuild: null,
});

const commitFile = (name: string): FileDiff => ({
  oldPath: name,
  newPath: name,
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
  hunks: [],
});

const prFile = (name: string): PRFileEntry => ({
  path: name,
  additions: 1,
  deletions: 1,
  binary: false,
  status: "modified",
});

const review: ReviewInteraction = {
  currentUser: "alice",
  hasPendingReview: false,
  canComment: false,
  canResolve: () => false,
  busy: false,
  onCreate: () => {},
  onReply: () => {},
  onToggleResolve: () => {},
};

const noComments: ReviewComment[] = [];

// Five semantic assets in one commit / one PR — the shape that made the defect
// expensive rather than merely wasteful.
const SEMANTIC_ROWS = ["a.gltf", "b.gltf", "c.gltf", "d.gltf", "e.gltf"];

function mountCommitRow(name: string) {
  return mount(FileDiffCard, {
    file: commitFile(name),
    sha: HEAD,
    base: "/alice/scene",
    token: "tok",
    index: 0,
  });
}

function mountPrRow(name: string) {
  return mount(PRFileRow, {
    token: "tok",
    handle: "alice",
    repoName: "scene",
    prNumber: 1,
    file: prFile(name),
    base: "/alice/scene",
    headRef: HEAD,
    repoRef: { owner: "alice", name: "scene" },
    comments: noComments,
    review,
  });
}

/** Engage the row's compute-tier pill exactly as hover/focus/touch would. */
function engagePill(tree: unknown): void {
  const pill = findByType(tree, ComputeTierPill);
  expect(pill, "the row should render a compute-tier pill for a semantic file").not.toBeNull();
  const onActivate = pill!.props?.["onActivate"] as (() => void) | undefined;
  expect(typeof onActivate).toBe("function");
  onActivate!();
}

beforeEach(() => {
  getFileDiffMeta.mockReset();
  getFileDiffMeta.mockImplementation((_t, _h, _r, path: string) => Promise.resolve(meta(path)));
  getFhrFormats.mockReset();
  // The manifest advertises .gltf, so every row below really is semantic and
  // really does render the tier pill — a test where nothing is semantic would
  // pass for the wrong reason.
  getFhrFormats.mockResolvedValue({ ".gltf": "gltf-scene" });
  resetSemanticExtensionsCache();
  __resetFileDiffMetaCache();
});

afterEach(() => {
  resetSemanticExtensionsCache();
  __resetFileDiffMetaCache();
});

describe("filediff-meta is not requested for rows nobody engaged", () => {
  it("commit view: N semantic file cards fire ZERO meta requests on mount", async () => {
    const rows = [];
    for (const name of SEMANTIC_ROWS) rows.push(await mountCommitRow(name));

    // The cards are EXPANDED by default here — that is the point. Gating on
    // expansion would have fixed nothing in the commit view; the gate has to be
    // on whether anything actually reads the metadata.
    expect(getFileDiffMeta).toHaveBeenCalledTimes(0);

    // And they really are semantic rows with a live pill, so the zero above is
    // not the zero of "nothing rendered".
    for (const row of rows) expect(findByType(row.element, ComputeTierPill)).not.toBeNull();
    rows.forEach((r) => r.unmount());
  });

  it("PR view: N semantic file rows fire ZERO meta requests on mount", async () => {
    const rows = [];
    for (const name of SEMANTIC_ROWS) rows.push(await mountPrRow(name));

    expect(getFileDiffMeta).toHaveBeenCalledTimes(0);
    for (const row of rows) expect(findByType(row.element, ComputeTierPill)).not.toBeNull();
    rows.forEach((r) => r.unmount());
  });

  it("commit view: engaging one pill fetches that row's meta and only that row's", async () => {
    const rows = [];
    for (const name of SEMANTIC_ROWS) rows.push(await mountCommitRow(name));
    expect(getFileDiffMeta).toHaveBeenCalledTimes(0);

    engagePill(rows[2]!.element);
    await rows[2]!.settle();

    expect(getFileDiffMeta).toHaveBeenCalledTimes(1);
    expect(getFileDiffMeta.mock.calls[0]![3]).toBe("c.gltf");
    // The engaged row now has real metadata, so the pill can stop saying
    // "checking capability…" — the laziness costs the feature nothing.
    expect(findByType(rows[2]!.element, ComputeTierPill)!.props?.["meta"]).not.toBeNull();
    rows.forEach((r) => r.unmount());
  });

  it("PR view: engaging one pill fetches that row's meta and only that row's", async () => {
    const rows = [];
    for (const name of SEMANTIC_ROWS) rows.push(await mountPrRow(name));
    expect(getFileDiffMeta).toHaveBeenCalledTimes(0);

    engagePill(rows[0]!.element);
    await rows[0]!.settle();

    expect(getFileDiffMeta).toHaveBeenCalledTimes(1);
    expect(getFileDiffMeta.mock.calls[0]![3]).toBe("a.gltf");
    expect(findByType(rows[0]!.element, ComputeTierPill)!.props?.["meta"]).not.toBeNull();
    rows.forEach((r) => r.unmount());
  });

  it("a non-semantic row asks for nothing even once engaged (no pill to engage)", async () => {
    const row = await mountCommitRow("notes.txt");
    expect(findByType(row.element, ComputeTierPill)).toBeNull();
    expect(getFileDiffMeta).toHaveBeenCalledTimes(0);
    row.unmount();
  });
});
