import { describe, it, expect } from "vitest";
import { canReplaceBody, resolveTemplateLabels } from "../pages/repo/templatesModel";
import type { Label } from "../types";

function label(id: string, name: string): Label {
  return { id, name, color: "d73a4a", description: null };
}

describe("resolveTemplateLabels", () => {
  const labels = [label("l1", "bug"), label("l2", "needs triage"), label("l3", "Docs")];

  it("resolves names to the repo's label rows, case- and space-insensitively", () => {
    expect(resolveTemplateLabels(labels, ["BUG", "  needs triage "]).map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(resolveTemplateLabels(labels, ["docs"]).map((l) => l.id)).toEqual(["l3"]);
  });

  it("drops names the repo has no label for", () => {
    expect(resolveTemplateLabels(labels, ["bug", "nonexistent"]).map((l) => l.id)).toEqual(["l1"]);
  });

  it("de-dupes and keeps the template's order", () => {
    expect(resolveTemplateLabels(labels, ["needs triage", "bug", "BUG"]).map((l) => l.id)).toEqual(["l2", "l1"]);
  });

  it("is empty for no names or no labels", () => {
    expect(resolveTemplateLabels(labels, [])).toEqual([]);
    expect(resolveTemplateLabels([], ["bug"])).toEqual([]);
  });
});

describe("canReplaceBody", () => {
  it("replaces an empty or whitespace-only box", () => {
    expect(canReplaceBody("", null)).toBe(true);
    expect(canReplaceBody("   \n ", null)).toBe(true);
  });

  it("replaces a box still holding the previously applied template", () => {
    expect(canReplaceBody("## Steps\n", "## Steps\n")).toBe(true);
  });

  it("never clobbers text the author typed", () => {
    expect(canReplaceBody("my own notes", null)).toBe(false);
    expect(canReplaceBody("## Steps\nedited", "## Steps\n")).toBe(false);
  });
});
