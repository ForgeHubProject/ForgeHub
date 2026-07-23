import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Retention touches only these prisma methods; the disk side is real.
vi.mock("../prisma.js", () => ({
  prisma: {
    workflowRun: { findMany: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));

import { prisma } from "../prisma.js";
import { pruneCompletedRuns, retentionCap } from "../ci/retention.js";
import { ciLogPath, ciRunDir } from "../git-storage.js";

const STORAGE_KEY = "owner/widget.git";
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ci-retention-"));
  process.env["GIT_STORAGE_ROOT"] = root;
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env["GIT_STORAGE_ROOT"];
  delete process.env["FORGEHUB_CI_RETENTION"];
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.workflowRun.deleteMany).mockResolvedValue({ count: 0 } as never);
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function seedRun(id: string, body: string): Promise<void> {
  await mkdir(ciRunDir(STORAGE_KEY, id), { recursive: true });
  await writeFile(ciLogPath(STORAGE_KEY, id, "build"), body, "utf8");
}

describe("retentionCap", () => {
  it("defaults to 200 and honors the FORGEHUB_CI_RETENTION override", () => {
    delete process.env["FORGEHUB_CI_RETENTION"];
    expect(retentionCap()).toBe(200);
    process.env["FORGEHUB_CI_RETENTION"] = "2";
    expect(retentionCap()).toBe(2);
    delete process.env["FORGEHUB_CI_RETENTION"];
  });
});

describe("pruneCompletedRuns", () => {
  it("deletes DB rows and on-disk logs for completed runs beyond the cap (cap 2)", async () => {
    process.env["FORGEHUB_CI_RETENTION"] = "2";
    const staleIds = ["run-old-1", "run-old-2"];
    for (const id of staleIds) await seedRun(id, "old log");
    const keepId = "run-keep";
    await seedRun(keepId, "keep log");

    // findMany (ordered desc, skip cap) returns only the runs beyond the cap.
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue(staleIds.map((id) => ({ id })) as never);

    const pruned = await pruneCompletedRuns("repo-1", STORAGE_KEY);
    expect(pruned).toBe(2);

    // Queried completed runs beyond the cap.
    const findArg = vi.mocked(prisma.workflowRun.findMany).mock.calls[0][0] as Record<string, unknown>;
    expect(findArg).toMatchObject({ where: { repoId: "repo-1", status: "completed" }, skip: 2 });

    // Deleted exactly the stale rows (CheckRuns cascade off the FK).
    expect(prisma.workflowRun.deleteMany).toHaveBeenCalledWith({ where: { id: { in: staleIds } } });

    // Stale logs are gone; the kept run's log survives.
    for (const id of staleIds) expect(await fileExists(ciLogPath(STORAGE_KEY, id, "build"))).toBe(false);
    expect(await fileExists(ciLogPath(STORAGE_KEY, keepId, "build"))).toBe(true);
  });

  it("no-ops (no deleteMany) when nothing is beyond the cap", async () => {
    vi.mocked(prisma.workflowRun.findMany).mockResolvedValue([] as never);
    const pruned = await pruneCompletedRuns("repo-1", STORAGE_KEY);
    expect(pruned).toBe(0);
    expect(prisma.workflowRun.deleteMany).not.toHaveBeenCalled();
  });
});
