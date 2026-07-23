import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────
// NOTE: git-storage is intentionally NOT mocked — avatar bytes go through the real
// filesystem so the upload→serve roundtrip proves byte-identity + cache headers.

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { buildServer } from "../server.js";
import { authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// ─── Image fixtures (real magic bytes) ────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
/** RIFF....WEBP header. */
function webp(): Buffer {
  const head = Buffer.from("RIFF");
  const size = Buffer.from([0x10, 0x00, 0x00, 0x00]);
  const fmt = Buffer.from("WEBP");
  return Buffer.concat([head, size, fmt, randomBytes(16)]);
}
function png(extra = 32): Buffer {
  return Buffer.concat([PNG_SIG, randomBytes(extra)]);
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
let storageRoot: string;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "fh-avatar-test-"));
  process.env["GIT_STORAGE_ROOT"] = storageRoot;
  process.env["JWT_SECRET"] = "test-secret-at-least-16-chars";
  process.env["AVATAR_MAX_BYTES"] = "1024"; // small cap so oversize is easy to hit
  app = await buildServer();
  ownerToken = await authHeader(app, "user-1");
}, 30_000);

afterAll(async () => {
  await app.close();
  delete process.env["GIT_STORAGE_ROOT"];
  delete process.env["AVATAR_MAX_BYTES"];
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.update).mockResolvedValue({ id: "user-1", avatarKey: "tok" } as never);
});

// ─── Upload ───────────────────────────────────────────────────────────────────

describe("POST /users/me/avatar", () => {
  it("accepts a PNG and rotates the avatarKey", async () => {
    const up = multipart("me.png", png(), "image/png");
    const res = await app.inject({
      method: "POST",
      url: "/users/me/avatar",
      headers: { ...up.headers, authorization: ownerToken },
      payload: up.payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.contentType).toBe("image/png");
    expect(typeof body.avatarKey).toBe("string");
    expect(body.avatarKey.length).toBeGreaterThan(0);
    // avatarKey was persisted on the user row.
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" }, data: { avatarKey: expect.any(String) } }),
    );
  });

  it("accepts a JPEG", async () => {
    const up = multipart("me.jpg", Buffer.concat([JPEG_SIG, randomBytes(20)]), "image/jpeg");
    const res = await app.inject({
      method: "POST", url: "/users/me/avatar",
      headers: { ...up.headers, authorization: ownerToken }, payload: up.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().contentType).toBe("image/jpeg");
  });

  it("accepts a WebP", async () => {
    const up = multipart("me.webp", webp(), "image/webp");
    const res = await app.inject({
      method: "POST", url: "/users/me/avatar",
      headers: { ...up.headers, authorization: ownerToken }, payload: up.payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().contentType).toBe("image/webp");
  });

  it("rejects a file whose magic bytes are not a supported image (even with image/* content-type)", async () => {
    // A GIF (unsupported) disguised with an image/png content-type.
    const gif = Buffer.concat([Buffer.from("GIF89a"), randomBytes(20)]);
    const up = multipart("evil.png", gif, "image/png");
    const res = await app.inject({
      method: "POST", url: "/users/me/avatar",
      headers: { ...up.headers, authorization: ownerToken }, payload: up.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("rejects an oversize file with 413", async () => {
    const up = multipart("big.png", png(4096), "image/png"); // > 1024 cap
    const res = await app.inject({
      method: "POST", url: "/users/me/avatar",
      headers: { ...up.headers, authorization: ownerToken }, payload: up.payload,
    });
    expect(res.statusCode).toBe(413);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const up = multipart("me.png", png(), "image/png");
    const res = await app.inject({
      method: "POST", url: "/users/me/avatar", headers: up.headers, payload: up.payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("400s when no file part is present", async () => {
    const res = await app.inject({
      method: "POST", url: "/users/me/avatar",
      headers: { "content-type": "application/json", authorization: ownerToken },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── Serve ────────────────────────────────────────────────────────────────────

describe("GET /users/:handle/avatar", () => {
  it("serves the stored bytes with an immutable cache header + correct content-type", async () => {
    const bytes = png(64);
    const up = multipart("me.png", bytes, "image/png");
    await app.inject({
      method: "POST", url: "/users/me/avatar",
      headers: { ...up.headers, authorization: ownerToken }, payload: up.payload,
    });

    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-1", avatarKey: "tok-123" } as never);
    const res = await app.inject({ method: "GET", url: "/users/alice/avatar?s=64" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.headers["cache-control"]).toContain("max-age=");
    expect(res.headers["etag"]).toBe('"tok-123"');
    expect(Buffer.compare(res.rawPayload, bytes)).toBe(0);
  });

  it("404s when the user has no avatar", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-1", avatarKey: null } as never);
    const res = await app.inject({ method: "GET", url: "/users/alice/avatar" });
    expect(res.statusCode).toBe(404);
  });

  it("404s for an unknown handle", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const res = await app.inject({ method: "GET", url: "/users/ghost/avatar" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Delete ───────────────────────────────────────────────────────────────────

describe("DELETE /users/me/avatar", () => {
  it("clears the avatarKey and returns 204", async () => {
    // Upload first so there is a file to remove.
    const up = multipart("me.png", png(), "image/png");
    await app.inject({
      method: "POST", url: "/users/me/avatar",
      headers: { ...up.headers, authorization: ownerToken }, payload: up.payload,
    });

    const res = await app.inject({
      method: "DELETE", url: "/users/me/avatar", headers: { authorization: ownerToken },
    });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" }, data: { avatarKey: null } }),
    );

    // After clearing, serving 404s.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-1", avatarKey: null } as never);
    const serve = await app.inject({ method: "GET", url: "/users/alice/avatar" });
    expect(serve.statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "DELETE", url: "/users/me/avatar" });
    expect(res.statusCode).toBe(401);
  });
});
