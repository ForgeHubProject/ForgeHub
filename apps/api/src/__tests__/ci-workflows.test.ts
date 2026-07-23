import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import {
  parseWorkflow,
  listWorkflowFilesAtCommit,
  defaultWorkflowName,
  globMatch,
  branchAllowed,
} from "../ci/workflows.js";

// ─── Parse matrix (pure) ────────────────────────────────────────────────────────

describe("parseWorkflow — valid documents", () => {
  it("parses a single-job workflow with named steps", () => {
    const res = parseWorkflow(
      [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    name: Build",
        "    steps:",
        "      - name: Greet",
        "        run: echo hi",
      ].join("\n"),
      "ci",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.name).toBe("CI");
    expect(res.workflow.events).toEqual(["push"]);
    expect(res.workflow.jobs).toHaveLength(1);
    const job = res.workflow.jobs[0];
    expect(job.id).toBe("build");
    expect(job.name).toBe("Build");
    expect(job.steps).toEqual([{ name: "Greet", run: "echo hi" }]);
  });

  it("parses a multi-job workflow with an `on:` map and unnamed steps", () => {
    const res = parseWorkflow(
      [
        "on:",
        "  push:",
        "  pull_request:",
        "jobs:",
        "  a:",
        "    steps:",
        "      - run: echo a",
        "  b:",
        "    name: Bee",
        "    steps:",
        "      - run: echo b1",
        "      - run: echo b2",
      ].join("\n"),
      "multi",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.name).toBe("multi"); // defaulted from basename
    expect(res.workflow.events).toEqual(["push", "pull_request"]);
    expect(res.workflow.jobs.map((j) => j.id)).toEqual(["a", "b"]);
    expect(res.workflow.jobs[0].name).toBe("a"); // job id fallback
    expect(res.workflow.jobs[1].name).toBe("Bee");
    expect(res.workflow.jobs[1].steps).toHaveLength(2);
  });

  it("accepts `on:` as a plain string", () => {
    const res = parseWorkflow("on: push\njobs:\n  x:\n    steps:\n      - run: echo x", "x");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.events).toEqual(["push"]);
  });

  it("ignores unknown events but keeps recognized ones", () => {
    const res = parseWorkflow("on: [push, schedule]\njobs:\n  x:\n    steps:\n      - run: echo x", "x");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.events).toEqual(["push"]);
  });
});

describe("parseWorkflow — invalid documents surface an error", () => {
  it("reports a YAML syntax error", () => {
    const res = parseWorkflow('name: "unterminated\non: [push]\n', "bad");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/YAML parse error/i);
  });

  it("rejects an empty file", () => {
    const res = parseWorkflow("", "bad");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/empty/i);
  });

  it("rejects a non-mapping top level", () => {
    const res = parseWorkflow("- a\n- b\n", "bad");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/mapping/i);
  });

  it("requires an `on:` field", () => {
    const res = parseWorkflow("name: X\njobs:\n  a:\n    steps:\n      - run: echo a", "bad");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/'on'/);
  });

  it("requires a `jobs:` mapping", () => {
    const res = parseWorkflow("on: [push]", "bad");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/jobs/i);
  });

  it("rejects an empty jobs mapping", () => {
    const res = parseWorkflow("on: [push]\njobs: {}", "bad");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/no jobs/i);
  });

  it("requires each step to carry a `run` command", () => {
    const res = parseWorkflow("on: [push]\njobs:\n  a:\n    steps:\n      - name: nope", "bad");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/run/i);
  });

  it("requires a non-empty steps list", () => {
    const res = parseWorkflow("on: [push]\njobs:\n  a:\n    steps: []", "bad");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/steps/i);
  });
});

describe("defaultWorkflowName", () => {
  it("strips the directory and extension", () => {
    expect(defaultWorkflowName(".forgehub/workflows/ci.yml")).toBe("ci");
    expect(defaultWorkflowName(".forgehub/workflows/build.yaml")).toBe("build");
  });
});

// ─── env maps (v1) ───────────────────────────────────────────────────────────────

describe("parseWorkflow — env maps", () => {
  it("captures workflow-level env and merges it into each job (job overrides)", () => {
    const res = parseWorkflow(
      [
        "on: [push]",
        "env:",
        "  A: wf",
        "  B: wf",
        "jobs:",
        "  build:",
        "    env:",
        "      B: job",
        "      C: job",
        "    steps:",
        "      - run: echo hi",
      ].join("\n"),
      "ci",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.env).toEqual({ A: "wf", B: "wf" });
    expect(res.workflow.jobs[0].env).toEqual({ A: "wf", B: "job", C: "job" });
  });

  it("defaults env to an empty map when absent", () => {
    const res = parseWorkflow("on: [push]\njobs:\n  a:\n    steps:\n      - run: echo a", "ci");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.env).toEqual({});
    expect(res.workflow.jobs[0].env).toEqual({});
  });

  it("rejects a non-string workflow-level env value", () => {
    const res = parseWorkflow("on: [push]\nenv:\n  PORT: 8080\njobs:\n  a:\n    steps:\n      - run: echo a", "ci");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/value for 'PORT' must be a string/i);
  });

  it("rejects a non-string job-level env value", () => {
    const res = parseWorkflow("on: [push]\njobs:\n  a:\n    env:\n      DEBUG: true\n    steps:\n      - run: echo a", "ci");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/value for 'DEBUG' must be a string/i);
  });

  it("rejects env that is not a mapping", () => {
    const res = parseWorkflow("on: [push]\nenv:\n  - A\njobs:\n  a:\n    steps:\n      - run: echo a", "ci");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/'env' must be a mapping/i);
  });
});

// ─── branch filters (v1) ─────────────────────────────────────────────────────────

describe("parseWorkflow — branch filters", () => {
  it("captures push branch globs from the on: map form", () => {
    const res = parseWorkflow(
      ["on:", "  push:", "    branches: [main, \"releases/*\"]", "jobs:", "  a:", "    steps:", "      - run: echo a"].join("\n"),
      "ci",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.events).toContain("push");
    expect(res.workflow.branchFilters.push).toEqual(["main", "releases/*"]);
    expect(res.workflow.branchFilters.pull_request).toBeNull();
  });

  it("captures pull_request target-branch filters", () => {
    const res = parseWorkflow(
      ["on:", "  pull_request:", "    branches: [main]", "jobs:", "  a:", "    steps:", "      - run: echo a"].join("\n"),
      "ci",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.branchFilters.pull_request).toEqual(["main"]);
  });

  it("leaves an unfiltered push as null (all branches)", () => {
    const res = parseWorkflow("on: [push]\njobs:\n  a:\n    steps:\n      - run: echo a", "ci");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.branchFilters.push).toBeNull();
  });

  it("treats `push:` with no branches as unfiltered", () => {
    const res = parseWorkflow("on:\n  push:\njobs:\n  a:\n    steps:\n      - run: echo a", "ci");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.workflow.events).toContain("push");
    expect(res.workflow.branchFilters.push).toBeNull();
  });
});

describe("globMatch / branchAllowed", () => {
  it("matches literals and `*` within a path segment (not across /)", () => {
    expect(globMatch("main", "main")).toBe(true);
    expect(globMatch("main", "mainx")).toBe(false);
    expect(globMatch("releases/*", "releases/1.0")).toBe(true);
    expect(globMatch("releases/*", "releases/1.0/rc")).toBe(false); // * stops at /
    expect(globMatch("feat-*", "feat-login")).toBe(true);
  });

  it("branchAllowed: null filter passes; a real filter needs a known matching branch", () => {
    expect(branchAllowed(null, "anything")).toBe(true);
    expect(branchAllowed(["main", "releases/*"], "main")).toBe(true);
    expect(branchAllowed(["main", "releases/*"], "releases/2")).toBe(true);
    expect(branchAllowed(["main"], "feature")).toBe(false);
    expect(branchAllowed(["main"], undefined)).toBe(false);
  });
});

// ─── listWorkflowFilesAtCommit (real git) ───────────────────────────────────────

describe("listWorkflowFilesAtCommit", () => {
  let repo: TestRepo;
  afterAll(async () => { await repo?.cleanup(); });
  beforeAll(async () => {
    repo = await createTestRepo("test/ci-workflows.git");
  }, 30_000);

  it("returns [] when the workflows directory is absent", async () => {
    const sha = await makeCommit(repo.workDir, { "readme.txt": "hi" }, "init");
    const files = await listWorkflowFilesAtCommit(repo.storageKey, sha);
    expect(files).toEqual([]);
  });

  it("returns only *.yml/*.yaml files under .forgehub/workflows", async () => {
    const sha = await makeCommit(
      repo.workDir,
      {
        ".forgehub/workflows/ci.yml": "on: [push]\njobs:\n  a:\n    steps:\n      - run: echo a\n",
        ".forgehub/workflows/build.yaml": "on: [pull_request]\njobs:\n  b:\n    steps:\n      - run: echo b\n",
        ".forgehub/workflows/notes.txt": "ignore me",
      },
      "add workflows",
    );
    const files = await listWorkflowFilesAtCommit(repo.storageKey, sha);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([".forgehub/workflows/build.yaml", ".forgehub/workflows/ci.yml"]);
    const ci = files.find((f) => f.path.endsWith("ci.yml"))!;
    expect(ci.content).toContain("echo a");
  });
});
