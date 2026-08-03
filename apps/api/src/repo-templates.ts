import { parse as parseYaml } from "yaml";
import { defaultBranch, git, readFileAtRefExact, resolveBranchSha } from "./git-utils.js";

/**
 * Issue / pull-request templates read from the repo itself (issue #89) — the
 * same "files in the repo drive behavior" pattern as `.forge/formats` and
 * `.forgehub/workflows`:
 *
 *   .forgehub/ISSUE_TEMPLATE/*.md   — many, each with optional YAML front-matter
 *   .forgehub/PULL_REQUEST_TEMPLATE.md — one
 *
 * Front-matter is a tiny subset: `name`, `about`, `labels` (list or
 * comma-separated string). Anything unparseable is IGNORED rather than fatal —
 * a broken template must never take out the compose page, so a file whose
 * front-matter fails to parse is served whole, as its own body.
 */

export type IssueTemplate = {
  /** Repo-relative path, e.g. `.forgehub/ISSUE_TEMPLATE/bug.md`. */
  path: string;
  /** Display name — front-matter `name`, else the filename without `.md`. */
  name: string;
  about: string | null;
  /** Front-matter label NAMES; the caller resolves them against the repo's `Label` rows. */
  labels: string[];
  /** Template text with the front-matter block removed, byte-for-byte otherwise. */
  body: string;
};

export type PullRequestTemplate = {
  path: string;
  body: string;
};

export type RepoTemplates = {
  issueTemplates: IssueTemplate[];
  pullRequestTemplate: PullRequestTemplate | null;
};

export const ISSUE_TEMPLATE_DIR = ".forgehub/ISSUE_TEMPLATE";
export const PULL_REQUEST_TEMPLATE_PATH = ".forgehub/PULL_REQUEST_TEMPLATE.md";

/** `---\n…\n---` at the very start of the file, ending on its own line. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Coerce a front-matter `labels:` value (list | comma-separated string) to names. */
function toLabelNames(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Front-matter string field, or null when absent/blank/not a string. */
function toText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Split a template file into its front-matter fields and its body. A file with
 * no front-matter (or with front-matter that isn't a YAML mapping) is all body,
 * returned unchanged — the exact bytes are what the compose box shows.
 */
export function parseIssueTemplate(path: string, raw: string): IssueTemplate {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const fallbackName = filename.replace(/\.md$/i, "");

  const match = FRONT_MATTER.exec(raw);
  if (!match) return { path, name: fallbackName, about: null, labels: [], body: raw };

  let fields: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = parseYaml(match[1] ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fields = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed front-matter: keep the file whole rather than dropping the template.
  }
  if (!fields) return { path, name: fallbackName, about: null, labels: [], body: raw };

  return {
    path,
    name: toText(fields["name"]) ?? fallbackName,
    about: toText(fields["about"]),
    labels: toLabelNames(fields["labels"]),
    body: raw.slice(match[0].length),
  };
}

/** `.md` files directly under the ISSUE_TEMPLATE dir, sorted by path. */
async function listIssueTemplatePaths(storageKey: string, ref: string): Promise<string[]> {
  let out: string;
  try {
    // Non-recursive: nested directories are not a template location.
    out = await git(storageKey, ["ls-tree", "--name-only", ref, `${ISSUE_TEMPLATE_DIR}/`]);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.toLowerCase().endsWith(".md"))
    .sort();
}

/**
 * Load every template at a ref (default branch when `ref` is omitted). Absent
 * directory / absent file → empty list / null. Fully defensive: any git failure
 * yields empty templates so the compose forms degrade to a blank box.
 */
export async function loadRepoTemplates(
  storageKey: string | null,
  ref?: string,
): Promise<RepoTemplates> {
  const empty: RepoTemplates = { issueTemplates: [], pullRequestTemplate: null };
  if (!storageKey) return empty;

  try {
    const branch = ref ?? (await defaultBranch(storageKey));
    // Pin to a commit so the listing and the reads see one consistent tree.
    const sha = await resolveBranchSha(storageKey, branch);
    if (!sha) return empty;

    const paths = await listIssueTemplatePaths(storageKey, sha);
    const issueTemplates: IssueTemplate[] = [];
    for (const path of paths) {
      const raw = await readFileAtRefExact(storageKey, sha, path);
      // A file that vanished between ls-tree and show is simply skipped.
      if (raw !== null) issueTemplates.push(parseIssueTemplate(path, raw));
    }

    const prRaw = await readFileAtRefExact(storageKey, sha, PULL_REQUEST_TEMPLATE_PATH);
    return {
      issueTemplates,
      pullRequestTemplate: prRaw === null ? null : { path: PULL_REQUEST_TEMPLATE_PATH, body: prRaw },
    };
  } catch {
    return empty;
  }
}
