/**
 * Importing a GitHub organization (#308): reading what the person typed, what
 * starts ticked, how each repository's import reads, and the picking form.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { GithubOrg, OrgImportRepo } from "../api";
import { defaultPicks, githubOrgLogin, importPhase, nameHere, stillGoing } from "../lib/orgImport";
import { OrgImportForm } from "../pages/ImportOrgPage";

const repo = (name: string, extra: Partial<GithubOrg["repos"][number]> = {}) =>
  ({ name, description: null, sizeKb: 100, fork: false, archived: false, ...extra });

describe("githubOrgLogin", () => {
  it.each([
    ["pallets", "pallets"],
    [" https://github.com/Octo-Org/ ", "Octo-Org"],
  ])("reads %j", (input, login) => expect(githubOrgLogin(input)).toBe(login));

  it.each(["", "octo/hello", "https://github.com/octo/hello", "http://github.com/octo", "-x", "a".repeat(40)])(
    "refuses %j",
    (input) => expect(githubOrgLogin(input)).toBeNull(),
  );
});

describe("picking repositories", () => {
  it("starts with everything that can come over ticked, except forks", () => {
    const picks = defaultPicks([repo("flask"), repo("fork", { fork: true }), repo("huge", { sizeKb: 2_000_000 }), repo("old", { archived: true })], 1_048_576);
    expect([...picks]).toEqual(["flask", "old"]);
  });

  it("names each the way GitHub does, lowercased", () => {
    expect(nameHere("MarkupSafe")).toBe("markupsafe");
  });
});

describe("how an import reads", () => {
  const issues = (extra: Partial<NonNullable<OrgImportRepo["issues"]>> = {}) =>
    ({ stage: "done" as const, issues: 1, pulls: 0, comments: 0, releases: 0, waitUntil: null, error: null, ...extra });

  it.each([
    [{ status: "queued", issues: null }, "waiting"],
    [{ status: "importing", issues: issues({ stage: "labels" }) }, "importing"],
    [{ status: "done", issues: issues({ stage: "pulls" }) }, "importing"],
    [{ status: "done", issues: issues() }, "imported"],
    [{ status: "done", issues: null }, "imported"],
    [{ status: "failed", issues: null }, "failed"],
    [{ status: "done", issues: issues({ stage: "comments", error: "GitHub answered 500" }) }, "failed"],
  ] as const)("%j is %s", (r, phase) => expect(importPhase(r as Pick<OrgImportRepo, "status" | "issues">)).toBe(phase));

  it("keeps asking while anything is waiting or importing", () => {
    expect(stillGoing([{ status: "done", issues: null }, { status: "failed", issues: null }])).toBe(false);
    expect(stillGoing([{ status: "done", issues: null }, { status: "queued", issues: null }])).toBe(true);
    expect(stillGoing([{ status: "done", issues: issues({ stage: "releases" }) }])).toBe(true);
  });
});

describe("OrgImportForm", () => {
  const org: GithubOrg = {
    login: "pallets", displayName: "Pallets", description: "Python projects", truncated: false, maxSizeKb: 1_048_576,
    website: "https://palletsprojects.com", location: null, avatarUrl: "https://avatars.githubusercontent.com/u/16748505?v=4",
    repos: [repo("Flask", { description: "Web framework" }), repo("click-fork", { fork: true }), repo("huge", { sizeKb: 2_000_000 }), repo("old", { archived: true })],
  };
  const render = (o: GithubOrg = org) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <OrgImportForm token="t" org={o} owned={[]} onDone={() => {}} />
      </MemoryRouter>,
    );

  it("lists the repositories with forks unticked, the too-big one off, and a name here for each picked one", () => {
    const html = render();
    expect(html).toContain("2 of 4 picked");
    expect(html).toContain("Import 2 repositories");
    expect(html).toMatch(/<input(?=[^>]*aria-label="Name for Flask here")(?=[^>]*value="flask")[^>]*>/);
    expect(html).not.toContain('aria-label="Name for click-fork here"');
    expect(html).toContain("Over 1 GB, can&#x27;t be imported");
    expect(html).toContain(">Fork<");
    expect(html).toContain(">Archived<");
  });

  it("offers a new organization named after GitHub's, and no existing one to someone who owns none", () => {
    const html = render();
    expect(html).toMatch(/id="import-org-handle"[^>]*value="pallets"|value="pallets"[^>]*id="import-org-handle"/);
    expect(html).toContain("You don&#x27;t own an organization yet.");
  });

  it("says when GitHub's list was cut short, and when there's nothing to bring", () => {
    expect(render({ ...org, truncated: true })).toContain("Only the first 1,000 repositories are listed.");
    expect(render({ ...org, repos: [] })).toContain("github.com/pallets has no public repositories.");
  });
});
