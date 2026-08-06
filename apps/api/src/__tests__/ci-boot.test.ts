import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../prisma.js", () => ({
  prisma: {
    workflowRun: { findMany: vi.fn(), updateMany: vi.fn() },
    checkRun: { updateMany: vi.fn() },
  },
}));

import { prisma } from "../prisma.js";
import { failOrphanedRuns, sweepCiWorkspaces } from "../ci/boot.js";
import { ciWorkRoot, ciWorkspaceDir, ciRunDir, ciLogPath } from "../git-storage.js";

/**
 * Startup recovery (issue #86, Tier 0). The runner's queue lives only in this
 * process's heap, so a restart leaves two kinds of debris that nothing else ever
 * cleans up: workspaces on disk, and runs stuck non-completed in the database.
 */

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ci-boot-"));
  process.env["GIT_STORAGE_ROOT"] = root;
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env["GIT_STORAGE_ROOT"];
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.workflowRun.updateMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.checkRun.updateMany).mockResolvedValue({ count: 0 } as never);
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("sweepCiWorkspaces", () => {
  it("deletes workspaces a restart leaked, which retention never touches", async () => {
    // Retention prunes by run count and only looks at COMPLETED runs' log dirs, so
    // an interrupted job's workspace — a full clone of the repo — used to sit here
    // forever.
    const ws = ciWorkspaceDir("run-interrupted", "build");
    await mkdir(join(ws, ".git", "objects"), { recursive: true });
    await writeFile(join(ws, ".git", "objects", "blob"), "x".repeat(1024), "utf8");
    expect(await exists(ws)).toBe(true);

    await sweepCiWorkspaces();

    expect(await exists(ws)).toBe(false);
    expect(await exists(ciWorkRoot())).toBe(false);
  });

  it("leaves run LOGS alone — only the .work tree is disposable", async () => {
    const logDir = ciRunDir("owner/widget.git", "run-kept");
    await mkdir(logDir, { recursive: true });
    const logFile = ciLogPath("owner/widget.git", "run-kept", "build");
    await writeFile(logFile, "important output\n", "utf8");
    await mkdir(ciWorkspaceDir("run-x", "job-x"), { recursive: true });

    await sweepCiWorkspaces();

    expect(await exists(logFile)).toBe(true);
    expect(await exists(ciWorkRoot())).toBe(false);
  });

  it("is a no-op, not an error, when there is nothing to sweep", async () => {
    await expect(sweepCiWorkspaces()).resolves.toBeUndefined();
  });
});

describe("failOrphanedRuns", () => {
  it("finalizes every non-completed run as failed, jobs first", async () => {
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([{ id: "run-a" }, { id: "run-b" }] as never);

    const n = await failOrphanedRuns();
    expect(n).toBe(2);

    // Jobs are updated before runs: an interruption between the two must leave the
    // run still non-completed so the NEXT boot retries, rather than leaving a
    // completed run with pending jobs (which is the state that wedges a PR).
    const checkOrder = vi.mocked(prisma.checkRun.updateMany).mock.invocationCallOrder[0];
    const runOrder = vi.mocked(prisma.workflowRun.updateMany).mock.invocationCallOrder[0];
    expect(checkOrder).toBeLessThan(runOrder);

    const checkArg = vi.mocked(prisma.checkRun.updateMany).mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(checkArg.data.status).toBe("completed");
    expect(checkArg.data.conclusion).toBe("failure");

    const runArg = vi.mocked(prisma.workflowRun.updateMany).mock.calls[0][0] as {
      where: { id: { in: string[] }; status: unknown };
      data: Record<string, unknown>;
    };
    expect(runArg.where.id.in).toEqual(["run-a", "run-b"]);
    expect(runArg.data.status).toBe("completed");
    expect(runArg.data.conclusion).toBe("failure");
    // Guarded, so a run that somehow completed in between is never clobbered.
    expect(runArg.where.status).toEqual({ not: "completed" });
  });

  it("selects BOTH queued and running runs — the in-memory queue died with the process", async () => {
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never);
    await failOrphanedRuns();
    const arg = vi.mocked(prisma.workflowRun.findMany).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(arg.where).toEqual({ status: { not: "completed" } });
  });

  it("writes nothing when there is no debris", async () => {
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never);
    expect(await failOrphanedRuns()).toBe(0);
    expect(prisma.checkRun.updateMany).not.toHaveBeenCalled();
    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });
});
