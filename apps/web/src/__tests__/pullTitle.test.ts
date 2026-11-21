/**
 * The compare page opens the new pull request form with a title already in it,
 * picked the way GitHub picks it.
 */
import { describe, expect, it } from "vitest";
import { suggestedPullTitle } from "../lib/pullTitle";

describe("suggestedPullTitle", () => {
  it("one commit: its subject", () => {
    expect(suggestedPullTitle([{ subject: "  Keeper: hooded cloak  " }], "art/keeper-cloak")).toBe("Keeper: hooded cloak");
  });

  it("several commits: the branch name, readable", () => {
    const two = [{ subject: "Figurine: match the cloaked keeper" }, { subject: "Keeper: hooded cloak" }];
    expect(suggestedPullTitle(two, "art/keeper-cloak")).toBe("Art/keeper cloak");
    expect(suggestedPullTitle(two, "fix_login--page")).toBe("Fix login page");
  });

  it("a commit with no subject falls back to the branch name", () => {
    expect(suggestedPullTitle([{ subject: " " }], "ui/oil-ring")).toBe("Ui/oil ring");
  });
});
