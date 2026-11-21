/** How long a repository transfer request has left (#256). */
import { describe, expect, it } from "vitest";
import { expiresIn } from "../lib/expiresIn";

describe("expiresIn", () => {
  const now = Date.parse("2026-11-21T10:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  it.each([
    [24 * 3600_000 - 1, "in 23 hours"],
    [3600_000, "in 1 hour"],
    [59 * 60_000 + 59_000, "in 59 minutes"],
    [60_000, "in 1 minute"],
    [30_000, "in less than a minute"],
    [0, "now"],
    [-5000, "now"],
  ])("%d ms left: %s", (ms, text) => {
    expect(expiresIn(at(ms), now)).toBe(text);
  });
});
