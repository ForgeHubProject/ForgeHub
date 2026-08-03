import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { loadRepoTemplates, parseIssueTemplate } from "../repo-templates.js";

// ─── Front-matter parsing ─────────────────────────────────────────────────────

describe("parseIssueTemplate", () => {
  it("splits front-matter fields from the body", () => {
    const raw = [
      "---",
      "name: Bug report",
      "about: Something is broken",
      "labels: [bug, triage]",
      "---",
      "## Steps",
      "",
      "1. …",
      "",
    ].join("\n");

    const t = parseIssueTemplate(".forgehub/ISSUE_TEMPLATE/bug.md", raw);
    expect(t).toMatchObject({ name: "Bug report", about: "Something is broken", labels: ["bug", "triage"] });
    expect(t.body).toBe("## Steps\n\n1. …\n");
  });

  it("accepts a comma-separated labels string and de-dupes", () => {
    const raw = "---\nlabels: bug, bug , needs triage\n---\nbody\n";
    expect(parseIssueTemplate("x/feature.md", raw).labels).toEqual(["bug", "needs triage"]);
  });

  it("falls back to the filename when `name` is absent", () => {
    expect(parseIssueTemplate(".forgehub/ISSUE_TEMPLATE/feature-request.md", "just a body").name)
      .toBe("feature-request");
  });

  it("preserves the body byte-for-byte, including a leading blank line and trailing newline", () => {
    const raw = "---\nname: Spaced\n---\n\n  indented start\n\n\n";
    expect(parseIssueTemplate("t.md", raw).body).toBe("\n  indented start\n\n\n");
  });

  it("keeps a file with malformed front-matter whole rather than dropping it", () => {
    const raw = '---\nname: "unterminated\n---\nbody here\n';
    const t = parseIssueTemplate(".forgehub/ISSUE_TEMPLATE/broken.md", raw);
    expect(t.name).toBe("broken");
    expect(t.body).toBe(raw);
    expect(t.labels).toEqual([]);
  });

  it("ignores front-matter that isn't a mapping", () => {
    const raw = "---\n- a\n- b\n---\nbody\n";
    expect(parseIssueTemplate("t.md", raw).body).toBe(raw);
  });

  it("ignores non-string label entries and blank about", () => {
    const raw = "---\nabout: '   '\nlabels: [bug, 3, null]\n---\nbody";
    const t = parseIssueTemplate("t.md", raw);
    expect(t.about).toBeNull();
    expect(t.labels).toEqual(["bug"]);
  });

  it("handles CRLF front-matter delimiters", () => {
    const t = parseIssueTemplate("t.md", "---\r\nname: Win\r\n---\r\nbody\r\n");
    expect(t.name).toBe("Win");
    expect(t.body).toBe("body\r\n");
  });
});

// ─── Loading from a repo ──────────────────────────────────────────────────────

describe("loadRepoTemplates", () => {
  let repo: TestRepo;

  beforeAll(async () => {
    repo = await createTestRepo("test/templates.git");
    await makeCommit(repo.workDir, { "readme.txt": "hi" }, "init");
  });
  afterAll(async () => { await repo.cleanup(); });

  it("returns empty templates for a repo with no .forgehub/ directory", async () => {
    expect(await loadRepoTemplates(repo.storageKey)).toEqual({ issueTemplates: [], pullRequestTemplate: null });
  });

  it("returns empty templates when the repo has no git storage", async () => {
    expect(await loadRepoTemplates(null)).toEqual({ issueTemplates: [], pullRequestTemplate: null });
  });

  it("lists issue templates sorted by path and reads the PR template", async () => {
    await makeCommit(repo.workDir, {
      ".forgehub/ISSUE_TEMPLATE/zeta.md": "---\nname: Zeta\n---\nz body\n",
      ".forgehub/ISSUE_TEMPLATE/alpha.md": "---\nname: Alpha\nlabels: [bug]\n---\na body\n",
      ".forgehub/ISSUE_TEMPLATE/notes.txt": "not a template",
      ".forgehub/PULL_REQUEST_TEMPLATE.md": "\n## What changed\n\n",
    }, "add templates");

    const { issueTemplates, pullRequestTemplate } = await loadRepoTemplates(repo.storageKey);
    expect(issueTemplates.map((t) => t.name)).toEqual(["Alpha", "Zeta"]);
    expect(issueTemplates[0]!.path).toBe(".forgehub/ISSUE_TEMPLATE/alpha.md");
    expect(issueTemplates[0]!.labels).toEqual(["bug"]);
    // Byte-exact: the PR template's leading blank line and trailing newlines survive.
    expect(pullRequestTemplate).toEqual({
      path: ".forgehub/PULL_REQUEST_TEMPLATE.md",
      body: "\n## What changed\n\n",
    });
  });

  it("reads templates from an explicit ref", async () => {
    await makeCommit(
      repo.workDir,
      { ".forgehub/PULL_REQUEST_TEMPLATE.md": "branch template\n" },
      "branch template",
      "feature",
    );
    const onBranch = await loadRepoTemplates(repo.storageKey, "feature");
    expect(onBranch.pullRequestTemplate?.body).toBe("branch template\n");
  });

  it("returns empty templates for an unknown ref", async () => {
    expect(await loadRepoTemplates(repo.storageKey, "no-such-branch"))
      .toEqual({ issueTemplates: [], pullRequestTemplate: null });
  });
});
