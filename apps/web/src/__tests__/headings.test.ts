import { describe, it, expect } from "vitest";
import { createHeadingIds, headingSlug } from "../lib/headings";

describe("headingSlug", () => {
  it("makes GitHub's anchors", () => {
    expect(headingSlug("Getting Started")).toBe("getting-started");
    expect(headingSlug("What's new in v2.0?")).toBe("whats-new-in-v20");
    expect(headingSlug("**Bold** title")).toBe("bold-title");
  });
});

describe("createHeadingIds", () => {
  it("prefixes ids and numbers repeats within one document", () => {
    const id = createHeadingIds();
    expect([id("Intro"), id("Setup"), id("Intro"), id("Intro")]).toEqual([
      "user-content-intro", "user-content-setup", "user-content-intro-1", "user-content-intro-2",
    ]);
    expect(createHeadingIds()("Intro")).toBe("user-content-intro");
  });
});
