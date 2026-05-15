import { describe, it, expect } from "vitest";
import type { SnapshotSummary, DiffResult } from "../types";
import {
  buildGitCommitGroups,
  predecessorSnapshotId,
  diffResultToChangeCounts,
  isChangeCountsEmpty,
} from "../lib/commitGroups";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function snap(
  id: string,
  opts: Partial<SnapshotSummary> & { sourceFile?: string } = {},
): SnapshotSummary {
  return {
    id,
    handlerId: "plain-text",
    label: null,
    sourceFile: opts.sourceFile ?? "file.txt",
    schemaVersion: "1",
    createdAt: opts.createdAt ?? `2024-01-01T00:00:0${id}.000Z`,
    gitCommitSha: opts.gitCommitSha ?? null,
    ...opts,
  };
}

// ─── buildGitCommitGroups ─────────────────────────────────────────────────────

describe("buildGitCommitGroups", () => {
  it("returns empty array for no snapshots", () => {
    expect(buildGitCommitGroups([])).toHaveLength(0);
  });

  it("each snapshot without a SHA gets its own group (keyed by id)", () => {
    const result = buildGitCommitGroups([snap("1"), snap("2")]);
    expect(result).toHaveLength(2);
  });

  it("snapshots sharing the same gitCommitSha are grouped together", () => {
    const s1 = snap("1", { gitCommitSha: "abc123", sourceFile: "a.txt", createdAt: "2024-01-01T00:00:01.000Z" });
    const s2 = snap("2", { gitCommitSha: "abc123", sourceFile: "b.txt", createdAt: "2024-01-01T00:00:02.000Z" });
    const result = buildGitCommitGroups([s1, s2]);
    expect(result).toHaveLength(1);
    expect(result[0]!.snapshots).toHaveLength(2);
  });

  it("groups are sorted newest-first", () => {
    const early = snap("1", { gitCommitSha: "aaa", createdAt: "2024-01-01T00:00:01.000Z" });
    const late = snap("2", { gitCommitSha: "bbb", createdAt: "2024-01-02T00:00:00.000Z" });
    const result = buildGitCommitGroups([early, late]);
    expect(result[0]!.gitCommitSha).toBe("bbb");
    expect(result[1]!.gitCommitSha).toBe("aaa");
  });

  it("each group exposes gitCommitSha from the first snapshot in the group", () => {
    const s = snap("1", { gitCommitSha: "deadbeef" });
    const [group] = buildGitCommitGroups([s]);
    expect(group!.gitCommitSha).toBe("deadbeef");
  });

  it("null SHA group key is 'local:<id>'", () => {
    const s = snap("xyz", { gitCommitSha: null });
    const [group] = buildGitCommitGroups([s]);
    expect(group!.key).toBe("local:xyz");
    expect(group!.gitCommitSha).toBeNull();
  });

  it("uses the label from any snapshot in the group that has one", () => {
    const s1 = snap("1", { gitCommitSha: "c1", label: null, createdAt: "2024-01-01T00:00:01.000Z" });
    const s2 = snap("2", { gitCommitSha: "c1", label: "v1.0", createdAt: "2024-01-01T00:00:02.000Z" });
    const [group] = buildGitCommitGroups([s1, s2]);
    expect(group!.label).toBe("v1.0");
  });

  it("snapshots within a group are sorted chronologically (oldest first)", () => {
    const s1 = snap("1", { gitCommitSha: "sha", sourceFile: "a.txt", createdAt: "2024-01-01T00:00:02.000Z" });
    const s2 = snap("2", { gitCommitSha: "sha", sourceFile: "b.txt", createdAt: "2024-01-01T00:00:01.000Z" });
    const [group] = buildGitCommitGroups([s1, s2]);
    expect(group!.snapshots[0]!.id).toBe("2");
    expect(group!.snapshots[1]!.id).toBe("1");
  });
});

// ─── predecessorSnapshotId ────────────────────────────────────────────────────

describe("predecessorSnapshotId", () => {
  it("returns null for the only snapshot of a file", () => {
    const s = snap("1", { sourceFile: "a.txt" });
    expect(predecessorSnapshotId(s, [s])).toBeNull();
  });

  it("returns null for the first (oldest) snapshot of a file", () => {
    const s1 = snap("1", { sourceFile: "a.txt", createdAt: "2024-01-01T00:00:01.000Z" });
    const s2 = snap("2", { sourceFile: "a.txt", createdAt: "2024-01-01T00:00:02.000Z" });
    expect(predecessorSnapshotId(s1, [s1, s2])).toBeNull();
  });

  it("returns the previous snapshot id for the second snapshot of a file", () => {
    const s1 = snap("1", { sourceFile: "a.txt", createdAt: "2024-01-01T00:00:01.000Z" });
    const s2 = snap("2", { sourceFile: "a.txt", createdAt: "2024-01-01T00:00:02.000Z" });
    expect(predecessorSnapshotId(s2, [s1, s2])).toBe("1");
  });

  it("ignores snapshots from a different source file", () => {
    const a1 = snap("a1", { sourceFile: "a.txt", createdAt: "2024-01-01T00:00:01.000Z" });
    const b1 = snap("b1", { sourceFile: "b.txt", createdAt: "2024-01-01T00:00:02.000Z" });
    const a2 = snap("a2", { sourceFile: "a.txt", createdAt: "2024-01-01T00:00:03.000Z" });
    expect(predecessorSnapshotId(a2, [a1, b1, a2])).toBe("a1");
  });
});

// ─── diffResultToChangeCounts ─────────────────────────────────────────────────

describe("diffResultToChangeCounts", () => {
  it("handles plain-text diff (lines branch)", () => {
    const diff = {
      kind: "plain-text" as const,
      baseSnapshotId: "b",
      targetSnapshotId: "t",
      summary: { added: 3, removed: 1, unchanged: 10 },
      lines: [],
    } satisfies DiffResult;
    expect(diffResultToChangeCounts(diff)).toEqual({
      added: 3,
      removed: 1,
      modified: 0,
      moved: 0,
    });
  });

  it("handles glTF diff (changes branch)", () => {
    const diff = {
      baseSnapshotId: "b",
      targetSnapshotId: "t",
      summary: { added: 1, removed: 2, modified: 3, moved: 4, unchanged: 0 },
      changes: [],
    } satisfies DiffResult;
    expect(diffResultToChangeCounts(diff)).toEqual({
      added: 1,
      removed: 2,
      modified: 3,
      moved: 4,
    });
  });
});

// ─── isChangeCountsEmpty ──────────────────────────────────────────────────────

describe("isChangeCountsEmpty", () => {
  it("returns true when all counts are zero", () => {
    expect(isChangeCountsEmpty({ added: 0, removed: 0, modified: 0, moved: 0 })).toBe(true);
  });

  it("returns false when any count is non-zero", () => {
    expect(isChangeCountsEmpty({ added: 1, removed: 0, modified: 0, moved: 0 })).toBe(false);
    expect(isChangeCountsEmpty({ added: 0, removed: 1, modified: 0, moved: 0 })).toBe(false);
    expect(isChangeCountsEmpty({ added: 0, removed: 0, modified: 1, moved: 0 })).toBe(false);
    expect(isChangeCountsEmpty({ added: 0, removed: 0, modified: 0, moved: 1 })).toBe(false);
  });
});
