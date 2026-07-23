import { describe, it, expect } from "vitest";
import { summarizeChanges } from "../lib/designDiff";
import type { DiffChange } from "../types";

const added: DiffChange = { path: "gear", kind: "added", after: {} };
const removed: DiffChange = { path: "bolt", kind: "removed", before: {} };
const moved: DiffChange = {
  path: "landing-gear", kind: "modified",
  children: [{ path: "position", kind: "modified", before: [0, 0, 0], after: [5, 0, 0] }],
};
const renamed: DiffChange = {
  path: "housing", kind: "modified",
  children: [{ path: "name", kind: "modified", before: "Housing", after: "Case" }],
};
const modifiedNoChildren: DiffChange = { path: "shaft", kind: "modified" };

describe("summarizeChanges", () => {
  it("counts added / removed", () => {
    expect(summarizeChanges([added, removed])).toEqual({ added: 1, removed: 1, modified: 0, moved: 0 });
  });

  it("classifies transform-only children as 'moved'", () => {
    expect(summarizeChanges([moved])).toEqual({ added: 0, removed: 0, modified: 0, moved: 1 });
  });

  it("classifies non-transform field changes as 'modified'", () => {
    expect(summarizeChanges([renamed, modifiedNoChildren])).toEqual({ added: 0, removed: 0, modified: 2, moved: 0 });
  });

  it("aggregates a mixed change set", () => {
    expect(summarizeChanges([added, removed, moved, renamed])).toEqual({ added: 1, removed: 1, modified: 1, moved: 1 });
  });

  it("empty diff → all zeros", () => {
    expect(summarizeChanges([])).toEqual({ added: 0, removed: 0, modified: 0, moved: 0 });
  });
});
