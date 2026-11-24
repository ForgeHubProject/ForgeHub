/**
 * An organization's profile, as on GitHub: website, location and avatar, set by
 * its owners and shown to everyone; and copying the avatar of the GitHub
 * organization it was imported from (#308). Avatar bytes go through the real
 * filesystem, as in profile-avatar.test.ts.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn(), update: vi.fn() },
    repo: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { buildServer } from "../server.js";
import { copyGithubAvatar } from "../routes/github-org-import.js";
import { authHeader } from "./helpers/server.js";

const OWNER = "user-owner";
const MEMBER = "user-member";
const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(32)]);

const membership = (userId: string, role: "OWNER" | "MEMBER") => ({
  userId, role, createdAt: new Date(), user: { id: userId, handle: userId, displayName: null },
});
const ORG = {
  id: "org-profile-1", handle: "acme", displayName: "Acme", description: null,
  website: null as string | null, location: null as string | null, avatarKey: null as string | null,
  createdAt: new Date(), updatedAt: new Date(),
  memberships: [membership(OWNER, "OWNER"), membership(MEMBER, "MEMBER")],
  _count: { teams: 0 },
};

function multipart(buf: Buffer) {
  const boundary = "----fhtest" + randomBytes(8).toString("hex");
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`);
  return {
    payload: Buffer.concat([head, buf, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

let app: FastifyInstance;
let storageRoot: string;
beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "fh-org-profile-test-"));
  process.env["GIT_STORAGE_ROOT"] = storageRoot;
  process.env["AVATAR_MAX_BYTES"] = "1024";
  app = await buildServer();
}, 30_000);
afterAll(async () => {
  await app.close();
  delete process.env["GIT_STORAGE_ROOT"];
  delete process.env["AVATAR_MAX_BYTES"];
  await rm(storageRoot, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.organization.findUnique).mockResolvedValue(ORG as never);
  vi.mocked(prisma.organization.update).mockImplementation((async ({ data }: { data: object }) => ({ ...ORG, ...data })) as never);
});

const patch = async (who: string, payload: object) =>
  app.inject({ method: "PATCH", url: "/orgs/acme", headers: { authorization: await authHeader(app, who) }, payload });

describe("an organization's website and location", () => {
  it("are set by an owner and come back on the organization", async () => {
    const res = await patch(OWNER, { website: "https://acme.example", location: "  Berlin " });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(prisma.organization.update)).toHaveBeenCalledWith({
      where: { id: ORG.id },
      data: { website: "https://acme.example", location: "Berlin" },
    });
    expect(res.json()).toMatchObject({ website: "https://acme.example", location: "Berlin", avatarKey: null });
  });

  it("are cleared by an empty value", async () => {
    await patch(OWNER, { website: "", location: "" });
    expect(vi.mocked(prisma.organization.update)).toHaveBeenCalledWith({ where: { id: ORG.id }, data: { website: null, location: null } });
  });

  it("take only an http or https address as the website", async () => {
    for (const website of ["javascript:alert(1)", "acme.example", "ftp://acme.example"]) {
      expect((await patch(OWNER, { website })).statusCode, website).toBe(400);
    }
    expect(vi.mocked(prisma.organization.update)).not.toHaveBeenCalled();
  });

  it("can't be changed by a member who isn't an owner", async () => {
    expect((await patch(MEMBER, { location: "Paris" })).statusCode).toBe(403);
  });

  it("are shown to everyone on the organization's page", async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ ...ORG, website: "https://acme.example", location: "Berlin", avatarKey: "k1" } as never);
    const res = await app.inject({ method: "GET", url: "/orgs/acme" });
    expect(res.json().org).toMatchObject({ website: "https://acme.example", location: "Berlin", avatarKey: "k1" });
  });
});

describe("an organization's avatar", () => {
  const upload = async (who: string, buf: Buffer) => {
    const body = multipart(buf);
    return app.inject({ method: "POST", url: "/orgs/acme/avatar", headers: { ...body.headers, authorization: await authHeader(app, who) }, payload: body.payload });
  };

  it("is uploaded by an owner and served to anyone, byte for byte", async () => {
    const img = PNG();
    const res = await upload(OWNER, img);
    expect(res.statusCode).toBe(201);
    const { avatarKey } = res.json();
    expect(vi.mocked(prisma.organization.update)).toHaveBeenCalledWith({ where: { id: ORG.id }, data: { avatarKey } });

    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: ORG.id, avatarKey } as never);
    const got = await app.inject({ method: "GET", url: "/orgs/acme/avatar" });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["etag"]).toBe(`"${avatarKey}"`);
    expect(got.rawPayload.equals(img)).toBe(true);
  });

  it("refuses a member who isn't an owner, a file that isn't an image, and one over the cap", async () => {
    expect((await upload(MEMBER, PNG())).statusCode).toBe(403);
    expect((await upload(OWNER, Buffer.from("<svg onload=alert(1)>"))).statusCode).toBe(400);
    expect((await upload(OWNER, Buffer.concat([PNG(), randomBytes(2048)]))).statusCode).toBe(413);
  });

  it("is removed by an owner, leaving the letter avatar", async () => {
    const res = await app.inject({ method: "DELETE", url: "/orgs/acme/avatar", headers: { authorization: await authHeader(app, OWNER) } });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(prisma.organization.update)).toHaveBeenCalledWith({ where: { id: ORG.id }, data: { avatarKey: null } });
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ id: ORG.id, avatarKey: null } as never);
    expect((await app.inject({ method: "GET", url: "/orgs/acme/avatar" })).statusCode).toBe(404);
  });
});

describe("copying a GitHub organization's avatar (#308)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(() => vi.unstubAllGlobals());

  it("stores a PNG from GitHub's avatar host, with no redirects followed", async () => {
    fetchMock.mockResolvedValueOnce(new Response(PNG(), { status: 200 }));
    expect(await copyGithubAvatar(app, ORG.id, "https://avatars.githubusercontent.com/u/16748505?v=4")).toBe(true);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    expect(vi.mocked(prisma.organization.update)).toHaveBeenCalledWith({ where: { id: ORG.id }, data: { avatarKey: expect.any(String) } });
  });

  it("never fetches another host", async () => {
    for (const url of ["https://example.com/a.png", "http://avatars.githubusercontent.com/u/1", "https://avatars.githubusercontent.com.evil.test/u/1"]) {
      expect(await copyGithubAvatar(app, ORG.id, url), url).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the letter avatar for an answer that isn't an image, is too big, or fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(Buffer.concat([PNG(), randomBytes(2048)]), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    for (let i = 0; i < 4; i++) expect(await copyGithubAvatar(app, ORG.id, "https://avatars.githubusercontent.com/u/1")).toBe(false);
    expect(vi.mocked(prisma.organization.update)).not.toHaveBeenCalled();
  });
});
