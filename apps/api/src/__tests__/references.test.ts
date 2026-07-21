import { describe, it, expect } from "vitest";
import { parseReferences, stripCode } from "../references.js";

describe("parseReferences — issue/pull refs", () => {
  it("resolves #N to issues and !N to pull requests (GitLab-style)", () => {
    const r = parseReferences("Fixes the thing in #12 and supersedes !7");
    expect(r.issues).toEqual([12]);
    expect(r.pulls).toEqual([7]);
  });

  it("de-duplicates and sorts numbers", () => {
    const r = parseReferences("#3 #1 #3 #2 !5 !5");
    expect(r.issues).toEqual([1, 2, 3]);
    expect(r.pulls).toEqual([5]);
  });

  it("does not match mid-word or trailing-alphanumeric refs", () => {
    const r = parseReferences("color C#7, item#3, #5abc, and version 1#2x");
    expect(r.issues).toEqual([]);
    expect(r.pulls).toEqual([]);
  });

  it("matches refs adjacent to punctuation", () => {
    const r = parseReferences("(see #4) [also #9]. done.");
    expect(r.issues).toEqual([4, 9]);
  });
});

describe("parseReferences — closing keywords", () => {
  it("captures closes/fixes/resolves and their inflections", () => {
    const r = parseReferences("closes #1, fixes #2, resolved #3, Fix #4");
    expect(r.closesIssues).toEqual([1, 2, 3, 4]);
    // closing refs are also plain issue refs
    expect(r.issues).toEqual([1, 2, 3, 4]);
  });

  it("does not treat a bare #N as closing", () => {
    const r = parseReferences("relates to #8 but does not close it");
    expect(r.closesIssues).toEqual([]);
    expect(r.issues).toEqual([8]);
  });

  it("does not match closing keywords embedded in a larger word", () => {
    const r = parseReferences("unclosefix #8 prefixes #9");
    expect(r.closesIssues).toEqual([]);
  });
});

describe("parseReferences — mentions", () => {
  it("captures @handles, lower-cased and de-duplicated", () => {
    const r = parseReferences("cc @Alice and @bob, thanks @alice");
    expect(r.mentions).toEqual(["alice", "bob"]);
  });

  it("does not treat email addresses as mentions", () => {
    const r = parseReferences("reach me at foo@bar.com or @carol");
    expect(r.mentions).toEqual(["carol"]);
  });

  it("does not match @ after a slash", () => {
    const r = parseReferences("path/@notahandle and @real");
    expect(r.mentions).toEqual(["real"]);
  });
});

describe("parseReferences — code is not parsed", () => {
  it("ignores references inside inline code spans", () => {
    const r = parseReferences("literal `#5` and `@nobody` but real #6");
    expect(r.issues).toEqual([6]);
    expect(r.mentions).toEqual([]);
  });

  it("ignores references inside fenced code blocks", () => {
    const body = ["before #1", "```", "closes #2 @ghost !3", "```", "after @real"].join("\n");
    const r = parseReferences(body);
    expect(r.issues).toEqual([1]);
    expect(r.pulls).toEqual([]);
    expect(r.closesIssues).toEqual([]);
    expect(r.mentions).toEqual(["real"]);
  });

  it("strips tilde-fenced blocks too", () => {
    expect(stripCode("~~~\n#9\n~~~").includes("#9")).toBe(false);
  });
});

describe("parseReferences — empty/edge", () => {
  it("returns empty structure for null/empty bodies", () => {
    expect(parseReferences(null)).toEqual({ issues: [], pulls: [], mentions: [], closesIssues: [] });
    expect(parseReferences("")).toEqual({ issues: [], pulls: [], mentions: [], closesIssues: [] });
  });
});
