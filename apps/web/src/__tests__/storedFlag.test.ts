/**
 * The file pages' trees start open on a tablet or wider and closed on a phone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { wideViewport } from "../lib/storedFlag";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wideViewport", () => {
  it("asks for at least 768 px", () => {
    const matchMedia = vi.fn((q: string) => ({ matches: q === "(min-width: 768px)" }));
    vi.stubGlobal("matchMedia", matchMedia);
    expect(wideViewport()).toBe(true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(wideViewport()).toBe(false);
  });

  it("counts as wide where there's no window to measure", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(wideViewport()).toBe(true);
  });
});
