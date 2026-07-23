import { describe, it, expect } from "vitest";
import { canRead, canWrite } from "../repo-access.js";

type Repo = Parameters<typeof canRead>[0];

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    visibility: "PRIVATE",
    ownerId: "owner-1",
    collaborators: [],
    orgId: null,
    org: null,
    teamAccess: [],
    ...overrides,
  };
}

// Build an org relation with the given memberships (issue #114).
function org(memberships: Array<{ userId: string; role: "OWNER" | "MEMBER" }>) {
  return { memberships };
}

// Build a team grant: a team at `role` whose members are `userIds`.
function teamGrant(role: "READER" | "WRITER", userIds: string[]) {
  return { role, team: { memberships: userIds.map((userId) => ({ userId })) } };
}

describe("canRead", () => {
  it("public repo is readable by unauthenticated user", () => {
    const repo = makeRepo({ visibility: "PUBLIC" });
    expect(canRead(repo, undefined)).toBe(true);
  });

  it("public repo is readable by any authenticated user", () => {
    const repo = makeRepo({ visibility: "PUBLIC" });
    expect(canRead(repo, "random-user")).toBe(true);
  });

  it("private repo is NOT readable by unauthenticated user", () => {
    const repo = makeRepo({ visibility: "PRIVATE" });
    expect(canRead(repo, undefined)).toBe(false);
  });

  it("private repo IS readable by the owner", () => {
    const repo = makeRepo({ visibility: "PRIVATE", ownerId: "alice" });
    expect(canRead(repo, "alice")).toBe(true);
  });

  it("private repo is NOT readable by a stranger", () => {
    const repo = makeRepo({ visibility: "PRIVATE", ownerId: "alice" });
    expect(canRead(repo, "bob")).toBe(false);
  });

  it("private repo IS readable by a collaborator", () => {
    const repo = makeRepo({
      visibility: "PRIVATE",
      ownerId: "alice",
      collaborators: [{ userId: "bob", role: "READER" }],
    });
    expect(canRead(repo, "bob")).toBe(true);
  });

  it("private repo with collaborators is NOT readable by non-collaborator", () => {
    const repo = makeRepo({
      visibility: "PRIVATE",
      ownerId: "alice",
      collaborators: [{ userId: "bob", role: "READER" }],
    });
    expect(canRead(repo, "charlie")).toBe(false);
  });

  it("WRITER collaborator can also read", () => {
    const repo = makeRepo({
      visibility: "PRIVATE",
      ownerId: "alice",
      collaborators: [{ userId: "bob", role: "WRITER" }],
    });
    expect(canRead(repo, "bob")).toBe(true);
  });
});

describe("canWrite", () => {
  it("unauthenticated user cannot write", () => {
    const repo = makeRepo({ visibility: "PUBLIC" });
    expect(canWrite(repo, undefined)).toBe(false);
  });

  it("owner can write to private repo", () => {
    const repo = makeRepo({ ownerId: "alice" });
    expect(canWrite(repo, "alice")).toBe(true);
  });

  it("owner can write to public repo", () => {
    const repo = makeRepo({ visibility: "PUBLIC", ownerId: "alice" });
    expect(canWrite(repo, "alice")).toBe(true);
  });

  it("WRITER collaborator can write", () => {
    const repo = makeRepo({
      ownerId: "alice",
      collaborators: [{ userId: "bob", role: "WRITER" }],
    });
    expect(canWrite(repo, "bob")).toBe(true);
  });

  it("READER collaborator cannot write", () => {
    const repo = makeRepo({
      ownerId: "alice",
      collaborators: [{ userId: "bob", role: "READER" }],
    });
    expect(canWrite(repo, "bob")).toBe(false);
  });

  it("random authenticated user cannot write", () => {
    const repo = makeRepo({ ownerId: "alice" });
    expect(canWrite(repo, "charlie")).toBe(false);
  });

  it("unauthenticated user cannot write even to public repo", () => {
    const repo = makeRepo({ visibility: "PUBLIC" });
    expect(canWrite(repo, undefined)).toBe(false);
  });
});

// ─── Organizations & teams access matrix (issue #114) ────────────────────────────
//
// A PRIVATE org repo owned by org "acme" (repo creator = "creator"). Members:
//   - orgOwner  : OWNER of acme               → owner-equivalent (read + write)
//   - orgMember : bare MEMBER of acme         → NO implicit access to a private repo
//   - teamReader: MEMBER, on a READER team    → read only
//   - teamWriter: MEMBER, on a WRITER team    → read + write
//   - outsider  : not in the org              → nothing

function orgRepo(overrides: Partial<Repo> = {}): Repo {
  return makeRepo({
    visibility: "PRIVATE",
    ownerId: "creator",
    orgId: "acme",
    org: org([
      { userId: "orgOwner", role: "OWNER" },
      { userId: "orgMember", role: "MEMBER" },
      { userId: "teamReader", role: "MEMBER" },
      { userId: "teamWriter", role: "MEMBER" },
    ]),
    teamAccess: [teamGrant("READER", ["teamReader"]), teamGrant("WRITER", ["teamWriter"])],
    ...overrides,
  });
}

describe("org + team access on a PRIVATE org repo", () => {
  it("org OWNER can read and write", () => {
    const repo = orgRepo();
    expect(canRead(repo, "orgOwner")).toBe(true);
    expect(canWrite(repo, "orgOwner")).toBe(true);
  });

  it("bare org MEMBER (no team) can neither read nor write a private org repo", () => {
    const repo = orgRepo();
    expect(canRead(repo, "orgMember")).toBe(false);
    expect(canWrite(repo, "orgMember")).toBe(false);
  });

  it("team READER can read but not write", () => {
    const repo = orgRepo();
    expect(canRead(repo, "teamReader")).toBe(true);
    expect(canWrite(repo, "teamReader")).toBe(false);
  });

  it("team WRITER can read and write", () => {
    const repo = orgRepo();
    expect(canRead(repo, "teamWriter")).toBe(true);
    expect(canWrite(repo, "teamWriter")).toBe(true);
  });

  it("non-member (outsider) can neither read nor write", () => {
    const repo = orgRepo();
    expect(canRead(repo, "outsider")).toBe(false);
    expect(canWrite(repo, "outsider")).toBe(false);
  });

  it("the repo creator retains full access to their org repo", () => {
    const repo = orgRepo();
    expect(canRead(repo, "creator")).toBe(true);
    expect(canWrite(repo, "creator")).toBe(true);
  });
});

describe("org + team access on a PUBLIC org repo", () => {
  it("anyone can read a public org repo, but only granted users can write", () => {
    const repo = orgRepo({ visibility: "PUBLIC" });
    expect(canRead(repo, "outsider")).toBe(true);
    expect(canRead(repo, undefined)).toBe(true);
    expect(canWrite(repo, "outsider")).toBe(false);
    expect(canWrite(repo, "teamWriter")).toBe(true);
    expect(canWrite(repo, "teamReader")).toBe(false);
    expect(canWrite(repo, "orgOwner")).toBe(true);
  });
});

describe("team grants stack (highest role wins)", () => {
  it("a user on both a READER and a WRITER team gets write", () => {
    const repo = makeRepo({
      visibility: "PRIVATE",
      ownerId: "creator",
      orgId: "acme",
      org: org([{ userId: "dev", role: "MEMBER" }]),
      teamAccess: [teamGrant("READER", ["dev"]), teamGrant("WRITER", ["dev"])],
    });
    expect(canWrite(repo, "dev")).toBe(true);
  });
});
