import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BASE_ENV_ALLOWLIST, buildRunnerGitEnv, buildStepEnv } from "../ci/step-env.js";

/**
 * Unit half of the env-allowlist guarantee (issue #86, Tier 0). The end-to-end
 * half — a real `sh -c` step running `env` and not finding the secret — lives in
 * ci-runner.test.ts. Both exist on purpose: this file pins the CONSTRUCTION rule,
 * that one pins the OBSERVABLE result, and a regression has to defeat both.
 */

const SECRETS = {
  JWT_SECRET: "jwt-secret-sentinel-must-not-leak",
  DATABASE_URL: "file:/data/forgehub.db",
  GIT_STORAGE_ROOT: "/data/git-storage",
  FORGEHUB_CI_ROOT: "/ci",
  SMTP_PASSWORD: "smtp-password-sentinel",
  SMTP_URL: "smtps://user:pw@mail.example.com",
  MAIL_API_KEY: "mail-key-sentinel",
};

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  for (const k of Object.keys(SECRETS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("buildStepEnv — the API's secrets are structurally absent", () => {
  it("omits JWT_SECRET and DATABASE_URL entirely, by key AND by value", () => {
    const env = buildStepEnv({}, "/tmp/ws");

    // By key: the variable does not exist at all — not empty, not redacted.
    expect(env).not.toHaveProperty("JWT_SECRET");
    expect(env).not.toHaveProperty("DATABASE_URL");

    // By value: nothing smuggled the secret through under a different name
    // (e.g. a NODE_OPTIONS / npm_config_* echo of the process environment).
    expect(Object.values(env)).not.toContain(SECRETS.JWT_SECRET);
    expect(Object.values(env)).not.toContain(SECRETS.DATABASE_URL);
  });

  it("omits the storage roots and every SMTP/mail credential", () => {
    const env = buildStepEnv({}, "/tmp/ws");
    for (const key of ["GIT_STORAGE_ROOT", "FORGEHUB_CI_ROOT", "SMTP_PASSWORD", "SMTP_URL", "MAIL_API_KEY"]) {
      expect(env).not.toHaveProperty(key);
    }
    for (const value of [SECRETS.SMTP_PASSWORD, SECRETS.SMTP_URL, SECRETS.MAIL_API_KEY, SECRETS.GIT_STORAGE_ROOT]) {
      expect(Object.values(env)).not.toContain(value);
    }
  });

  /**
   * THE REGRESSION GUARD. A denylist would pass every assertion above and still
   * leak the NEXT secret someone adds to the deployment. This asserts the rule
   * itself: a variable nobody has named in the allowlist is invisible to steps,
   * whatever it is called. Reintroducing `{ ...process.env, ...env }` fails here
   * even if the author remembered to keep stripping JWT_SECRET.
   */
  it("leaks NOTHING that is not on the allowlist — including variables that do not exist yet", () => {
    const futureSecret = `FORGEHUB_SECRET_ADDED_LATER_${Date.now()}`;
    process.env[futureSecret] = "a-secret-nobody-thought-to-deny";
    try {
      const env = buildStepEnv({}, "/tmp/ws");
      expect(env).not.toHaveProperty(futureSecret);
      expect(Object.values(env)).not.toContain("a-secret-nobody-thought-to-deny");

      // Stated as an invariant rather than a list of examples: every key present
      // is either allowlisted or one the runner itself sets, full stop.
      const runnerOwned = new Set(["HOME", "CI", "FORGEHUB", "GIT_TERMINAL_PROMPT"]);
      const allowed = new Set([...BASE_ENV_ALLOWLIST, ...runnerOwned]);
      expect(Object.keys(env).filter((k) => !allowed.has(k))).toEqual([]);
    } finally {
      delete process.env[futureSecret];
    }
  });

  it("keeps PATH so steps can find binaries, and falls back when the API has none", () => {
    const env = buildStepEnv({}, "/tmp/ws");
    expect(env["PATH"]).toBe(process.env["PATH"]);

    const savedPath = process.env["PATH"];
    delete process.env["PATH"];
    try {
      expect(buildStepEnv({}, "/tmp/ws")["PATH"]).toContain("/usr/bin");
    } finally {
      process.env["PATH"] = savedPath;
    }
  });

  it("pins HOME to the job workspace rather than inheriting the API user's home", () => {
    const savedHome = process.env["HOME"];
    process.env["HOME"] = "/home/forgehub";
    try {
      expect(buildStepEnv({}, "/tmp/ws/job-1")["HOME"]).toBe("/tmp/ws/job-1");
    } finally {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
    }
  });

  it("still delivers the workflow's own env: map, which wins over the runner's defaults", () => {
    const env = buildStepEnv({ GREETING: "hello", CI: "definitely" }, "/tmp/ws");
    expect(env["GREETING"]).toBe("hello");
    expect(env["CI"]).toBe("definitely"); // author's value overrides the marker
  });
});

describe("buildRunnerGitEnv", () => {
  it("is built from the same allowlist, so the clone is not a side channel", () => {
    const env = buildRunnerGitEnv();
    expect(env).not.toHaveProperty("JWT_SECRET");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(Object.values(env)).not.toContain(SECRETS.JWT_SECRET);
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });
});
