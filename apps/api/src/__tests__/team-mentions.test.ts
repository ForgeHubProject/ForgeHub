/**
 * Team mentions (#253): @org/team notifies the team's members, when it's the
 * repository's own organization and the writer belongs to it.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    team: { findMany: vi.fn() },
    issue: { findFirst: vi.fn() },
    pullRequest: { findFirst: vi.fn() },
    crossReference: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("../notifications-service.js", () => ({ notifyUser: vi.fn() }));
vi.mock("../timeline-service.js", () => ({ recordEvent: vi.fn() }));

import { prisma } from "../prisma.js";
import { notifyUser } from "../notifications-service.js";
import { parseReferences } from "../references.js";
import { syncBodyReferences } from "../references-service.js";

describe("parseReferences", () => {
  it("reads @org/team, lowercased and once each, and leaves e-mail addresses alone", () => {
    expect(parseReferences("cc @Acme/Design-Team and @acme/design-team, not me@acme/x").teamMentions).toEqual(["acme/design-team"]);
    expect(parseReferences("`@acme/core` in code").teamMentions).toEqual([]);
  });
});

describe("notifying a team", () => {
  // A private org repository: Bea reads it through a team, not as a collaborator.
  const repo = {
    id: "r1", visibility: "PRIVATE", ownerId: "creator", orgId: "org-1", collaborators: [],
    org: { id: "org-1", handle: "acme", memberships: [{ userId: "ada", role: "MEMBER" }] },
    teamAccess: [{ role: "READER", team: { memberships: [{ userId: "bea" }, { userId: "cy" }] } }],
  };
  const sync = (body: string, actorId = "ada") =>
    syncBodyReferences({
      repo: repo as never,
      actorId,
      source: { type: "ISSUE_COMMENT", id: "c1" },
      container: { subjectType: "ISSUE", id: "i1", number: 3, title: "Hello" },
      body,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.crossReference.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findUnique).mockImplementation((async (args: { where: { handle?: string; id?: string } }) =>
      args.where.handle === "cy" ? { id: "cy" } : args.where.id ? { handle: "ada" } : null) as never);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ handle: "acme", memberships: [{ userId: "ada" }] } as never);
    vi.mocked(prisma.team.findMany).mockResolvedValue([{ memberships: [{ userId: "ada" }, { userId: "bea" }, { userId: "cy" }] }] as never);
  });

  it("notifies each member once, a direct mention first, never the writer", async () => {
    await sync("@acme/design @cy please look");
    const calls = vi.mocked(notifyUser).mock.calls.map((c) => [c[0], c[1].reason]);
    expect(calls).toEqual([["cy", "MENTIONED"], ["bea", "TEAM_MENTIONED"]]);
    expect(vi.mocked(prisma.team.findMany).mock.calls[0][0]!.where).toEqual({ orgId: "org-1", slug: { in: ["design"] } });
  });

  it("ignores other organizations' teams and writers outside the organization", async () => {
    await sync("@other/design");
    expect(prisma.team.findMany).not.toHaveBeenCalled();
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ handle: "acme", memberships: [] } as never);
    await sync("@acme/design", "stranger");
    expect(notifyUser).not.toHaveBeenCalled();
  });
});
