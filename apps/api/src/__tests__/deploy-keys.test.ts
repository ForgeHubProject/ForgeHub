import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    deployKey: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    sSHKey: { findUnique: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

const OWNER_ID = "owner-1";
const KEY_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINF3319jjgEjhpwtrz3oEC7Q5v9ny/ubnpRxPF3Xt/1F";
const KEY_FP = "SHA256:VCLjt8aUSHPMAP7Q67RG8wteqLWaiuYHoU5DqJUxXd8";

const REPO = { id: "repo-1", ownerId: OWNER_ID, visibility: "PRIVATE", storageKey: "alice/proj.git", collaborators: [] };

function mockRepo(repo: unknown) {
  vi.mocked(prisma.repo.findFirst).mockResolvedValue(repo as never);
}
function fingerprintFree() {
  vi.mocked(prisma.sSHKey.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.deployKey.findUnique).mockResolvedValue(null as never);
}

describe("POST /repos/:handle/:name/keys", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { vi.clearAllMocks(); });

  it("401 without auth", async () => {
    const res = await app.inject({ method: "POST", url: "/repos/alice/proj/keys", payload: { title: "ci", publicKey: KEY_LINE } });
    expect(res.statusCode).toBe(401);
  });

  it("403 when the caller is not the owner of a public repo", async () => {
    mockRepo({ ...REPO, visibility: "PUBLIC", ownerId: "someone-else" });
    const res = await app.inject({
      method: "POST", url: "/repos/alice/proj/keys",
      headers: { authorization: await authHeader(app, "intruder") },
      payload: { title: "ci", publicKey: KEY_LINE },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404 when the caller is not the owner of a private repo (don't leak existence)", async () => {
    mockRepo({ ...REPO, ownerId: "someone-else" });
    const res = await app.inject({
      method: "POST", url: "/repos/alice/proj/keys",
      headers: { authorization: await authHeader(app, "intruder") },
      payload: { title: "ci", publicKey: KEY_LINE },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404 when the repo does not exist", async () => {
    mockRepo(null);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/proj/keys",
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { title: "ci", publicKey: KEY_LINE },
    });
    expect(res.statusCode).toBe(404);
  });

  it("201 defaults to read-only", async () => {
    mockRepo(REPO);
    fingerprintFree();
    vi.mocked(prisma.deployKey.create).mockImplementation((async ({ data }: any) => ({
      id: "dk-1", repoId: data.repoId, title: data.title, publicKey: data.publicKey,
      fingerprint: data.fingerprint, readOnly: data.readOnly, createdAt: new Date("2026-01-01"),
    })) as never);

    const res = await app.inject({
      method: "POST", url: "/repos/alice/proj/keys",
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { title: "ci", publicKey: KEY_LINE },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.readOnly).toBe(true);
    expect(body.fingerprint).toBe(KEY_FP);
    expect(body.publicKey).toBe(KEY_LINE);
  });

  it("201 honors readOnly:false", async () => {
    mockRepo(REPO);
    fingerprintFree();
    vi.mocked(prisma.deployKey.create).mockImplementation((async ({ data }: any) => ({
      id: "dk-2", repoId: data.repoId, title: data.title, publicKey: data.publicKey,
      fingerprint: data.fingerprint, readOnly: data.readOnly, createdAt: new Date(),
    })) as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/proj/keys",
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { title: "deployer", publicKey: KEY_LINE, readOnly: false },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().readOnly).toBe(false);
  });

  it("400 for an unparseable key", async () => {
    mockRepo(REPO);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/proj/keys",
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { title: "ci", publicKey: "junk" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when the fingerprint is already a USER key (cross-table dedupe)", async () => {
    mockRepo(REPO);
    vi.mocked(prisma.sSHKey.findUnique).mockResolvedValue({ id: "existing-user-key" } as never);
    vi.mocked(prisma.deployKey.findUnique).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "POST", url: "/repos/alice/proj/keys",
      headers: { authorization: await authHeader(app, OWNER_ID) },
      payload: { title: "ci", publicKey: KEY_LINE },
    });
    expect(res.statusCode).toBe(409);
    expect(prisma.deployKey.create).not.toHaveBeenCalled();
  });
});

describe("GET /repos/:handle/:name/keys", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { vi.clearAllMocks(); });

  it("lists the repo's deploy keys for the owner", async () => {
    mockRepo(REPO);
    vi.mocked(prisma.deployKey.findMany).mockResolvedValue([
      { id: "dk-1", repoId: "repo-1", title: "ci", publicKey: KEY_LINE, fingerprint: KEY_FP, readOnly: true, createdAt: new Date("2026-01-01") },
    ] as never);
    const res = await app.inject({
      method: "GET", url: "/repos/alice/proj/keys",
      headers: { authorization: await authHeader(app, OWNER_ID) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toHaveLength(1);
    expect(res.json().keys[0].readOnly).toBe(true);
  });

  it("404 for a non-owner on a private repo", async () => {
    mockRepo({ ...REPO, ownerId: "someone-else" });
    const res = await app.inject({
      method: "GET", url: "/repos/alice/proj/keys",
      headers: { authorization: await authHeader(app, "intruder") },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /repos/:handle/:name/keys/:id", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { vi.clearAllMocks(); });

  it("204 when the key belongs to the repo", async () => {
    mockRepo(REPO);
    vi.mocked(prisma.deployKey.findFirst).mockResolvedValue({ id: "dk-1", repoId: "repo-1" } as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/proj/keys/dk-1",
      headers: { authorization: await authHeader(app, OWNER_ID) },
    });
    expect(res.statusCode).toBe(204);
    expect(prisma.deployKey.delete).toHaveBeenCalledWith({ where: { id: "dk-1" } });
  });

  it("404 when the key is not on this repo", async () => {
    mockRepo(REPO);
    vi.mocked(prisma.deployKey.findFirst).mockResolvedValue(null as never);
    const res = await app.inject({
      method: "DELETE", url: "/repos/alice/proj/keys/dk-x",
      headers: { authorization: await authHeader(app, OWNER_ID) },
    });
    expect(res.statusCode).toBe(404);
  });
});
