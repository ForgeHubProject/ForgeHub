/**
 * Comment attachments (#253): who may upload and read them, what the bytes may
 * be, how big, how they're served, and that deleting the repository deletes them.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn(), count: vi.fn(), delete: vi.fn() },
    attachment: { create: vi.fn(), findUnique: vi.fn() },
    block: { findFirst: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { buildServer } from "../server.js";
import { authHeader } from "./helpers/server.js";
import { attachmentName, detectAttachmentType } from "../routes/attachments.js";
import type { FastifyInstance } from "fastify";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), randomBytes(32)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([16, 0, 0, 0]), Buffer.from("WEBP"), randomBytes(16)]);
const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "latin1");
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(32)]);
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.from([2, 0, 0, 0]), randomBytes(24)]);
const LOG = Buffer.from("\x1b[32mPASS\x1b[0m cave.test.ts\n\tall good\r\n");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const HTML = Buffer.from("﻿  \n<!doctype html><script>alert(1)</script>");

function multipart(buf: Buffer, filename: string, type = "application/octet-stream") {
  const boundary = "----fhtest" + randomBytes(8).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, buf, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

type RepoFixture = Record<string, unknown>;
function repo(over: RepoFixture = {}): RepoFixture {
  return {
    id: "repo-1",
    name: "lanternfall",
    visibility: "PUBLIC",
    ownerId: "user-1",
    orgId: null,
    org: null,
    archivedAt: null,
    // user-2 reads it; user-3 is nobody to it.
    collaborators: [{ userId: "user-2", role: "READER" }],
    teamAccess: [],
    socialPreviewKey: null,
    ...over,
  };
}

let app: FastifyInstance;
let owner: string;
let reader: string;
let outsider: string;
let storageRoot: string;
let current: RepoFixture;
const rows = new Map<string, Record<string, unknown>>();

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "fh-attachments-"));
  process.env["GIT_STORAGE_ROOT"] = storageRoot;
  process.env["JWT_SECRET"] = "test-secret-at-least-16-chars";
  app = await buildServer();
  owner = await authHeader(app, "user-1");
  reader = await authHeader(app, "user-2");
  outsider = await authHeader(app, "user-3");
}, 30_000);

afterAll(async () => {
  await app.close();
  delete process.env["GIT_STORAGE_ROOT"];
  await rm(storageRoot, { recursive: true, force: true });
  await rm(`${storageRoot}-attachments`, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  rows.clear();
  current = repo();
  vi.mocked(prisma.repo.findFirst).mockImplementation((async () => current) as never);
  vi.mocked(prisma.repo.count).mockResolvedValue(0);
  vi.mocked(prisma.repo.delete).mockResolvedValue({} as never);
  vi.mocked(prisma.block.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.attachment.create).mockImplementation((async ({ data }: { data: Record<string, unknown> }) => {
    rows.set(data["id"] as string, data);
    return data;
  }) as never);
  vi.mocked(prisma.attachment.findUnique).mockImplementation((async ({ where }: { where: { id: string } }) => {
    const row = rows.get(where.id);
    return row ? { ...row, repo: current } : null;
  }) as never);
});

const upload = (buf: Buffer, filename = "shot.png", who: string | null = owner, type?: string) => {
  const body = multipart(buf, filename, type);
  return app.inject({
    method: "POST",
    url: "/repos/ada/lanternfall/attachments",
    headers: { ...body.headers, ...(who ? { authorization: who } : {}) },
    payload: body.payload,
  });
};
const get = (url: string, who?: string) => app.inject({ method: "GET", url, headers: who ? { authorization: who } : {} });

describe("detectAttachmentType", () => {
  it("knows the images, documents and models by their bytes", () => {
    expect(detectAttachmentType(PNG)).toBe("image/png");
    expect(detectAttachmentType(JPEG)).toBe("image/jpeg");
    expect(detectAttachmentType(GIF)).toBe("image/gif");
    expect(detectAttachmentType(WEBP)).toBe("image/webp");
    expect(detectAttachmentType(PDF)).toBe("application/pdf");
    expect(detectAttachmentType(ZIP)).toBe("application/zip");
    expect(detectAttachmentType(GLB)).toBe("model/gltf-binary");
    expect(detectAttachmentType(LOG)).toBe("text/plain; charset=utf-8");
    expect(detectAttachmentType(Buffer.from("<34>1 2026-11-17T10:00:00Z cave sshd - - boot\n"))).toBe("text/plain; charset=utf-8");
  });

  it("refuses markup, binaries and empty files", () => {
    expect(detectAttachmentType(SVG)).toBeNull();
    expect(detectAttachmentType(HTML)).toBeNull();
    expect(detectAttachmentType(Buffer.from('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(detectAttachmentType(Buffer.from("</p>hi"))).toBeNull();
    expect(detectAttachmentType(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toBeNull(); // ELF
    expect(detectAttachmentType(Buffer.from([0xc3, 0x28, 0x41]))).toBeNull(); // invalid UTF-8
    expect(detectAttachmentType(Buffer.from(" \n "))).toBeNull();
    expect(detectAttachmentType(Buffer.alloc(0))).toBeNull();
  });
});

describe("attachmentName", () => {
  it("keeps a name whose extension matches, and adds one that does otherwise", () => {
    expect(attachmentName("shot.png", "image/png")).toBe("shot.png");
    expect(attachmentName("Photo.JPG", "image/jpeg")).toBe("Photo.JPG");
    expect(attachmentName("build.log", "text/plain; charset=utf-8")).toBe("build.log");
    expect(attachmentName("scene.gltf", "text/plain; charset=utf-8")).toBe("scene.gltf");
    expect(attachmentName("evil.html", "text/plain; charset=utf-8")).toBe("evil.html.txt");
    expect(attachmentName("cave.svg", "image/png")).toBe("cave.svg.png");
    expect(attachmentName("../../etc/passwd", "application/pdf")).toBe("file.pdf");
    expect(attachmentName(undefined, "model/gltf-binary")).toBe("file.glb");
  });
});

describe("uploading", () => {
  it("anyone who can comment uploads: the owner and a reader; not an outsider or someone signed out", async () => {
    const res = await upload(PNG);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ name: "shot.png", contentType: "image/png", size: PNG.length });
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.url).toBe(`/attachments/${body.id}`);
    expect(vi.mocked(prisma.attachment.create)).toHaveBeenCalledWith({
      data: { id: body.id, repoId: "repo-1", name: "shot.png", contentType: "image/png", size: PNG.length, uploadedById: "user-1" },
    });

    expect((await upload(PNG, "shot.png", reader)).statusCode).toBe(201);
    expect((await upload(PNG, "shot.png", null)).statusCode).toBe(401);
    current = repo({ visibility: "PRIVATE" });
    expect((await upload(PNG, "shot.png", outsider)).statusCode).toBe(404);
    expect((await upload(PNG, "shot.png", reader)).statusCode).toBe(201);
  });

  it("an archived repository, or a blocked user, can't upload", async () => {
    vi.mocked(prisma.repo.count).mockResolvedValue(1);
    expect((await upload(PNG)).statusCode).toBe(403);
    vi.mocked(prisma.repo.count).mockResolvedValue(0);
    vi.mocked(prisma.block.findFirst).mockResolvedValue({ blockerId: "user-1" } as never);
    expect((await upload(PNG, "shot.png", reader)).statusCode).toBe(403);
    expect(vi.mocked(prisma.attachment.create)).not.toHaveBeenCalled();
  });

  it("goes by the bytes: an SVG or a page dressed as an image or as text is refused", async () => {
    for (const [buf, name, type] of [[SVG, "cat.png", "image/png"], [HTML, "notes.txt", "text/plain"], [SVG, "cat.svg", "image/svg+xml"]] as const) {
      const res = await upload(buf, name, owner, type);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Attach a PNG, JPG, GIF or WebP image, or a PDF, ZIP, GLB or text file");
    }
    // A PNG called .html is a PNG, stored and named as one.
    const png = await upload(PNG, "page.html", owner, "text/html");
    expect(png.json()).toMatchObject({ contentType: "image/png", name: "page.html.png" });
    expect(vi.mocked(prisma.attachment.create)).toHaveBeenCalledTimes(1);
  });

  it("images up to 10 MB, other files up to 25 MB", async () => {
    const bigImage = await upload(Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    expect(bigImage.statusCode).toBe(413);
    expect(bigImage.json().error).toBe("Images must be under 10 MB");
    const bigText = Buffer.alloc(12 * 1024 * 1024, "a");
    expect((await upload(bigText, "big.log")).statusCode).toBe(201);
    const tooBig = await upload(Buffer.alloc(25 * 1024 * 1024 + 1, "a"), "huge.log");
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toBe("Files must be under 25 MB");
    expect(vi.mocked(prisma.attachment.create)).toHaveBeenCalledTimes(1);
  });
});

describe("serving", () => {
  it("an image: inline, its stored type, nosniff, sandboxed, cached for good", async () => {
    const { url } = (await upload(PNG, "shot.png", owner, "text/html")).json();
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toBe(`inline; filename="shot.png"; filename*=UTF-8''shot.png`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  });

  it("anything else downloads", async () => {
    const { url } = (await upload(PDF, "spec sheet.pdf")).json();
    const res = await get(url);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="spec sheet.pdf"; filename*=UTF-8''spec%20sheet.pdf`);
    const log = await get((await upload(LOG, "ci.log")).json().url);
    expect(log.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(log.headers["content-disposition"]).toMatch(/^attachment; /);
  });

  it("a private repository's are its readers' only: 404 for an outsider and for someone signed out", async () => {
    const { url } = (await upload(PNG)).json();
    current = repo({ visibility: "PRIVATE" });
    expect((await get(url, owner)).statusCode).toBe(200);
    expect((await get(url, reader)).statusCode).toBe(200);
    expect((await get(url, outsider)).statusCode).toBe(404);
    expect((await get(url)).statusCode).toBe(404);
    current = repo();
    expect((await get(url)).statusCode).toBe(200);
  });

  it("an unknown or malformed id is a 404", async () => {
    expect((await get(`/attachments/${"0".repeat(32)}`)).statusCode).toBe(404);
    expect((await get("/attachments/..%2F..%2Fetc%2Fpasswd")).statusCode).toBe(404);
    expect(vi.mocked(prisma.attachment.findUnique)).toHaveBeenCalledTimes(1);
  });
});

describe("deleting the repository", () => {
  it("deletes its attachments", async () => {
    const { url } = (await upload(PNG)).json();
    const dir = `${storageRoot}-attachments/repo-1`;
    expect((await readdir(dir)).length).toBeGreaterThan(0);
    const res = await app.inject({ method: "DELETE", url: "/repos/ada/lanternfall", headers: { authorization: owner } });
    expect(res.statusCode).toBe(204);
    expect(existsSync(dir)).toBe(false);
    // A row that outlived it (the database cascades) finds no file.
    expect((await get(url)).statusCode).toBe(404);
  });
});
