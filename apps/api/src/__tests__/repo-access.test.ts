import { describe, it, expect } from "vitest";
import { canRead, canWrite } from "../repo-access.js";

type Repo = Parameters<typeof canRead>[0];

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo-1",
    name: "my-repo",
    description: null,
    visibility: "PRIVATE",
    storageKey: "user/my-repo.git",
    ownerId: "owner-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    forkedFromId: null,
    collaborators: [],
    ...overrides,
  };
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
