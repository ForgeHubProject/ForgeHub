/**
 * Insights (#256): weekly commits and code frequency, contributors, and the
 * last year by weekday, from a repository's history.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getInsights, parseLog, summarize, weekOf } from "../insights.js";
import { createTestRepo, makeCommit } from "./helpers/git.js";

const at = (iso: string) => Date.parse(iso);

describe("weekOf", () => {
  it("is the week's Sunday, in UTC", () => {
    expect(weekOf(at("2026-11-08T23:59:00Z"))).toBe("2026-11-08"); // a Sunday
    expect(weekOf(at("2026-11-14T12:00:00Z"))).toBe("2026-11-08"); // that Saturday
    expect(weekOf(at("2026-11-15T00:00:00Z"))).toBe("2026-11-15");
  });
});

describe("parseLog", () => {
  it("reads authors and line counts, counting nothing for binary files", () => {
    const out = "\0" + "1794100000\tAda\tADA@x.io\n\n3\t1\ta.ts\n-\t-\tlogo.png\n" + "\0" + "1794000000\tBob\tbob@x.io\n\n0\t5\tb.ts\n";
    expect(parseLog(out)).toEqual([
      { at: 1794100000000, name: "Ada", email: "ada@x.io", additions: 3, deletions: 1 },
      { at: 1794000000000, name: "Bob", email: "bob@x.io", additions: 0, deletions: 5 },
    ]);
  });
});

describe("summarize", () => {
  const now = at("2026-11-11T12:00:00Z"); // a Wednesday; this week starts 2026-11-08
  const commits = [
    { at: at("2026-11-10T10:00:00Z"), name: "Ada", email: "ada@x.io", additions: 3, deletions: 1 },
    { at: at("2026-11-09T10:00:00Z"), name: "Ada L.", email: "ada@x.io", additions: 1, deletions: 0 },
    { at: at("2026-10-27T10:00:00Z"), name: "Ada L.", email: "ada@x.io", additions: 2, deletions: 2 },
    { at: at("2026-11-02T10:00:00Z"), name: "Bob", email: "bob@x.io", additions: 0, deletions: 7 },
  ];

  it("fills every week from the first commit to this one, oldest first", () => {
    const s = summarize(commits, now);
    expect(s.weeks).toEqual([
      { week: "2026-10-25", commits: 1, additions: 2, deletions: 2 },
      { week: "2026-11-01", commits: 1, additions: 0, deletions: 7 },
      { week: "2026-11-08", commits: 2, additions: 4, deletions: 1 },
    ]);
  });

  it("folds one person's spellings by email, under the name they used most", () => {
    const [ada, bob] = summarize(commits, now).authors;
    expect(ada).toMatchObject({ commits: 3, additions: 6, deletions: 3, weeks: { "2026-10-25": 1, "2026-11-08": 2 } });
    expect(["Ada", "Ada L."]).toContain(ada.name);
    expect(ada.name).toBe("Ada L."); // 2 commits against 1
    expect(bob).toMatchObject({ name: "Bob", commits: 1 });
  });

  it("puts this week's commits by weekday in the last row", () => {
    const { days } = summarize(commits, now);
    expect(days).toHaveLength(52);
    expect(days[51]).toEqual([0, 1, 1, 0, 0, 0, 0]); // Monday and Tuesday
    expect(days[50]).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it("is empty but well-formed with no commits", () => {
    const s = summarize([], now);
    expect(s.weeks).toEqual([{ week: "2026-11-08", commits: 0, additions: 0, deletions: 0 }]);
    expect(s.authors).toEqual([]);
  });
});

describe("getInsights", () => {
  let repo: Awaited<ReturnType<typeof createTestRepo>>;
  beforeAll(async () => {
    repo = await createTestRepo("acme/insights.git");
  }, 30_000);
  afterAll(async () => {
    await repo.cleanup();
  });

  it("reads the default branch's history", async () => {
    expect(await getInsights("acme/insights.git")).toBeNull();
    await makeCommit(repo.workDir, { "a.txt": "one\ntwo\n" }, "first");
    await makeCommit(repo.workDir, { "a.txt": "one\n", "b.txt": "three\n" }, "second");
    const insights = await getInsights("acme/insights.git");
    expect(insights).toMatchObject({ ref: "main", scanned: 2, truncated: false });
    expect(insights!.authors).toEqual([expect.objectContaining({ name: "ForgeHub Test", commits: 2, additions: 3, deletions: 1 })]);
    expect(insights!.weeks.at(-1)).toMatchObject({ commits: 2, additions: 3, deletions: 1 });
  });
});
