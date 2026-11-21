/**
 * Imports wait their turn (#308): one at a time per person, oldest first, a
 * rate-limited one back in line until GitHub's hour resets, and the queue
 * picked up again at boot. The repository table is a small in-memory stand-in.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

type Row = {
  id: string; ownerId: string; storageKey: string | null; importSource: string | null; description: string | null;
  importStatus: string | null; importError: string | null; topics: number; createdAt: number;
};
let rows: Row[] = [];

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const value = row[k as keyof Row];
    if (v && typeof v === "object" && "in" in v) return (v.in as unknown[]).includes(value);
    return value === v;
  });
}

vi.mock("../prisma.js", () => ({
  prisma: {
    repo: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const r = rows.filter((x) => matches(x, where)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
        return r && { ...r, _count: { topics: r.topics } };
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...new Set(rows.filter((r) => matches(r, where)).map((r) => r.ownerId))].map((ownerId) => ({ ownerId }))),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw Object.assign(new Error("gone"), { code: "P2025" });
        if (typeof data.description === "string") r.description = data.description;
        if (data.topics) r.topics = (data.topics as { create: unknown[] }).create.length;
        return r;
      }),
    },
  },
}));
vi.mock("../github-import.js", async (orig) => ({
  ...(await orig<typeof import("../github-import.js")>()),
  fetchGithubRepo: vi.fn(),
  runGithubImport: vi.fn(),
}));
vi.mock("../github-issue-import.js", () => ({
  startIssueImportIfAsked: vi.fn().mockResolvedValue(undefined),
}));

import type { FastifyInstance } from "fastify";
import { fetchGithubRepo, ImportError, runGithubImport } from "../github-import.js";
import { startIssueImportIfAsked } from "../github-issue-import.js";
import { hasImportsUnderWay, resumeImportQueues, runImportQueue } from "../github-import-queue.js";

const app = { log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } } as unknown as FastifyInstance;
const ADA = "user-ada";

function queued(id: string, at: number, extra: Partial<Row> = {}): Row {
  return {
    id, ownerId: ADA, storageKey: `acme/${id}.git`, importSource: `pallets/${id}`, description: null,
    importStatus: "queued", importError: null, topics: 0, createdAt: at, ...extra,
  };
}
const source = (name: string) => ({ owner: "pallets", name, description: `About ${name}`, topics: ["web"], defaultBranch: "main" });
const status = () => Object.fromEntries(rows.map((r) => [r.id, r.importStatus]));

describe("the import queue (#308)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    vi.mocked(fetchGithubRepo).mockImplementation(async (_owner, name) => source(name));
    // The job clears the state when the fetch went well, as the real one does.
    vi.mocked(runGithubImport).mockImplementation(async (_app, repo) => {
      const r = rows.find((x) => x.id === repo.id)!;
      r.importStatus = null;
    });
  });
  afterEach(() => vi.useRealTimers());

  it("imports a person's queued repositories one at a time, oldest first, each then starting its issues", async () => {
    rows = [queued("b", 2), queued("a", 1), queued("c", 3)];
    const order: string[] = [];
    vi.mocked(runGithubImport).mockImplementation(async (_app, repo) => {
      // Never two at once.
      expect(rows.filter((r) => r.importStatus === "importing").map((r) => r.id)).toEqual([repo.id]);
      order.push(repo.id);
      rows.find((x) => x.id === repo.id)!.importStatus = null;
    });
    await runImportQueue(app, ADA);
    expect(order).toEqual(["a", "b", "c"]);
    expect(status()).toEqual({ a: null, b: null, c: null });
    expect(vi.mocked(startIssueImportIfAsked).mock.calls.map(([, id]) => id)).toEqual(["a", "b", "c"]);
    const [, repo, actor, src] = vi.mocked(runGithubImport).mock.calls[0]!;
    expect([repo, actor, src]).toEqual([{ id: "a", storageKey: "acme/a.git" }, ADA, source("a")]);
  });

  it("asks GitHub about each one when its turn comes, and takes its description and topics then", async () => {
    rows = [queued("a", 1), queued("b", 2, { description: "Ours", topics: 2 })];
    await runImportQueue(app, ADA);
    expect(fetchGithubRepo).toHaveBeenNthCalledWith(1, "pallets", "a");
    expect(rows[0]).toMatchObject({ description: "About a", topics: 1 });
    // Never over what the person set.
    expect(rows[1]).toMatchObject({ description: "Ours", topics: 2 });
  });

  it("one GitHub refuses is failed with GitHub's reason, and the rest go on", async () => {
    rows = [queued("gone", 1), queued("ok", 2)];
    vi.mocked(fetchGithubRepo).mockImplementation(async (_o, name) => {
      if (name === "gone") throw new ImportError(404, "There is no public repository at github.com/pallets/gone.");
      return source(name);
    });
    await runImportQueue(app, ADA);
    expect(rows[0]).toMatchObject({ importStatus: "failed", importError: "There is no public repository at github.com/pallets/gone." });
    expect(rows[1]!.importStatus).toBeNull();
    expect(vi.mocked(runGithubImport).mock.calls.map(([, r]) => r.id)).toEqual(["ok"]);
  });

  it("when the hour's GitHub requests run out: back in line, and the queue carries on after GitHub's reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-21T12:00:00Z"));
    rows = [queued("a", 1), queued("b", 2)];
    vi.mocked(fetchGithubRepo).mockRejectedValueOnce(
      new ImportError(503, "This server has used up its 60 GitHub requests for the hour.", new Date("2026-11-21T12:20:00Z")),
    );
    await runImportQueue(app, ADA);
    expect(status()).toEqual({ a: "queued", b: "queued" });
    expect(runGithubImport).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(19 * 60_000);
    expect(runGithubImport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.waitFor(() => expect(status()).toEqual({ a: null, b: null }));
  });

  it("waits while an import started on its own is fetching: that one's end starts the queue", async () => {
    rows = [queued("solo", 0, { importStatus: "importing" }), queued("a", 1)];
    await runImportQueue(app, ADA);
    expect(fetchGithubRepo).not.toHaveBeenCalled();
    rows[0]!.importStatus = null;
    await runImportQueue(app, ADA);
    expect(status()).toEqual({ solo: null, a: null });
  });

  it("only works through its own person's imports", async () => {
    rows = [queued("a", 1), queued("bobs", 2, { ownerId: "user-bob" })];
    await runImportQueue(app, ADA);
    expect(status()).toEqual({ a: null, bobs: "queued" });
  });

  it("asked again while it runs: it looks once more before stopping, so nothing queued meanwhile is left behind", async () => {
    rows = [queued("a", 1)];
    let release!: () => void;
    vi.mocked(runGithubImport).mockImplementationOnce(async (_app, repo) => {
      await new Promise<void>((r) => (release = r));
      rows.find((x) => x.id === repo.id)!.importStatus = null;
    });
    const first = runImportQueue(app, ADA);
    await vi.waitFor(() => expect(runGithubImport).toHaveBeenCalledTimes(1));
    rows.push(queued("late", 2));
    await runImportQueue(app, ADA); // returns at once: the first run will look again
    release();
    await first;
    expect(status()).toEqual({ a: null, late: null });
  });

  it("never throws", async () => {
    rows = [queued("a", 1)];
    vi.mocked(runGithubImport).mockRejectedValueOnce(new Error("boom"));
    await expect(runImportQueue(app, ADA)).resolves.toBeUndefined();
    expect(app.log.error).toHaveBeenCalled();
  });

  it("hasImportsUnderWay: fetching or waiting both count", async () => {
    expect(await hasImportsUnderWay(ADA)).toBe(false);
    rows = [queued("a", 1, { importStatus: "failed" })];
    expect(await hasImportsUnderWay(ADA)).toBe(false);
    rows = [queued("a", 1)];
    expect(await hasImportsUnderWay(ADA)).toBe(true);
    rows = [queued("a", 1, { importStatus: "importing" })];
    expect(await hasImportsUnderWay(ADA)).toBe(true);
  });

  it("at boot: every person's queue carries on", async () => {
    rows = [queued("a", 1), queued("b", 2, { ownerId: "user-bob" }), queued("done", 0, { importStatus: null })];
    expect(await resumeImportQueues(app)).toBe(2);
    await vi.waitFor(() => expect(status()).toEqual({ a: null, b: null, done: null }));
  });
});
