/**
 * The environment a CI step is allowed to see (issue #86, Tier 0).
 *
 * ⚠️  THIS FILE IS A SECURITY BOUNDARY. READ BEFORE EDITING. ⚠️
 *
 * A step is a `sh -c` of repo-author-controlled text. Before this module the
 * runner spawned it with `{ ...process.env, ...env }`, so every step received the
 * API process's whole environment — including `JWT_SECRET`. One `env | curl` step
 * was therefore enough to mint valid sessions for any user, including admins,
 * indefinitely and long after the run ended. That is the one consequence of the
 * missing sandbox that is PERMANENT: no isolation boundary added later un-leaks a
 * secret that has already left the box.
 *
 * So the step environment is CONSTRUCTED, never inherited:
 *
 *   1. copy in the handful of variables named in `BASE_ENV_ALLOWLIST`;
 *   2. layer the runner's own fixed variables over that;
 *   3. layer the workflow's / job's `env:` map on top.
 *
 * It is an ALLOWLIST on purpose. A denylist ("strip JWT_SECRET, DATABASE_URL, …")
 * fails open the moment someone adds the next secret to the deployment — the new
 * variable is leaked by default and nothing in the test suite notices. An
 * allowlist fails closed: a new variable is invisible to steps until someone
 * deliberately adds its name here, which is a reviewable diff.
 *
 * Anything NOT in the allowlist is structurally absent — `JWT_SECRET`,
 * `DATABASE_URL`, `GIT_STORAGE_ROOT`, `FORGEHUB_CI_ROOT` and any SMTP/mail
 * credential are not filtered out, they are simply never copied in.
 *
 * NOTE ON SCOPE: this denies steps the API's *secrets*. It is NOT isolation. A
 * step still runs as the API's OS user on the API's filesystem and can reach the
 * database and the bare repos by absolute path if it knows where to look. The
 * boundary itself is the later stage of #86 (extract the runner, then contain it).
 */

/**
 * Variables copied from the API process. Every entry must be justifiable as
 * "a step cannot run without this, and it carries no credential".
 *
 * DO NOT add a variable here to make a workflow work — put it in the workflow's
 * own `env:` map instead. Adding a name here widens the boundary for every repo
 * on the instance at once.
 */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  "PATH", // without it `sh -c` cannot find any binary
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
];

/** Fallback when the API itself was started without a PATH (systemd can do this). */
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Copy the allowlisted variables out of the API's environment. Never a secret. */
function allowlistedBase(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") out[key] = value;
  }
  if (!out["PATH"]) out["PATH"] = DEFAULT_PATH;
  return out;
}

/**
 * The environment for one workflow step.
 *
 * `HOME` is pinned to the job's own workspace rather than inherited: the API
 * user's home holds `~/.gitconfig`, `~/.ssh` and `~/.npmrc`, and a step that can
 * write those influences the API process itself on the next git operation. A
 * throwaway per-job HOME also means credential helpers and tool caches a step
 * creates die with the workspace.
 *
 * `workflowEnv` is layered LAST so a workflow can override anything above —
 * including PATH and HOME. That is deliberate: those are the step author's own
 * values in the step author's own shell, and nothing here is a secret worth
 * defending against its owner.
 */
export function buildStepEnv(workflowEnv: Record<string, string>, workspace: string): Record<string, string> {
  return {
    ...allowlistedBase(),
    HOME: workspace,
    // Conventional CI markers, so ordinary tooling behaves as it does elsewhere.
    CI: "true",
    FORGEHUB: "true",
    // Never let a step block on an interactive credential prompt.
    GIT_TERMINAL_PROMPT: "0",
    ...workflowEnv,
  };
}

/**
 * The environment for the runner's OWN git invocations (the workspace clone and
 * checkout). Not author-controlled, but built from the same allowlist so that the
 * clone cannot become a side channel for the variables steps are denied — and so
 * there is exactly one place in this file that reads `process.env`.
 */
export function buildRunnerGitEnv(): Record<string, string> {
  const base = allowlistedBase();
  const home = process.env["HOME"];
  return {
    ...base,
    ...(home ? { HOME: home } : {}),
    GIT_TERMINAL_PROMPT: "0",
  };
}
