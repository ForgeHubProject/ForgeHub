import { describe, it, expect } from "vitest";
import { parseAllowedMethods, repoMergePolicy } from "../merge-policy.js";

describe("parseAllowedMethods", () => {
  it("parses the stored comma-separated set in canonical order", () => {
    expect(parseAllowedMethods("rebase,merge")).toEqual(["merge", "rebase"]);
  });

  it("drops unknown entries and whitespace", () => {
    expect(parseAllowedMethods(" squash , octopus ")).toEqual(["squash"]);
  });

  it("falls back to everything for an empty/absent/corrupt value", () => {
    expect(parseAllowedMethods("")).toEqual(["merge", "squash", "rebase"]);
    expect(parseAllowedMethods(null)).toEqual(["merge", "squash", "rebase"]);
    expect(parseAllowedMethods("octopus")).toEqual(["merge", "squash", "rebase"]);
  });
});

describe("repoMergePolicy", () => {
  it("uses the stored default when it is allowed", () => {
    expect(repoMergePolicy({ allowedMergeMethods: "merge,squash", defaultMergeMethod: "squash" }))
      .toEqual({ allowedMethods: ["merge", "squash"], defaultMethod: "squash" });
  });

  it("snaps a default outside the allowed set to the first allowed method", () => {
    expect(repoMergePolicy({ allowedMergeMethods: "squash,rebase", defaultMergeMethod: "merge" }))
      .toEqual({ allowedMethods: ["squash", "rebase"], defaultMethod: "squash" });
  });

  it("defaults fully open for a repo row without policy columns", () => {
    expect(repoMergePolicy({})).toEqual({
      allowedMethods: ["merge", "squash", "rebase"],
      defaultMethod: "merge",
    });
  });
});
