import { describe, it, expect } from "vitest";
import {
  MERGE_METHOD_OPTIONS,
  isMergeMethod,
  mergeMethodOption,
  mergeMethodStorageKey,
  readMergeMethod,
  writeMergeMethod,
  revertPrTitle,
  isConflictError,
  type MergeMethod,
  type StorageLike,
} from "../pages/repo/pulls/mergeMethods";

// A minimal in-memory localStorage stand-in for the node test env.
function fakeStorage(seed: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("MERGE_METHOD_OPTIONS", () => {
  it("covers exactly the three methods in order", () => {
    expect(MERGE_METHOD_OPTIONS.map((o) => o.method)).toEqual(["merge", "squash", "rebase"]);
  });

  it("every option has a button label, menu label, and description", () => {
    for (const o of MERGE_METHOD_OPTIONS) {
      expect(o.buttonLabel).toBeTruthy();
      expect(o.menuLabel).toBeTruthy();
      expect(o.description.length).toBeGreaterThan(0);
    }
  });
});

describe("isMergeMethod", () => {
  it("accepts the three valid methods", () => {
    for (const m of ["merge", "squash", "rebase"]) expect(isMergeMethod(m)).toBe(true);
  });
  it("rejects anything else", () => {
    for (const v of ["octopus", "", null, undefined, 3, {}]) expect(isMergeMethod(v)).toBe(false);
  });
});

describe("mergeMethodOption", () => {
  it("returns the matching option", () => {
    expect(mergeMethodOption("squash").method).toBe("squash");
  });
  it("falls back to merge for an unknown method", () => {
    expect(mergeMethodOption("bogus" as MergeMethod).method).toBe("merge");
  });
});

describe("mergeMethodStorageKey", () => {
  it("is namespaced per repo", () => {
    expect(mergeMethodStorageKey("demo", "aurora-ui")).toBe("fh_merge_method:demo/aurora-ui");
    expect(mergeMethodStorageKey("a", "b")).not.toBe(mergeMethodStorageKey("a", "c"));
  });
});

describe("readMergeMethod / writeMergeMethod", () => {
  it("defaults to merge when nothing is stored", () => {
    expect(readMergeMethod("demo", "aurora-ui", fakeStorage())).toBe("merge");
  });

  it("round-trips a stored method per repo", () => {
    const store = fakeStorage();
    writeMergeMethod("demo", "aurora-ui", "squash", store);
    expect(readMergeMethod("demo", "aurora-ui", store)).toBe("squash");
    // Different repo is unaffected.
    expect(readMergeMethod("demo", "forge-cli", store)).toBe("merge");
  });

  it("ignores a corrupt stored value", () => {
    const store = fakeStorage({ [mergeMethodStorageKey("demo", "aurora-ui")]: "nonsense" });
    expect(readMergeMethod("demo", "aurora-ui", store)).toBe("merge");
  });

  it("degrades gracefully when storage is unavailable", () => {
    expect(readMergeMethod("demo", "aurora-ui", null)).toBe("merge");
    expect(() => writeMergeMethod("demo", "aurora-ui", "rebase", null)).not.toThrow();
  });

  it("survives throwing storage", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readMergeMethod("demo", "aurora-ui", throwing)).toBe("merge");
    expect(() => writeMergeMethod("demo", "aurora-ui", "squash", throwing)).not.toThrow();
  });
});

describe("revertPrTitle", () => {
  it("wraps the original title with quotes and the (!N) marker", () => {
    expect(revertPrTitle("Add dark mode support", 4)).toBe('Revert "Add dark mode support" (!4)');
  });
});

describe("isConflictError", () => {
  it("matches merge/rebase conflict messages", () => {
    expect(isConflictError("Merge conflict — cannot auto-merge")).toBe(true);
    expect(isConflictError("Rebase conflict — commits could not be replayed cleanly onto the base branch")).toBe(true);
    expect(isConflictError("Squash conflict — cannot auto-merge")).toBe(true);
  });
  it("does not match unrelated errors", () => {
    expect(isConflictError("Write access required")).toBe(false);
    expect(isConflictError("Branch is already merged")).toBe(false);
  });
});
