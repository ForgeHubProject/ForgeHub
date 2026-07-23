import path from "node:path";
import { parse as parseYaml } from "yaml";
import { git } from "../git-utils.js";

/**
 * Workflow definition format (issue #86, v0).
 *
 * A workflow file lives at `.forgehub/workflows/*.yml` in the pushed commit:
 *
 *   name: CI
 *   on: [push, pull_request]        # string | list | map — keys/values, no filters v0
 *   jobs:
 *     build:
 *       name: Build                 # optional; defaults to the job id
 *       steps:
 *         - name: Install           # optional step label
 *           run: npm ci             # required shell command
 *         - run: npm test
 *
 * v0 is deliberately tiny: no marketplace actions, no reusable workflows, no
 * matrix/filters/caching/artifacts. Each step is a shell command run with
 * `sh -c` in a fresh checkout of the triggering commit.
 */

export type CiEvent = "push" | "pull_request";

export type WorkflowStep = {
  name?: string;
  run: string;
};

export type WorkflowJob = {
  id: string;
  name: string;
  steps: WorkflowStep[];
};

export type ParsedWorkflow = {
  name: string;
  /** The subset of {push, pull_request} this workflow triggers on. */
  events: CiEvent[];
  jobs: WorkflowJob[];
};

export type ParseResult =
  | { ok: true; workflow: ParsedWorkflow }
  | { ok: false; error: string };

const KNOWN_EVENTS: readonly CiEvent[] = ["push", "pull_request"];

/** Collect the recognized event names from an `on:` value (string | list | map). */
function extractEvents(on: unknown): CiEvent[] {
  const found = new Set<CiEvent>();
  const add = (v: unknown) => {
    if (typeof v === "string" && (KNOWN_EVENTS as readonly string[]).includes(v)) {
      found.add(v as CiEvent);
    }
  };
  if (typeof on === "string") add(on);
  else if (Array.isArray(on)) for (const v of on) add(v);
  else if (on && typeof on === "object") for (const k of Object.keys(on as object)) add(k);
  return KNOWN_EVENTS.filter((e) => found.has(e));
}

/**
 * Parse a workflow YAML document into a normalized workflow, or return the first
 * validation error as human-readable text. On failure the trigger layer records a
 * CheckRun that FAILS with this text as its log so the author sees the mistake —
 * a bad file never crashes the push.
 *
 * `defaultName` (the file basename) is used when the document omits `name`.
 */
export function parseWorkflowYaml(text: string, defaultName: string): ParseResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `YAML parse error: ${msg}` };
  }

  if (doc === null || doc === undefined) {
    return { ok: false, error: "Workflow file is empty." };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "Workflow must be a YAML mapping at the top level." };
  }
  const root = doc as Record<string, unknown>;

  const name =
    typeof root["name"] === "string" && root["name"].trim() ? root["name"].trim() : defaultName;

  if (!("on" in root) || root["on"] === null || root["on"] === undefined) {
    return { ok: false, error: "Workflow is missing the required 'on' field." };
  }
  const events = extractEvents(root["on"]);

  const rawJobs = root["jobs"];
  if (!rawJobs || typeof rawJobs !== "object" || Array.isArray(rawJobs)) {
    return { ok: false, error: "Workflow must define a 'jobs' mapping." };
  }
  const jobEntries = Object.entries(rawJobs as Record<string, unknown>);
  if (jobEntries.length === 0) {
    return { ok: false, error: "Workflow defines no jobs." };
  }

  const jobs: WorkflowJob[] = [];
  for (const [jobId, rawJob] of jobEntries) {
    if (!rawJob || typeof rawJob !== "object" || Array.isArray(rawJob)) {
      return { ok: false, error: `Job '${jobId}' must be a mapping.` };
    }
    const job = rawJob as Record<string, unknown>;
    const jobName =
      typeof job["name"] === "string" && job["name"].trim() ? job["name"].trim() : jobId;

    const rawSteps = job["steps"];
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      return { ok: false, error: `Job '${jobId}' must define a non-empty 'steps' list.` };
    }
    const steps: WorkflowStep[] = [];
    rawSteps.forEach((rawStep, i) => {
      if (rawStep && typeof rawStep === "object" && !Array.isArray(rawStep)) {
        const step = rawStep as Record<string, unknown>;
        const run = step["run"];
        if (typeof run === "string" && run.trim()) {
          const stepName = typeof step["name"] === "string" && step["name"].trim() ? step["name"].trim() : undefined;
          steps.push(stepName ? { name: stepName, run } : { run });
          return;
        }
      }
      throw new StepError(`Step ${i + 1} of job '${jobId}' must have a non-empty 'run' command.`);
    });

    jobs.push({ id: jobId, name: jobName, steps });
  }

  return { ok: true, workflow: { name, events, jobs } };
}

// Thrown inside the forEach above; caught by the wrapper below. Keeps the happy
// path linear without an index-based for-loop label.
class StepError extends Error {}

/** Same as parseWorkflowYaml but converts a thrown StepError into a ParseResult. */
export function parseWorkflow(text: string, defaultName: string): ParseResult {
  try {
    return parseWorkflowYaml(text, defaultName);
  } catch (err) {
    if (err instanceof StepError) return { ok: false, error: err.message };
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Workflow parse error: ${msg}` };
  }
}

export type WorkflowFile = { path: string; content: string };

/**
 * List `.forgehub/workflows/*.yml|*.yaml` files present in a commit's tree along
 * with their contents. Returns [] when the directory is absent (→ no runs).
 */
export async function listWorkflowFilesAtCommit(
  storageKey: string,
  commitSha: string,
): Promise<WorkflowFile[]> {
  let treeOut: string;
  try {
    // -r recurses; paths are relative to repo root. Restrict to the workflows dir.
    treeOut = await git(storageKey, ["ls-tree", "-r", "--name-only", commitSha, ".forgehub/workflows/"]);
  } catch {
    return [];
  }
  const paths = treeOut
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.endsWith(".yml") || p.endsWith(".yaml"));

  const files: WorkflowFile[] = [];
  for (const p of paths) {
    try {
      const content = await git(storageKey, ["show", `${commitSha}:${p}`]);
      files.push({ path: p, content });
    } catch {
      // A file that vanished between ls-tree and show is simply skipped.
    }
  }
  return files;
}

/** Display name for a workflow file when it omits `name:` — the basename sans extension. */
export function defaultWorkflowName(filePath: string): string {
  const base = path.basename(filePath);
  return base.replace(/\.(ya?ml)$/i, "");
}
