import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────
//
// Regression for the duplicate-name POST /repos data loss: `git init --bare` on
// an existing repo succeeds, so the handler thought it had created the bare dir,
// the row insert then failed with P2002, and the rollback rm -rf'd the EXISTING
// repository before answering 409. git-storage is left REAL here so the test sees
// what happens on disk; prisma is a tiny in-memory repo table keyed on the unique
// storageKey, so a second insert of the same key fails with P2002 like SQLite.

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    orgMembership: { findUnique: vi.fn() },
    repo: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    watch: { upsert: vi.fn() },
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { bareRepoPathFromKey, createBareRepo } from "../git-storage.js";
import { createTestServer, authHeader } from "./helpers/server.js";
import { makeCommit } from "./helpers/git.js";
import type { FastifyInstance } from "fastify";

const execFile = promisify(execFileCb);

const ALICE = "user-alice";
const ORG = { id: "org-1", handle: "acme" };

type Row = {
  id: string;
  name: string;
  description: string | null;
  visibility: "PUBLIC" | "PRIVATE";
  storageKey: string | null;
  ownerId: string;
  orgId: string | null;
  createdAt: Date;
  updatedAt: Date;
  owner: { handle: string };
  org: { handle: string } | null;
};

let rows: Row[] = [];
let storageRoot: string;

/** Push one commit into a bare repo through a throwaway clone; returns its sha. */
async function pushCommit(storageKey: string, files: Record<string, string>): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "fh-create-work-"));
  try {
    await execFile("git", ["clone", bareRepoPathFromKey(storageKey), work]);
    await execFile("git", ["-C", work, "config", "user.email", "t@forgehub.io"]);
    await execFile("git", ["-C", work, "config", "user.name", "Tester"]);
    await execFile("git", ["-C", work, "config", "commit.gpgsign", "false"]);
    return await makeCommit(work, files, "seed");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The sha `refs/heads/main` points at in a bare repo (throws if the repo or ref is gone). */
async function mainSha(storageKey: string): Promise<string> {
  const { stdout } = await execFile("git", ["--git-dir", bareRepoPathFromKey(storageKey), "rev-parse", "refs/heads/main"]);
  return stdout.trim();
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false);
}

describe("repo storage is never clobbered by a name conflict", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await createTestServer();
    token = await authHeader(app, ALICE);
  });
  afterAll(async () => { await app.close(); });

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "fh-create-storage-"));
    process.env["GIT_STORAGE_ROOT"] = storageRoot;
    rows = [];
    vi.clearAllMocks();

    vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "alice" } as never);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(ORG as never);
    vi.mocked(prisma.orgMembership.findUnique).mockResolvedValue({ orgId: ORG.id, userId: ALICE, role: "MEMBER" } as never);
    vi.mocked(prisma.repo.findUnique).mockImplementation((async (args: { where: { storageKey: string } }) =>
      rows.find((r) => r.storageKey === args.where.storageKey) ?? null) as never);
    vi.mocked(prisma.repo.findFirst).mockImplementation((async (args: { where: { ownerId: string; name: string } }) =>
      rows.find((r) => r.ownerId === args.where.ownerId && r.name === args.where.name && r.orgId === null) ?? null) as never);
    vi.mocked(prisma.repo.create).mockImplementation((async (args: { data: Omit<Row, "id" | "createdAt" | "updatedAt" | "owner" | "org"> }) => {
      if (rows.some((r) => r.storageKey === args.data.storageKey)) throw { code: "P2002" };
      const row: Row = {
        ...args.data,
        id: `repo-${rows.length + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        owner: { handle: "alice" },
        org: args.data.orgId ? { handle: ORG.handle } : null,
      };
      rows.push(row);
      return row;
    }) as never);
    vi.mocked(prisma.repo.update).mockImplementation((async (args: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === args.where.id)!;
      if (rows.some((r) => r !== row && r.storageKey === args.data.storageKey)) throw { code: "P2002" };
      return Object.assign(row, args.data);
    }) as never);
  });

  afterEach(async () => {
    delete process.env["GIT_STORAGE_ROOT"];
    await rm(storageRoot, { recursive: true, force: true });
  });

  function createRepo(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/repos", headers: { authorization: token }, payload });
  }

  it("409 on a duplicate name, and the existing bare repo and its ref survive", async () => {
    const first = await createRepo({ name: "widget" });
    expect(first.statusCode).toBe(201);
    const sha = await pushCommit("alice/widget.git", { "README.md": "keep me\n" });

    const dup = await createRepo({ name: "widget" });

    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("You already have a repository with this name");
    expect(await mainSha("alice/widget.git")).toBe(sha);
    expect(rows).toHaveLength(1);
  });

  it("409 for a duplicate name in an org, with the org's bare repo intact", async () => {
    expect((await createRepo({ name: "widget", owner: "acme" })).statusCode).toBe(201);
    const sha = await pushCommit("acme/widget.git", { "README.md": "org work\n" });

    const dup = await createRepo({ name: "widget", owner: "acme" });

    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("This organization already has a repository with this name");
    expect(await mainSha("acme/widget.git")).toBe(sha);
  });

  it("409 and storage untouched when a bare repo exists without a row", async () => {
    // Storage the row check cannot see: left behind by an operator, or created by
    // a concurrent request that has not inserted its row yet.
    await createBareRepo("alice/orphan.git");
    const sha = await pushCommit("alice/orphan.git", { "data.txt": "1\n" });

    const res = await createRepo({ name: "orphan" });

    expect(res.statusCode).toBe(409);
    expect(prisma.repo.create).not.toHaveBeenCalled();
    expect(await mainSha("alice/orphan.git")).toBe(sha);
  });

  it("rolls back only the directory it created when the row insert loses a race", async () => {
    // Another request inserted the row after our check but owns no storage yet:
    // we create the bare dir, our insert fails P2002, and our own dir is removed.
    rows.push({
      id: "repo-race", name: "racy", description: null, visibility: "PRIVATE",
      storageKey: "alice/racy.git", ownerId: ALICE, orgId: null,
      createdAt: new Date(), updatedAt: new Date(), owner: { handle: "alice" }, org: null,
    });
    vi.mocked(prisma.repo.findUnique).mockResolvedValueOnce(null as never);

    const res = await createRepo({ name: "racy" });

    expect(res.statusCode).toBe(409);
    expect(await exists(bareRepoPathFromKey("alice/racy.git"))).toBe(false);
  });

  it("409 when renaming onto an existing repo, and neither bare repo moves", async () => {
    expect((await createRepo({ name: "alpha" })).statusCode).toBe(201);
    expect((await createRepo({ name: "beta" })).statusCode).toBe(201);
    const alphaSha = await pushCommit("alice/alpha.git", { "a.txt": "a\n" });
    const betaSha = await pushCommit("alice/beta.git", { "b.txt": "b\n" });

    const res = await app.inject({
      method: "PATCH",
      url: "/repos/alpha/rename",
      headers: { authorization: token },
      payload: { name: "beta" },
    });

    expect(res.statusCode).toBe(409);
    expect(await mainSha("alice/alpha.git")).toBe(alphaSha);
    expect(await mainSha("alice/beta.git")).toBe(betaSha);
    expect(prisma.repo.update).not.toHaveBeenCalled();
  });
});
