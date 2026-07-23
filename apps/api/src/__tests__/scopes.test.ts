import { describe, it, expect } from "vitest";
import {
  hasScope, parseScopes, serializeScopes, normalizeRequestedScopes, FULL_SCOPES,
} from "../scopes.js";

describe("PAT scope hierarchy (hasScope)", () => {
  it("admin grants every scope", () => {
    expect(hasScope(["admin"], "repo:read")).toBe(true);
    expect(hasScope(["admin"], "repo:write")).toBe(true);
    expect(hasScope(["admin"], "admin")).toBe(true);
  });

  it("repo:write implies repo:read but not admin", () => {
    expect(hasScope(["repo:write"], "repo:read")).toBe(true);
    expect(hasScope(["repo:write"], "repo:write")).toBe(true);
    expect(hasScope(["repo:write"], "admin")).toBe(false);
  });

  it("repo:read is least privilege", () => {
    expect(hasScope(["repo:read"], "repo:read")).toBe(true);
    expect(hasScope(["repo:read"], "repo:write")).toBe(false);
    expect(hasScope(["repo:read"], "admin")).toBe(false);
  });

  it("the full set grants everything", () => {
    for (const s of FULL_SCOPES) expect(hasScope(FULL_SCOPES, s)).toBe(true);
  });

  it("an empty scope set grants nothing", () => {
    expect(hasScope([], "repo:read")).toBe(false);
    expect(hasScope([], "admin")).toBe(false);
  });
});

describe("scope (de)serialization", () => {
  it("parses the stored column, dropping unknown entries", () => {
    expect(parseScopes("admin,bogus,repo:read")).toEqual(["admin", "repo:read"]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
  });

  it("serializes deduped + in canonical order", () => {
    expect(serializeScopes(["admin", "repo:read", "repo:read"])).toBe("repo:read,admin");
    expect(serializeScopes(["repo:write", "repo:read", "admin"])).toBe("repo:read,repo:write,admin");
  });

  it("normalizes a requested subset, falling back to full when empty/invalid", () => {
    expect(normalizeRequestedScopes(["repo:read"])).toEqual(["repo:read"]);
    expect(normalizeRequestedScopes([])).toEqual([...FULL_SCOPES]);
    expect(normalizeRequestedScopes(["nope"])).toEqual([...FULL_SCOPES]);
    expect(normalizeRequestedScopes("not-an-array")).toEqual([...FULL_SCOPES]);
  });
});
