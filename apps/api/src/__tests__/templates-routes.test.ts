import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: { findFirst: vi.fn() },
    personalAccessToken: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

// The loader itself is covered by repo-templates.test.ts against a real repo;
// here it is stubbed so the route's access model is what's under test.
vi.mock("../repo-templates.js", () => ({
  loadRepoTemplates: vi.fn().mockResolvedValue({ issueTemplates: [], pullRequestTemplate: null }),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { loadRepoTemplates } from "../repo-templates.js";
import { createTestServer, authHeader } from "./helpers/server.js";

const OWNER_ID = "user-owner-templates";
const OUTSIDER_ID = "user-outsider";

function makeRepo(overrides = {}) {
  return {
    id: "repo-templates-1",
    name: "my-repo",
    visibility: "PUBLIC" as const,
    storageKey: "alice/my-repo.git",
    ownerId: OWNER_ID,
    collaborators: [],
    ...overrides,
  };
}

const TEMPLATES = {
  issueTemplates: [
    { path: ".forgehub/ISSUE_TEMPLATE/bug.md", name: "Bug report", about: "Broken", labels: ["bug"], body: "## Steps\n" },
  ],
  pullRequestTemplate: { path: ".forgehub/PULL_REQUEST_TEMPLATE.md", body: "\n## What changed\n" },
};

describe("GET /repos/:handle/:name/templates", () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await createTestServer(); });
  afterAll(async () => { await app.close(); });

  beforeEach(() => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo() as never);
    vi.mocked(loadRepoTemplates).mockReset().mockResolvedValue(TEMPLATES);
  });

  it("200 with the parsed templates for a public repo, unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/templates" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(TEMPLATES);
    expect(vi.mocked(loadRepoTemplates)).toHaveBeenCalledWith("alice/my-repo.git", undefined);
  });

  it("404 when the repo does not exist", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/repos/alice/nope/templates" });
    expect(res.statusCode).toBe(404);
  });

  it("404 for a private repo without read access", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo({ visibility: "PRIVATE" }) as never);
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo/templates",
      headers: { authorization: await authHeader(app, OUTSIDER_ID) },
    });
    expect(res.statusCode).toBe(404);
    expect(vi.mocked(loadRepoTemplates)).not.toHaveBeenCalled();
  });

  it("200 for a private repo when the caller may read it", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo({ visibility: "PRIVATE" }) as never);
    const res = await app.inject({
      method: "GET",
      url: "/repos/alice/my-repo/templates",
      headers: { authorization: await authHeader(app, OWNER_ID) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("forwards ?ref= to the loader", async () => {
    await app.inject({ method: "GET", url: "/repos/alice/my-repo/templates?ref=release" });
    expect(vi.mocked(loadRepoTemplates)).toHaveBeenCalledWith("alice/my-repo.git", "release");
  });

  it("200 with empty templates for a repo with no git storage", async () => {
    vi.mocked(prisma.repo.findFirst).mockResolvedValue(makeRepo({ storageKey: null }) as never);
    vi.mocked(loadRepoTemplates).mockResolvedValue({ issueTemplates: [], pullRequestTemplate: null });
    const res = await app.inject({ method: "GET", url: "/repos/alice/my-repo/templates" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issueTemplates: [], pullRequestTemplate: null });
  });
});
