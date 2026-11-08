import { describe, it, expect } from "vitest";
import { hovercardHandle } from "../components/Hovercard";
import { formatLabel } from "../lib/formats";
import { topicHref } from "../pages/listShared";

const O = "http://localhost:5174";

describe("hovercardHandle", () => {
  it("picks out links to a person's profile", () => {
    expect(hovercardHandle("/ada", O)).toBe("ada");
    expect(hovercardHandle(`${O}/copy-tester/`, O)).toBe("copy-tester");
  });

  it("ignores repositories, site pages, other sites and profile tabs", () => {
    for (const href of ["/ada/poster", "/explore", "/Issues", "/", "https://example.com/ada", "/ada?tab=stars", "/ada#x", "/-bad"]) {
      expect(hovercardHandle(href, O)).toBeNull();
    }
  });
});

describe("format names", () => {
  it("names handler ids for badges", () => {
    expect(formatLabel("psd")).toBe("PSD");
    expect(formatLabel("gltf-scene")).toBe("glTF");
    expect(formatLabel("figcraft")).toBe("FigCraft");
  });

  it("links topics to their page", () => {
    expect(topicHref("3d-printing")).toBe("/topics/3d-printing");
  });
});
