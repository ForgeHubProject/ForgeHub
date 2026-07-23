import { describe, it, expect } from "vitest";
import { avatarSrc } from "../api";

describe("avatarSrc", () => {
  it("returns null when the user has no uploaded avatar", () => {
    expect(avatarSrc("alice", null)).toBeNull();
    expect(avatarSrc("alice", undefined)).toBeNull();
    expect(avatarSrc("alice", "")).toBeNull();
  });

  it("builds a handle-scoped URL with the avatarKey as a cache-buster", () => {
    const url = avatarSrc("alice", "deadbeef");
    expect(url).toContain("/users/alice/avatar");
    expect(url).toContain("v=deadbeef");
  });

  it("encodes the cache-buster token", () => {
    const url = avatarSrc("alice", "a b/c");
    expect(url).toContain("v=a%20b%2Fc");
  });
});
