import type { GithubOrgRepo, OrgImportRepo } from "../api";

// Picking which of a GitHub organization's repositories to import, and reading how it goes (#308).

/** `https://github.com/<org>[/]` or `<org>`, as the server reads it; null when it isn't one. */
export function githubOrgLogin(input: string): string | null {
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/?$/.exec(input.trim());
  return m ? m[1]! : null;
}

/** The name a repository gets here: GitHub's, lowercased. */
export const nameHere = (githubName: string) => githubName.toLowerCase();

/** Ticked to start with: everything that can come over, except forks. */
export function defaultPicks(repos: GithubOrgRepo[], maxSizeKb: number): Set<string> {
  return new Set(repos.filter((r) => !r.fork && r.sizeKb <= maxSizeKb).map((r) => r.name));
}

/** "Waiting", "Importing", "Failed" or "Imported", counting the issues, pull requests and releases as part of it. */
export function importPhase(r: Pick<OrgImportRepo, "status" | "issues">): "waiting" | "importing" | "failed" | "imported" {
  if (r.status === "queued") return "waiting";
  if (r.status === "importing") return "importing";
  if (r.status === "failed" || r.issues?.error) return "failed";
  return r.issues && r.issues.stage !== "done" ? "importing" : "imported";
}

/** Whether anything is still to happen, so the page keeps asking. */
export const stillGoing = (repos: Array<Pick<OrgImportRepo, "status" | "issues">>) =>
  repos.some((r) => {
    const phase = importPhase(r);
    return phase === "waiting" || phase === "importing";
  });
