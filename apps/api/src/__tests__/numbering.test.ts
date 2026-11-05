import { describe, it, expect, vi } from "vitest";
import { nextNumber } from "../numbering.js";

/**
 * A stand-in for the three tables `nextNumber` touches, keeping one repo's
 * counter in memory: `updateMany` honours its `lastNumber < floor` guard and
 * `update` increments, as the database would.
 */
function fakeDb(state: { lastNumber: number; maxIssue: number | null; maxPull: number | null }) {
  return {
    issue: { aggregate: vi.fn(async () => ({ _max: { number: state.maxIssue } })) },
    pullRequest: { aggregate: vi.fn(async () => ({ _max: { number: state.maxPull } })) },
    repo: {
      updateMany: vi.fn(async (args: { where: { lastNumber: { lt: number } }; data: { lastNumber: number } }) => {
        if (state.lastNumber >= args.where.lastNumber.lt) return { count: 0 };
        state.lastNumber = args.data.lastNumber;
        return { count: 1 };
      }),
      update: vi.fn(async () => {
        state.lastNumber += 1;
        return { lastNumber: state.lastNumber };
      }),
    },
  };
}

type Db = Parameters<typeof nextNumber>[0];

describe("nextNumber", () => {
  it("starts a new repo at 1", async () => {
    const db = fakeDb({ lastNumber: 0, maxIssue: null, maxPull: null });
    expect(await nextNumber(db as unknown as Db, "repo-1")).toBe(1);
  });

  it("counts issues and pull requests in one sequence", async () => {
    const state = { lastNumber: 0, maxIssue: null as number | null, maxPull: null as number | null };
    const db = fakeDb(state);
    const issue = await nextNumber(db as unknown as Db, "repo-1");
    state.maxIssue = issue;
    const pull = await nextNumber(db as unknown as Db, "repo-1");
    state.maxPull = pull;
    expect([issue, pull, await nextNumber(db as unknown as Db, "repo-1")]).toEqual([1, 2, 3]);
  });

  it("starts above both kinds in a repo numbered before the shared sequence", async () => {
    // Four issues and seven pull requests, each counted on its own; no counter yet.
    const db = fakeDb({ lastNumber: 0, maxIssue: 4, maxPull: 7 });
    expect(await nextNumber(db as unknown as Db, "repo-1")).toBe(8);
  });

  it("never moves the counter down when rows hold lower numbers", async () => {
    // Issue 9 was transferred away: the counter remembers it, the rows don't.
    const db = fakeDb({ lastNumber: 9, maxIssue: 3, maxPull: 5 });
    expect(await nextNumber(db as unknown as Db, "repo-1")).toBe(10);
  });

  it("catches up with rows written with their own numbers", async () => {
    // An import wrote issue 40 without touching the counter.
    const db = fakeDb({ lastNumber: 12, maxIssue: 40, maxPull: 12 });
    expect(await nextNumber(db as unknown as Db, "repo-1")).toBe(41);
  });
});
