import { describe, it, expect } from "vitest";
import { repoNameFromUrl } from "../pages/ImportRepoPage";

// The import page offers the GitHub repository's own name for the new one (#289).
describe("repoNameFromUrl", () => {
  it.each([
    ["https://github.com/octocat/Hello-World", "hello-world"],
    ["https://github.com/octocat/Hello-World.git", "hello-world"],
    ["https://github.com/octocat/Hello-World.git/", "hello-world"],
    [" octocat/hello.world_2 ", "hello.world_2"],
  ])("%j → %j", (url, name) => {
    expect(repoNameFromUrl(url)).toBe(name);
  });

  it.each(["", "octocat", "https://github.com", "https://github.com/", "octocat/Hello World"])("nothing for %j", (url) => {
    expect(repoNameFromUrl(url)).toBe("");
  });
});
