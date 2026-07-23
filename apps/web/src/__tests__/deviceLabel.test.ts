import { describe, it, expect } from "vitest";
import { deviceLabel } from "../lib/deviceLabel";

describe("deviceLabel (session User-Agent → friendly label)", () => {
  it("falls back for a null UA", () => {
    expect(deviceLabel(null)).toBe("Unknown device");
  });

  it("names browser and OS together", () => {
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 (KHTML) Chrome/120 Safari/537.36")).toBe("Chrome on macOS");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64) Gecko/20100101 Firefox/121.0")).toBe("Firefox on Windows");
  });

  it("prefers Edge over Chrome when both tokens are present", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120.0")).toBe("Edge on Windows");
  });

  it("labels git tooling UAs", () => {
    expect(deviceLabel("git/2.43.0")).toBe("git");
    expect(deviceLabel("curl/8.4.0")).toBe("curl");
  });

  it("truncates an unrecognized long UA", () => {
    const ua = "SomeCustomAgent/9 ".repeat(6);
    const out = deviceLabel(ua);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(49);
  });
});
