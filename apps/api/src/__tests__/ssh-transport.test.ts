import { describe, it, expect } from "vitest";
import { decideAccess, parseGitCommand, type AccessDecision } from "../ssh/server.js";
import type { SshActor } from "../ssh/store.js";

// ─── command parsing ──────────────────────────────────────────────────────────

describe("parseGitCommand", () => {
  it("parses upload-pack with a single-quoted path", () => {
    expect(parseGitCommand("git-upload-pack '/alice/proj.git'")).toEqual({
      service: "git-upload-pack",
      ownerHandle: "alice",
      repoName: "proj",
    });
  });

  it("parses receive-pack with a double-quoted path", () => {
    expect(parseGitCommand('git-receive-pack "/alice/proj.git"')).toEqual({
      service: "git-receive-pack",
      ownerHandle: "alice",
      repoName: "proj",
    });
  });

  it("tolerates a missing leading slash", () => {
    expect(parseGitCommand("git-upload-pack 'alice/proj.git'")?.ownerHandle).toBe("alice");
  });

  it("tolerates a missing .git suffix", () => {
    expect(parseGitCommand("git-upload-pack '/alice/proj'")?.repoName).toBe("proj");
  });

  it("lowercases owner + repo", () => {
    expect(parseGitCommand("git-upload-pack '/Alice/Proj.git'")).toEqual({
      service: "git-upload-pack",
      ownerHandle: "alice",
      repoName: "proj",
    });
  });

  it("rejects non-git commands", () => {
    expect(parseGitCommand("rm -rf /")).toBeNull();
    expect(parseGitCommand("scp -t /tmp")).toBeNull();
    expect(parseGitCommand("git-shell")).toBeNull();
  });

  it("rejects a path that is not exactly owner/repo", () => {
    expect(parseGitCommand("git-upload-pack '/alice.git'")).toBeNull();
    expect(parseGitCommand("git-upload-pack '/a/b/c.git'")).toBeNull();
    expect(parseGitCommand("git-upload-pack ''")).toBeNull();
  });
});

// ─── access decisions ─────────────────────────────────────────────────────────

const repo = {
  id: "repo-1",
  ownerId: "owner-1",
  visibility: "PRIVATE" as const,
  storageKey: "owner/proj.git",
  collaborators: [{ userId: "writer-1", role: "WRITER" as const }, { userId: "reader-1", role: "READER" as const }],
};
const publicRepo = { ...repo, visibility: "PUBLIC" as const };

const userActor = (userId: string): SshActor => ({ kind: "user", userId, sshKeyId: "k", publicKey: "pk" });
const deployActor = (repoId: string, readOnly: boolean): SshActor => ({
  kind: "deploy",
  deployKeyId: "d",
  repoId,
  readOnly,
  publicKey: "pk",
});

function allowed(d: AccessDecision): boolean {
  return d.allowed;
}

describe("decideAccess — user SSH key", () => {
  it("owner can read and write", () => {
    expect(allowed(decideAccess(userActor("owner-1"), repo, "git-upload-pack"))).toBe(true);
    expect(allowed(decideAccess(userActor("owner-1"), repo, "git-receive-pack"))).toBe(true);
  });

  it("writer collaborator can read and write", () => {
    expect(allowed(decideAccess(userActor("writer-1"), repo, "git-upload-pack"))).toBe(true);
    expect(allowed(decideAccess(userActor("writer-1"), repo, "git-receive-pack"))).toBe(true);
  });

  it("reader collaborator can read but not write", () => {
    expect(allowed(decideAccess(userActor("reader-1"), repo, "git-upload-pack"))).toBe(true);
    expect(allowed(decideAccess(userActor("reader-1"), repo, "git-receive-pack"))).toBe(false);
  });

  it("stranger cannot read a private repo, and cannot write", () => {
    expect(allowed(decideAccess(userActor("nobody"), repo, "git-upload-pack"))).toBe(false);
    expect(allowed(decideAccess(userActor("nobody"), repo, "git-receive-pack"))).toBe(false);
  });

  it("anyone can read a public repo", () => {
    expect(allowed(decideAccess(userActor("nobody"), publicRepo, "git-upload-pack"))).toBe(true);
    // but still cannot push
    expect(allowed(decideAccess(userActor("nobody"), publicRepo, "git-receive-pack"))).toBe(false);
  });
});

describe("decideAccess — deploy key", () => {
  it("read-only deploy key can clone its repo but its push is REFUSED", () => {
    expect(allowed(decideAccess(deployActor("repo-1", true), repo, "git-upload-pack"))).toBe(true);
    const push = decideAccess(deployActor("repo-1", true), repo, "git-receive-pack");
    expect(push.allowed).toBe(false);
    expect(push.allowed === false && push.reason).toMatch(/read-only/i);
  });

  it("read-write deploy key can clone and push its repo", () => {
    expect(allowed(decideAccess(deployActor("repo-1", false), repo, "git-upload-pack"))).toBe(true);
    expect(allowed(decideAccess(deployActor("repo-1", false), repo, "git-receive-pack"))).toBe(true);
  });

  it("a deploy key cannot be used cross-repo (even read)", () => {
    const other = decideAccess(deployActor("some-other-repo", false), repo, "git-upload-pack");
    expect(other.allowed).toBe(false);
    expect(other.allowed === false && other.reason).toMatch(/not authorized/i);
  });

  it("a deploy key reads a private repo regardless of visibility", () => {
    expect(allowed(decideAccess(deployActor("repo-1", true), repo, "git-upload-pack"))).toBe(true);
  });
});
