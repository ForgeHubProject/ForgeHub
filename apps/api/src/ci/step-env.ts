/**
 * The environment a CI step is allowed to see (issue #86, Tier 0).
 *
 * ⚠️  SECURITY-RELEVANT. READ THE WHOLE COMMENT BEFORE EDITING — INCLUDING THE
 *     "WHAT THIS DOES NOT DO" SECTION, WHICH IS THE IMPORTANT HALF. ⚠️
 *
 * A step is a `sh -c` of repo-author-controlled text. Before this module the
 * runner spawned it with `{ ...process.env, ...env }`, so every step received the
 * API process's whole environment — including `JWT_SECRET` — by DEFAULT, with no
 * intent required: `env` printed it, and any tool that reports its environment
 * shipped it off-box.
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
 * Anything NOT in the allowlist is absent from the environment this module hands
 * to `spawn` — `JWT_SECRET`, `DATABASE_URL`, `GIT_STORAGE_ROOT`,
 * `FORGEHUB_CI_ROOT` and any SMTP/mail credential are not filtered out, they are
 * simply never copied in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO — READ THIS BEFORE WRITING ANY SECURITY CLAIM ABOUT IT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This module is NOT a secrecy boundary, and a step that WANTS the API's secrets
 * still gets them. `runner.ts` spawns each step as a direct child of the API
 * process, running as the same OS user. Linux exposes a process's exec-time
 * environment at `/proc/<pid>/environ`, readable by any process with the same
 * credentials. So a step can do:
 *
 *     tr '\0' '\n' < /proc/$PPID/environ      # or /proc/1/environ in a container,
 *                                             # where the API is PID 1
 *
 * and recover `JWT_SECRET` and everything else verbatim. This is verified, not
 * theoretical — see `__tests__/ci-step-env-residual.test.ts`, which performs the
 * read in exactly the parent/child topology `runProcess` creates and FAILS if it
 * ever stops working (at which point this comment and the README need updating,
 * which is the entire reason that test exists).
 *
 * Note also that `/proc/<pid>/environ` is a snapshot of the exec-time stack, not
 * a view of `process.env`. Deleting a variable from `process.env` at runtime does
 * NOT remove it from `/proc`, so "scrub the secret after boot" is not a fix
 * either. Neither is moving the secret into a file (`JWT_SECRET_FILE`, a Docker
 * secret): a step running as the API's uid can simply read any file the API can
 * read. While ONE process is both the API and the runner, every secret the API
 * holds is reachable by every step, full stop.
 *
 * What the allowlist is actually worth, then:
 *
 *   - it stops the ACCIDENTAL leak — a step that innocently logs `env`, or a
 *     third-party tool that uploads its environment with a crash report, no
 *     longer ships the instance's secrets off-box as a side effect;
 *   - it makes the intentional leak a deliberate, legible act rather than the
 *     default;
 *   - it is the half of the fix that has to exist anyway. Once the runner is a
 *     separate process under its own uid (the next stage of #86), the `/proc`
 *     path closes on its own and THIS allowlist is what makes the environment
 *     side of that boundary real. Landing it now means the boundary arrives in
 *     one step rather than two.
 *
 * It is containment, not isolation. Do not write "structurally absent from every
 * step", "steps cannot see JWT_SECRET", or anything else that a reader could act
 * on as a guarantee. A step still runs as the API's OS user on the API's
 * filesystem and can reach the database, the bare repos and the API process's own
 * environment. The boundary itself is the later stage of #86.
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
