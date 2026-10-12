import { describe, it, expect } from "vitest";
import { sshCloneUrl } from "../api";

describe("sshCloneUrl", () => {
  it("uses the browser hostname and configured port", () => {
    expect(sshCloneUrl({ handle: "alice", repoName: "proj", sshPort: 2222, hostname: "forge.example.com" })).toBe(
      "ssh://git@forge.example.com:2222/alice/proj.git",
    );
  });

  it("prefers an explicit server host override when set (here on port 22)", () => {
    expect(
      sshCloneUrl({ handle: "alice", repoName: "proj", sshPort: 22, sshHost: "git.internal", hostname: "localhost" }),
    ).toBe("git@git.internal:alice/proj.git");
  });

  it("drops the port and the ssh:// scheme on the standard port 22", () => {
    expect(sshCloneUrl({ handle: "alice", repoName: "proj", sshPort: 22, hostname: "forge.example.com" })).toBe(
      "git@forge.example.com:alice/proj.git",
    );
  });

  it("falls back to the hostname when the override is null/empty", () => {
    expect(sshCloneUrl({ handle: "a", repoName: "b", sshPort: 2252, sshHost: null, hostname: "127.0.0.1" })).toBe(
      "ssh://git@127.0.0.1:2252/a/b.git",
    );
    expect(sshCloneUrl({ handle: "a", repoName: "b", sshPort: 2252, sshHost: "", hostname: "127.0.0.1" })).toBe(
      "ssh://git@127.0.0.1:2252/a/b.git",
    );
  });
});
