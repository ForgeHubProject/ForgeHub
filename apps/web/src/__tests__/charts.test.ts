import { describe, it, expect } from "vitest";
import { compact, niceTicks } from "../components/charts";

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 × 10ⁿ from zero past the maximum", () => {
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(130)).toEqual([0, 50, 100, 150]);
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe("compact", () => {
  it("shortens thousands and millions", () => {
    expect(compact(950)).toBe("950");
    expect(compact(1500)).toBe("1.5K");
    expect(compact(2_000_000)).toBe("2M");
  });
});
