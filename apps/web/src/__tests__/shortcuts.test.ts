import { describe, it, expect } from "vitest";
import { repoFromPath, resolveShortcut } from "../lib/shortcuts";

describe("repoFromPath", () => {
  it("finds the repository a page is in, and not site pages", () => {
    expect(repoFromPath("/ada/engine/pulls/3")).toEqual({ owner: "ada", name: "engine" });
    expect(repoFromPath("/ada")).toBeNull();
    expect(repoFromPath("/settings/keys")).toBeNull();
    expect(repoFromPath("/orgs/acme/settings")).toBeNull();
  });
});

describe("resolveShortcut", () => {
  it("g i and g p go to the repository's lists inside one, and yours elsewhere", () => {
    expect(resolveShortcut(["g", "i"], "/ada/engine/tree/main")).toEqual({ kind: "navigate", to: "/ada/engine/issues" });
    expect(resolveShortcut(["g", "p"], "/")).toEqual({ kind: "navigate", to: "/pulls" });
  });

  it("waits after g, and ignores a second key it doesn't know", () => {
    expect(resolveShortcut(["g"], "/")).toEqual({ kind: "pending" });
    expect(resolveShortcut(["g", "z"], "/")).toBeNull();
  });

  it("t finds a file only inside a repository; / and ? work anywhere", () => {
    expect(resolveShortcut(["t"], "/ada/engine")).toEqual({ kind: "focus", selector: "[data-shortcut='go-to-file']" });
    expect(resolveShortcut(["t"], "/")).toBeNull();
    expect(resolveShortcut(["/"], "/issues")).toEqual({ kind: "focus", selector: "#global-search" });
    expect(resolveShortcut(["?"], "/")).toEqual({ kind: "help" });
  });

  it("repository-only g letters do nothing outside a repository", () => {
    expect(resolveShortcut(["g", "c"], "/")).toBeNull();
    expect(resolveShortcut(["g", "a"], "/ada/engine")).toEqual({ kind: "navigate", to: "/ada/engine/actions" });
  });
});
