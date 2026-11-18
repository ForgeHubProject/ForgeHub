/**
 * The signed-out home page (GitHub's landing page): a sign-up that adapts to
 * the server's registration policy, a card for every format family Explore
 * filters by, and the public repositories people star.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { FORMAT_FAMILY_LABELS } from "../lib/formats";
import { FEATURED_COUNT, FORMAT_CARDS, Featured, SignUp, featured } from "../pages/LandingPage";
import type { ExploreRepo } from "../types";

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>).replace(/&amp;/g, "&");

describe("LandingPage", () => {
  it("has a card for every format family Explore filters by", () => {
    expect(FORMAT_CARDS.map((c) => c.family).sort()).toEqual(Object.keys(FORMAT_FAMILY_LABELS).sort());
  });

  it("offers an email sign-up where registration is open", () => {
    const html = render(<SignUp registration="open" />);
    expect(html).toContain('type="email"');
    expect(html).toContain("Sign up for ForgeHub");
    expect(html).toContain('href="/explore"');
  });

  it("offers sign-in instead where registration is closed", () => {
    const html = render(<SignUp registration="closed" />);
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain("Sign up");
    expect(html).toContain('href="/login?next=%2F"');
    expect(html).toContain('href="/explore"');
  });

  it("lists featured repositories with their formats, and hides the section when there are none", () => {
    const repo = {
      id: "r1",
      name: "lanternfall",
      ownerHandle: "gamedev",
      fullName: "gamedev/lanternfall",
      description: "Lanternfall: a Godot 4 cave adventure",
      starCount: 3,
      formats: ["psd", "gltf-scene"],
    } as unknown as ExploreRepo;
    const html = render(<Featured repos={[repo]} />);
    expect(html).toContain('href="/gamedev/lanternfall"');
    expect(html).toContain("Lanternfall: a Godot 4 cave adventure");
    expect(html).toContain("★ 3");
    expect(html).toContain(">PSD<");
    expect(html).toContain(">glTF<");

    expect(render(<Featured repos={[]} />)).toBe("");
  });

  it("features only repositories that say what they are, at most six", () => {
    const r = (id: string, description: string | null) => ({ id, description }) as unknown as ExploreRepo;
    expect(featured([r("a", "A game"), r("b", null), r("c", "  "), r("d", "Designs")]).map((x) => x.id)).toEqual(["a", "d"]);
    expect(featured(Array.from({ length: 10 }, (_, i) => r(String(i), "x")))).toHaveLength(FEATURED_COUNT);
  });
});
