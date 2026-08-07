import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { buildStepEnv } from "../ci/step-env.js";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS TEST PINS A KNOWN, DOCUMENTED WEAKNESS. IT IS SUPPOSED TO PASS TODAY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `step-env.ts` builds a step's environment from an allowlist so the API's
 * secrets are not handed to steps by default. It is easy — and wrong — to read
 * that as "a step cannot see JWT_SECRET". It cannot, in its own environment. It
 * absolutely can via `/proc`:
 *
 *   `runner.ts` spawns each step as a DIRECT CHILD of the API process, running as
 *   the SAME OS user. Linux publishes a process's exec-time environment at
 *   `/proc/<pid>/environ`, readable by any process with matching credentials. So
 *   `tr '\0' '\n' < /proc/$PPID/environ` — or `/proc/1/environ` in the shipped
 *   compose stack, where the API is PID 1 — hands the step every variable the API
 *   was started with, verbatim. `process.env` deletions do not help: `/proc`
 *   reflects the exec-time stack, not the runtime object.
 *
 * The test below performs exactly that read, in exactly the parent/child topology
 * `runProcess` creates, and asserts it SUCCEEDS. Two reasons it is written this
 * way rather than left as a comment:
 *
 *   1. It is the evidence for the disclosure in README.md and `step-env.ts`. A
 *      security note nobody can execute rots into a security note nobody trusts.
 *   2. It is a tripwire on the docs. The day the runner is extracted into its own
 *      process under its own uid (the next stage of #86), this test FAILS — and
 *      the failure message tells whoever did it to go delete the caveat they have
 *      just made obsolete. Without it, the "steps can still read /proc" warning
 *      would quietly outlive the problem, which is its own kind of wrong.
 *
 * If you are here because this test failed: that is very likely GOOD NEWS. Verify
 * the boundary really closed, then delete this file and the residual-leak
 * paragraphs in `step-env.ts`, `runner.ts` and README.md.
 */

const SENTINEL = "sentinel-jwt-secret-6f2b9c1e";

/** /proc/<pid>/environ only exists on Linux; elsewhere the mechanism is different. */
function hasProcEnviron(): boolean {
  try {
    accessSync(`/proc/${process.pid}/environ`, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a step the way `runProcess` does — same `detached: true`, same constructed
 * environment from `buildStepEnv` — and return what it printed.
 */
function runStep(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", script], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildStepEnv({}, process.cwd()),
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

describe.runIf(hasProcEnviron())("residual: a step reaches the API's environment through /proc", () => {
  it("cannot see the secret in its OWN environment (this part is what the allowlist buys)", async () => {
    process.env["JWT_SECRET"] = SENTINEL;
    try {
      const out = await runStep("env");
      expect(out).not.toContain(SENTINEL);
      expect(out).not.toContain("JWT_SECRET");
    } finally {
      delete process.env["JWT_SECRET"];
    }
  });

  it("CAN still recover it from /proc/<parent>/environ — the allowlist is not a boundary", async () => {
    // The sentinel has to be in the EXEC-time environment of a process, not merely
    // in `process.env`, because that is what /proc/<pid>/environ exposes. So this
    // spawns an intermediate `node` with the secret in its exec environment — which
    // is exactly how the API is started by docker-compose — and has ITS child (the
    // "step", with the scrubbed allowlist environment) read back up the tree.
    const stepScript = `tr '\\0' '\\n' < /proc/$PPID/environ | grep '^JWT_SECRET=' || echo NOT-READABLE`;
    const parentScript = `
      const { spawn } = require("node:child_process");
      const env = ${JSON.stringify(buildStepEnv({}, process.cwd()))};
      const c = spawn("sh", ["-c", ${JSON.stringify(stepScript)}], { detached: true, stdio: ["ignore", "inherit", "inherit"], env });
      c.on("close", (code) => process.exit(code ?? 0));
    `;

    const out = await new Promise<string>((resolve, reject) => {
      const parent = spawn(process.execPath, ["-e", parentScript], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, JWT_SECRET: SENTINEL },
      });
      let buf = "";
      parent.stdout.on("data", (d) => (buf += String(d)));
      parent.stderr.on("data", (d) => (buf += String(d)));
      parent.on("error", reject);
      parent.on("close", () => resolve(buf));
    });

    expect(out).toContain(`JWT_SECRET=${SENTINEL}`);
  });
});
