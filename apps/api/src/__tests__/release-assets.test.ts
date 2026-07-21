import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────
// NOTE: git-storage is intentionally NOT mocked — asset bytes go through the
// real filesystem so the upload→download roundtrip proves byte-identity.

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    release: { findFirst: vi.fn() },
    releaseAsset: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    pullRequest: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("../notifications-service.js", () => ({
  notifySubscribers: vi.fn().mockResolvedValue(undefined),
  notifyUser: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../prisma.js";
import { buildServer } from "../server.js";
import { sanitizeAssetName } from "../routes/releases.js";
import { authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_REPO = {
  id: "repo-1",
  name: "my-repo",
  ownerId: "user-1",
  visibility: "PUBLIC",
  storageKey: "alice/my-repo.git",
  collaborators: [],
};
const MOCK_PRIVATE_REPO = { ...MOCK_REPO, visibility: "PRIVATE" };

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeRelease(overrides: Record<string, unknown> = {}) {
  return {
    id: "rel-1",
    repoId: "repo-1",
    tagName: "v1.0.0",
    name: "Version 1.0.0",
    body: null,
    isDraft: false,
    isPrerelease: false,
    author: { handle: "alice" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
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

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let ownerToken: string;
let readerToken: string;
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "fh-asset-test-"));
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
  vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease() as never);
  vi.mocked(prisma.releaseAsset.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.releaseAsset.update).mockResolvedValue({} as never);
});

// ─── Upload → download roundtrip (byte-identical binary) ───────────────────────

describe("release asset upload/download roundtrip", () => {
  it("stores and returns a binary payload (with null bytes) byte-for-byte", async () => {
    // A binary blob that includes NUL and high bytes.
    const original = Buffer.concat([
      randomBytes(2048),
      Buffer.from([0x00, 0x00, 0xff, 0x10, 0x00, 0x7f, 0x80]),
      randomBytes(2048),
    ]);

    vi.mocked(prisma.releaseAsset.create).mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        ({
          id: "asset-1",
          ...args.data,
          downloadCount: 0,
          uploadedBy: { handle: "alice" },
          createdAt: NOW,
        }) as never,
    );

    const up = multipart("payload.bin", original);
    const upRes = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/releases/rel-1/assets",
      headers: { authorization: ownerToken, ...up.headers },
      payload: up.payload,
    });
    expect(upRes.statusCode).toBe(201);
    expect(upRes.json().name).toBe("payload.bin");
    expect(upRes.json().size).toBe(original.length);
    expect(upRes.json().uploader).toBe("alice");

    // storageKey the route computed and wrote to disk
    const createArgs = vi.mocked(prisma.releaseAsset.create).mock.calls.at(-1)![0] as {
      data: { storageKey: string; size: number };
    };
    const storageKey = createArgs.data.storageKey;
    expect(createArgs.data.size).toBe(original.length);

    // Now download it
    vi.mocked(prisma.releaseAsset.findFirst).mockResolvedValue({
      id: "asset-1",
      releaseId: "rel-1",
      name: "payload.bin",
      contentType: "application/octet-stream",
      size: original.length,
      storageKey,
      downloadCount: 0,
    } as never);

    const dlRes = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo/releases/rel-1/assets/asset-1",
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers["content-type"]).toContain("application/octet-stream");
    expect(dlRes.headers["content-disposition"]).toContain('filename="payload.bin"');
    // BYTE-IDENTICAL
    expect(Buffer.compare(dlRes.rawPayload, original)).toBe(0);
  });

  it("increments downloadCount on each download", async () => {
    vi.mocked(prisma.releaseAsset.create).mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        ({ id: "asset-2", ...args.data, downloadCount: 0, uploadedBy: { handle: "alice" }, createdAt: NOW }) as never,
    );
    const up = multipart("count.dat", randomBytes(64));
    await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/releases/rel-1/assets",
      headers: { authorization: ownerToken, ...up.headers },
      payload: up.payload,
    });
    const key = (vi.mocked(prisma.releaseAsset.create).mock.calls.at(-1)![0] as { data: { storageKey: string } }).data.storageKey;

    vi.mocked(prisma.releaseAsset.findFirst).mockResolvedValue({
      id: "asset-2", releaseId: "rel-1", name: "count.dat",
      contentType: "application/octet-stream", size: 64, storageKey: key, downloadCount: 0,
    } as never);

    await app.inject({ method: "GET", url: "/repos/alice/my-repo/releases/rel-1/assets/asset-2" });
    expect(prisma.releaseAsset.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "asset-2" }, data: { downloadCount: { increment: 1 } } }),
    );
  });
});

// ─── Name sanitization ─────────────────────────────────────────────────────────

describe("sanitizeAssetName (unit)", () => {
  it.each([
    ["slash", "foo/bar.zip"],
    ["backslash", "bad\\name.zip"],
    ["dotdot", "evil..name.zip"],
    ["leading dotdot", "../secret"],
    ["empty", ""],
    ["whitespace only", "   "],
    ["control char", "a\u0007b.zip"],
    ["newline", "a\nb.zip"],
  ])("rejects %s", (_label, input) => {
    expect(sanitizeAssetName(input)).toBeNull();
  });

  it("rejects names longer than 200 chars", () => {
    expect(sanitizeAssetName("a".repeat(201) + ".zip")).toBeNull();
  });

  it("accepts a normal file name (trimmed)", () => {
    expect(sanitizeAssetName("  release-v1.0.0.tar.gz  ")).toBe("release-v1.0.0.tar.gz");
  });
});

describe("asset name sanitization (over HTTP)", () => {
  it("rejects a dotdot file name with 400 (busboy preserves it; the route rejects)", async () => {
    const up = multipart("evil..name.zip", randomBytes(16));
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/releases/rel-1/assets",
      headers: { authorization: ownerToken, ...up.headers },
      payload: up.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.releaseAsset.create).not.toHaveBeenCalled();
  });

  it("returns 409 when an asset with the same name already exists", async () => {
    vi.mocked(prisma.releaseAsset.findFirst).mockResolvedValue({ id: "dup", name: "dup.zip" } as never);
    const up = multipart("dup.zip", randomBytes(16));
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/releases/rel-1/assets",
      headers: { authorization: ownerToken, ...up.headers },
      payload: up.payload,
    });
    expect(res.statusCode).toBe(409);
  });
});

// ─── Auth gates ────────────────────────────────────────────────────────────────

describe("asset auth gates", () => {
  it("reader (non-writer) cannot upload → 403", async () => {
    const up = multipart("x.bin", randomBytes(16));
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/releases/rel-1/assets",
      headers: { authorization: readerToken, ...up.headers },
      payload: up.payload,
    });
    expect(res.statusCode).toBe(403);
  });

  it("unauthenticated cannot upload → 401", async () => {
    const up = multipart("x.bin", randomBytes(16));
    const res = await app.inject({
      method: "POST",
      url: "/repos/alice/my-repo/releases/rel-1/assets",
      headers: up.headers,
      payload: up.payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("reader (non-writer) cannot delete → 403", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/releases/rel-1/assets/asset-1",
      headers: { authorization: readerToken },
    });
    expect(res.statusCode).toBe(403);
  });

  it("private repo: download is gated for guests → 404", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(MOCK_PRIVATE_REPO as never);
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo/releases/rel-1/assets/asset-1",
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.releaseAsset.update).not.toHaveBeenCalled();
  });

  it("draft release: download hidden from guests → 404", async () => {
    vi.mocked(prisma.release.findFirst).mockResolvedValue(makeRelease({ isDraft: true }) as never);
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo/releases/rel-1/assets/asset-1",
    });
    expect(res.statusCode).toBe(404);
  });

  it("delete removes the asset row → 204", async () => {
    vi.mocked(prisma.releaseAsset.findFirst).mockResolvedValue({ id: "asset-1", releaseId: "rel-1", storageKey: "alice/my-repo/rel-1/asset-1" } as never);
    vi.mocked(prisma.releaseAsset.delete).mockResolvedValue({} as never);
    const res = await app.inject({
      method: "DELETE",
      url: "/repos/alice/my-repo/releases/rel-1/assets/asset-1",
      headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.releaseAsset.delete).toHaveBeenCalledWith({ where: { id: "asset-1" } });
  });
});

// ─── Size cap ────────────────────────────────────────────────────────────────

describe("asset size cap", () => {
  it("rejects a file exceeding the configured limit → 413", async () => {
    process.env["RELEASE_ASSET_MAX_BYTES"] = "16";
    const smallApp = await buildServer();
    try {
      const token = await authHeader(smallApp, "user-1");
      const up = multipart("big.bin", randomBytes(1024));
      const res = await smallApp.inject({
        method: "POST",
        url: "/repos/alice/my-repo/releases/rel-1/assets",
        headers: { authorization: token, ...up.headers },
        payload: up.payload,
      });
      expect(res.statusCode).toBe(413);
      expect(prisma.releaseAsset.create).not.toHaveBeenCalled();
    } finally {
      await smallApp.close();
      delete process.env["RELEASE_ASSET_MAX_BYTES"];
    }
  });
});
