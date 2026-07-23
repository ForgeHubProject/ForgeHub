import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────
// git-storage is intentionally NOT mocked — design bytes go through the real
// filesystem so ingestion and semantic compare run on the actual uploaded bytes.

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    issue: { findFirst: vi.fn() },
    design: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    designVersion: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    snapshot: { findFirst: vi.fn(), create: vi.fn() },
    diffCache: { findUnique: vi.fn(), create: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../timeline-service.js", () => ({
  recordEvent: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../prisma.js";
import { recordEvent } from "../timeline-service.js";
import { buildServer } from "../server.js";
import { gltfSceneHandler } from "../handlers/gltf-scene/index.js";
import { authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_REPO = {
  id: "repo-1", name: "gearbox", ownerId: "user-1",
  visibility: "PUBLIC", storageKey: "alice/gearbox.git", collaborators: [],
};
const MOCK_PRIVATE_REPO = { ...MOCK_REPO, visibility: "PRIVATE" };
const MOCK_ISSUE = { id: "issue-1", repoId: "repo-1", number: 7, locked: false };
const NOW = new Date("2026-01-01T00:00:00.000Z");

/** A minimal valid glTF scene with one named node at a given translation. */
function gltf(nodeName: string, translation: [number, number, number]): Buffer {
  return Buffer.from(JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0], name: "Scene" }],
    nodes: [{ name: nodeName, translation }],
  }), "utf8");
}

/** Build a multipart/form-data body carrying a single binary file part. */
function multipart(filename: string, buf: Buffer, mimetype = "application/octet-stream") {
  const boundary = "----fhtest" + randomBytes(8).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimetype}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    payload: Buffer.concat([head, buf, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

function upload(app: FastifyInstance, token: string, filename: string, buf: Buffer, mimetype?: string) {
  const up = multipart(filename, buf, mimetype);
  return app.inject({
    method: "POST",
    url: "/repos/alice/gearbox/issues/7/designs",
    headers: { authorization: token, ...up.headers },
    payload: up.payload,
  });
}

/** Mock a fresh design creation returning `id`, currentVersion starting at 0. */
function mockNewDesignFlow(designId: string, name: string) {
  vi.mocked(prisma.design.findFirst).mockResolvedValueOnce(null as never);
  vi.mocked(prisma.design.create).mockResolvedValueOnce({
    id: designId, issueId: "issue-1", name, currentVersion: 0, createdById: "user-1", createdAt: NOW,
  } as never);
}

/** Mock design.update to echo currentVersion + a versions array for formatDesign. */
function mockDesignUpdate(designId: string, name: string) {
  vi.mocked(prisma.design.update).mockImplementation((async (args: { data: { currentVersion: number } }) => ({
    id: designId, issueId: "issue-1", name, currentVersion: args.data.currentVersion,
    createdById: "user-1", createdBy: { handle: "alice" }, createdAt: NOW,
    versions: Array.from({ length: args.data.currentVersion }, (_, i) => ({
      version: i + 1, contentType: "model/gltf+json", size: 10, snapshotId: `snap-${i + 1}`,
      storageKey: `repo-1/${designId}/${i + 1}`, uploadedBy: { handle: "alice" }, createdAt: NOW,
    })),
  })) as never);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let ownerToken: string;
let readerToken: string;
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "fh-design-test-"));
  process.env["GIT_STORAGE_ROOT"] = storageRoot;
  process.env["JWT_SECRET"] = "test-secret-at-least-16-chars";
  app = await buildServer();
  ownerToken = await authHeader(app, "user-1");
  readerToken = await authHeader(app, "reader-9");
}, 30_000);

afterAll(async () => {
  await app.close();
  delete process.env["GIT_STORAGE_ROOT"];
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_REPO as never);
  vi.mocked(prisma.issue.findFirst).mockResolvedValue(MOCK_ISSUE as never);
  vi.mocked(prisma.snapshot.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.snapshot.create).mockImplementation((async () =>
    ({ id: `snap-${vi.mocked(prisma.snapshot.create).mock.calls.length}` })) as never);
  vi.mocked(prisma.designVersion.create).mockImplementation((async (args: { data: Record<string, unknown> }) =>
    ({ id: "dv", ...args.data, uploadedBy: { handle: "alice" }, createdAt: NOW })) as never);
  vi.mocked(prisma.diffCache.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.diffCache.create).mockResolvedValue({} as never);
  vi.mocked(prisma.design.delete).mockResolvedValue({} as never);
});

// ─── Version bump on same-name upload ───────────────────────────────────────────

describe("design upload + version bump", () => {
  it("first upload creates v1 (design_added); same name bumps to v2 (design_versioned)", async () => {
    // v1 — new design
    mockNewDesignFlow("design-1", "gear.gltf");
    mockDesignUpdate("design-1", "gear.gltf");
    const v1 = await upload(app, ownerToken, "gear.gltf", gltf("Gear", [0, 0, 0]), "model/gltf+json");
    expect(v1.statusCode).toBe(201);
    expect(v1.json().design.currentVersion).toBe(1);
    expect(v1.json().version.version).toBe(1);
    expect(v1.json().version.hasSnapshot).toBe(true);
    expect(vi.mocked(prisma.design.create)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.designVersion.create).mock.calls[0]![0]).toMatchObject({
      data: expect.objectContaining({ version: 1, snapshotId: expect.stringContaining("snap-") }),
    });
    expect(vi.mocked(recordEvent).mock.calls[0]![0]).toMatchObject({ kind: "design_added", data: { design: "gear.gltf", version: 1 } });

    // v2 — existing design, same name
    vi.mocked(prisma.design.findFirst).mockResolvedValueOnce({
      id: "design-1", issueId: "issue-1", name: "gear.gltf", currentVersion: 1, createdById: "user-1", createdAt: NOW,
    } as never);
    mockDesignUpdate("design-1", "gear.gltf");
    const v2 = await upload(app, ownerToken, "gear.gltf", gltf("Gear", [3, 0, 0]), "model/gltf+json");
    expect(v2.statusCode).toBe(201);
    expect(v2.json().design.currentVersion).toBe(2);
    expect(v2.json().version.version).toBe(2);
    expect(vi.mocked(prisma.design.create)).toHaveBeenCalledTimes(1); // no new design row
    expect(vi.mocked(prisma.designVersion.create).mock.calls.at(-1)![0]).toMatchObject({ data: expect.objectContaining({ version: 2 }) });
    expect(vi.mocked(recordEvent).mock.calls.at(-1)![0]).toMatchObject({ kind: "design_versioned", data: { version: 2 } });
  });

  it("returns 409 when the version row collides (unique constraint)", async () => {
    mockNewDesignFlow("design-x", "part.gltf");
    vi.mocked(prisma.designVersion.create).mockRejectedValueOnce(new Error("Unique constraint failed") as never);
    const res = await upload(app, ownerToken, "part.gltf", gltf("Part", [0, 0, 0]), "model/gltf+json");
    expect(res.statusCode).toBe(409);
  });
});

// ─── Snapshot ingestion on FHR formats ──────────────────────────────────────────

describe("snapshot ingestion", () => {
  it("ingests an FHR-recognized .gltf into a Snapshot", async () => {
    mockNewDesignFlow("design-2", "assembly.gltf");
    mockDesignUpdate("design-2", "assembly.gltf");
    const res = await upload(app, ownerToken, "assembly.gltf", gltf("Assembly", [1, 2, 3]), "model/gltf+json");
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(prisma.snapshot.create)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.designVersion.create).mock.calls[0]![0]).toMatchObject({
      data: expect.objectContaining({ snapshotId: expect.stringContaining("snap-") }),
    });
  });

  it("stores an image with NO snapshot (snapshotId null, isImage true)", async () => {
    mockNewDesignFlow("design-3", "mockup.png");
    vi.mocked(prisma.design.update).mockImplementation((async (args: { data: { currentVersion: number } }) => ({
      id: "design-3", issueId: "issue-1", name: "mockup.png", currentVersion: args.data.currentVersion,
      createdById: "user-1", createdBy: { handle: "alice" }, createdAt: NOW,
      versions: [{ version: 1, contentType: "image/png", size: 8, snapshotId: null, storageKey: "repo-1/design-3/1", uploadedBy: { handle: "alice" }, createdAt: NOW }],
    })) as never);
    const res = await upload(app, ownerToken, "mockup.png", randomBytes(64), "image/png");
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(prisma.snapshot.create)).not.toHaveBeenCalled();
    expect(res.json().version.hasSnapshot).toBe(false);
    expect(res.json().version.isImage).toBe(true);
  });
});

// ─── Semantic compare parity with the PR/commit compare path ────────────────────

describe("version compare", () => {
  // Upload two real gltf versions to disk, then drive the compare endpoint over
  // the actual stored bytes.
  async function seedTwoGltfVersions(v1: Buffer, v2: Buffer) {
    mockNewDesignFlow("design-c", "landing-gear.gltf");
    mockDesignUpdate("design-c", "landing-gear.gltf");
    await upload(app, ownerToken, "landing-gear.gltf", v1, "model/gltf+json");
    vi.mocked(prisma.design.findFirst).mockResolvedValueOnce({
      id: "design-c", issueId: "issue-1", name: "landing-gear.gltf", currentVersion: 1, createdById: "user-1", createdAt: NOW,
    } as never);
    mockDesignUpdate("design-c", "landing-gear.gltf");
    await upload(app, ownerToken, "landing-gear.gltf", v2, "model/gltf+json");
  }

  it("semantic diff matches handler.diff exactly (compare parity)", async () => {
    const v1 = gltf("Landing Gear", [0, 0, 0]);
    const v2 = gltf("Landing Gear", [5, 0, 0]);
    await seedTwoGltfVersions(v1, v2);

    // compare lookups
    vi.mocked(prisma.design.findFirst).mockResolvedValue({ id: "design-c", issueId: "issue-1", name: "landing-gear.gltf" } as never);
    vi.mocked(prisma.designVersion.findMany).mockResolvedValue([
      { version: 1, storageKey: "repo-1/design-c/1", contentType: "model/gltf+json", size: v1.length, snapshotId: "snap-1" },
      { version: 2, storageKey: "repo-1/design-c/2", contentType: "model/gltf+json", size: v2.length, snapshotId: "snap-2" },
    ] as never);

    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/gearbox/issues/7/designs/design-c/compare?from=1&to=2",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("semantic");
    expect(body.format).toBe("gltf-scene");

    // The changed node: landing-gear moved +5 on X.
    const moved = body.changes.find((c: { path: string }) => c.path === "landing-gear");
    expect(moved).toBeTruthy();
    const posChild = moved.children.find((ch: { path: string }) => ch.path === "position");
    expect(posChild.before).toEqual([0, 0, 0]);
    expect(posChild.after).toEqual([5, 0, 0]);

    // PARITY: byte-for-byte identical to what the PR/commit compare path computes.
    const expected = await gltfSceneHandler.diff(v1, v2);
    expect(body.changes).toEqual(expected.changes);
  });

  it("caches the diff (DiffCache) keyed by git blob shas", async () => {
    const v1 = gltf("Landing Gear", [0, 0, 0]);
    const v2 = gltf("Landing Gear", [5, 0, 0]);
    await seedTwoGltfVersions(v1, v2);
    vi.mocked(prisma.design.findFirst).mockResolvedValue({ id: "design-c", issueId: "issue-1", name: "landing-gear.gltf" } as never);
    vi.mocked(prisma.designVersion.findMany).mockResolvedValue([
      { version: 1, storageKey: "repo-1/design-c/1", contentType: "model/gltf+json", size: v1.length, snapshotId: "snap-1" },
      { version: 2, storageKey: "repo-1/design-c/2", contentType: "model/gltf+json", size: v2.length, snapshotId: "snap-2" },
    ] as never);

    await app.inject({ method: "GET", url: "/repos/alice/gearbox/issues/7/designs/design-c/compare?from=1&to=2", headers: { authorization: ownerToken } });
    const key = vi.mocked(prisma.diffCache.create).mock.calls[0]![0] as { data: { handlerId: string; baseBlobSha: string; headBlobSha: string } };
    expect(key.data.handlerId).toBe("gltf-scene");
    expect(key.data.baseBlobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(key.data.headBlobSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns mode=visual when both versions are images", async () => {
    vi.mocked(prisma.design.findFirst).mockResolvedValue({ id: "design-i", issueId: "issue-1", name: "sketch.png" } as never);
    vi.mocked(prisma.designVersion.findMany).mockResolvedValue([
      { version: 1, storageKey: "k1", contentType: "image/png", size: 100, snapshotId: null },
      { version: 2, storageKey: "k2", contentType: "image/png", size: 120, snapshotId: null },
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/gearbox/issues/7/designs/design-i/compare?from=1&to=2", headers: { authorization: ownerToken } });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("visual");
    expect(res.json().to.size).toBe(120);
  });

  it("returns mode=binary when neither semantic nor image", async () => {
    vi.mocked(prisma.design.findFirst).mockResolvedValue({ id: "design-b", issueId: "issue-1", name: "part.step" } as never);
    vi.mocked(prisma.designVersion.findMany).mockResolvedValue([
      { version: 1, storageKey: "k1", contentType: "application/octet-stream", size: 10, snapshotId: null },
      { version: 2, storageKey: "k2", contentType: "application/octet-stream", size: 20, snapshotId: null },
    ] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/gearbox/issues/7/designs/design-b/compare?from=1&to=2", headers: { authorization: ownerToken } });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("binary");
    expect(res.json().from.size).toBe(10);
    expect(res.json().to.size).toBe(20);
  });

  it("rejects same-version compare with 400", async () => {
    vi.mocked(prisma.design.findFirst).mockResolvedValue({ id: "design-b", issueId: "issue-1", name: "part.step" } as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/gearbox/issues/7/designs/design-b/compare?from=2&to=2", headers: { authorization: ownerToken } });
    expect(res.statusCode).toBe(400);
  });
});

// ─── Raw bytes ───────────────────────────────────────────────────────────────────

describe("raw version bytes", () => {
  it("streams the stored bytes back byte-identically", async () => {
    const original = gltf("Bracket", [0, 0, 0]);
    mockNewDesignFlow("design-r", "bracket.gltf");
    mockDesignUpdate("design-r", "bracket.gltf");
    await upload(app, ownerToken, "bracket.gltf", original, "model/gltf+json");

    vi.mocked(prisma.design.findFirst).mockResolvedValue({ id: "design-r", issueId: "issue-1", name: "bracket.gltf" } as never);
    vi.mocked(prisma.designVersion.findFirst).mockResolvedValue({
      designId: "design-r", version: 1, storageKey: "repo-1/design-r/1", contentType: "model/gltf+json", size: original.length,
    } as never);

    const res = await app.inject({ method: "GET", url: "/repos/alice/gearbox/issues/7/designs/design-r/versions/1/raw" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("model/gltf+json");
    expect(Buffer.compare(res.rawPayload, original)).toBe(0);
  });
});

// ─── Auth + visibility gates ────────────────────────────────────────────────────

describe("auth + visibility", () => {
  it("lists designs for a public repo (guest ok)", async () => {
    vi.mocked(prisma.design.findMany).mockResolvedValue([] as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/gearbox/issues/7/designs" });
    expect(res.statusCode).toBe(200);
    expect(res.json().designs).toEqual([]);
  });

  it("private repo hides the design list from guests → 404", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_PRIVATE_REPO as never);
    const res = await app.inject({ method: "GET", url: "/repos/alice/gearbox/issues/7/designs" });
    expect(res.statusCode).toBe(404);
  });

  it("unauthenticated upload → 401", async () => {
    const up = multipart("x.gltf", gltf("X", [0, 0, 0]));
    const res = await app.inject({ method: "POST", url: "/repos/alice/gearbox/issues/7/designs", headers: up.headers, payload: up.payload });
    expect(res.statusCode).toBe(401);
  });

  it("locked conversation: non-writer upload → 403", async () => {
    vi.mocked(prisma.issue.findFirst).mockResolvedValue({ ...MOCK_ISSUE, locked: true } as never);
    const res = await upload(app, readerToken, "y.gltf", gltf("Y", [0, 0, 0]), "model/gltf+json");
    expect(res.statusCode).toBe(403);
  });
});

// ─── Size cap ────────────────────────────────────────────────────────────────────

describe("design size cap", () => {
  it("rejects a file exceeding DESIGN_MAX_BYTES → 413", async () => {
    process.env["DESIGN_MAX_BYTES"] = "16";
    try {
      mockNewDesignFlow("design-big", "big.gltf");
      const res = await upload(app, ownerToken, "big.gltf", randomBytes(1024), "model/gltf+json");
      expect(res.statusCode).toBe(413);
      expect(vi.mocked(prisma.designVersion.create)).not.toHaveBeenCalled();
      // The design row created for the failed first upload is cleaned up.
      expect(vi.mocked(prisma.design.delete)).toHaveBeenCalledWith({ where: { id: "design-big" } });
    } finally {
      delete process.env["DESIGN_MAX_BYTES"];
    }
  });
});

// ─── Delete ──────────────────────────────────────────────────────────────────────

describe("design delete", () => {
  beforeEach(() => {
    vi.mocked(prisma.design.findFirst).mockResolvedValue({
      id: "design-d", issueId: "issue-1", name: "gear.gltf", createdById: "user-1",
      versions: [{ storageKey: "repo-1/design-d/1" }],
    } as never);
    vi.mocked(prisma.design.delete).mockResolvedValue({} as never);
  });

  it("author deletes their design → 204", async () => {
    const res = await app.inject({ method: "DELETE", url: "/repos/alice/gearbox/issues/7/designs/design-d", headers: { authorization: ownerToken } });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(prisma.design.delete)).toHaveBeenCalledWith({ where: { id: "design-d" } });
  });

  it("a non-author reader cannot delete → 403", async () => {
    const res = await app.inject({ method: "DELETE", url: "/repos/alice/gearbox/issues/7/designs/design-d", headers: { authorization: readerToken } });
    expect(res.statusCode).toBe(403);
    expect(vi.mocked(prisma.design.delete)).not.toHaveBeenCalled();
  });
});
