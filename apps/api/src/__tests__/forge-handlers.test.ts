import { describe, it, expect } from "vitest";
import { parseForgeHandlers } from "../forge-handlers.js";

// The `.forge/handlers` lockfile is JSON: handler id → pinned content-hash
// build, null for installed-but-unpinned (forge's SaveForgeHandlers shape).
describe("parseForgeHandlers", () => {
  it("parses handler → pinned build entries", () => {
    const pins = parseForgeHandlers('{ "gltf-scene": "e520cc6", "step-cad": "20260709-f1dd134" }');
    expect(pins.get("gltf-scene")).toBe("e520cc6");
    expect(pins.get("step-cad")).toBe("20260709-f1dd134");
  });

  it("keeps an explicit null entry (installed but unpinned)", () => {
    const pins = parseForgeHandlers('{ "gltf-scene": null }');
    expect(pins.has("gltf-scene")).toBe(true);
    expect(pins.get("gltf-scene")).toBeNull();
  });

  it("skips entries that are not a string or null", () => {
    const pins = parseForgeHandlers('{ "a": 7, "b": {"x":1}, "c": "ok" }');
    expect(pins.has("a")).toBe(false);
    expect(pins.has("b")).toBe(false);
    expect(pins.get("c")).toBe("ok");
  });

  it("treats malformed or non-object content as no pins, never an error", () => {
    expect(parseForgeHandlers("not json").size).toBe(0);
    expect(parseForgeHandlers("[1,2]").size).toBe(0);
    expect(parseForgeHandlers('"str"').size).toBe(0);
    expect(parseForgeHandlers("null").size).toBe(0);
    expect(parseForgeHandlers("").size).toBe(0);
  });
});
