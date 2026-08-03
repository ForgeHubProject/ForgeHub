/**
 * "Format not enabled" aggregation + phrasing (issue #73): the store several
 * diff viewers in one commit/PR view register their /filediff
 * `format-not-enabled` payloads into, so the rendered card lists every
 * not-enabled format together instead of each file pretending it is alone.
 * Pure logic — the React hook on top is a thin subscribe wrapper.
 */
import { describe, it, expect } from "vitest";
import { isFormatNotEnabled, type FormatNotEnabled, type SemanticFileDiff } from "../api";
import {
  notEnabledFormatsInScope,
  notEnabledMessage,
  notEnabledScopeKey,
  registerNotEnabledFormat,
} from "../lib/notEnabledFormats";

const payload = (ext: string): FormatNotEnabled => ({
  status: "format-not-enabled",
  path: `models/file${ext}`,
  ext,
  message: `Format ${ext} is not added to this repo's .forge/formats.`,
  hint: [`forge formats add ${ext}`, `forge formats ignore ${ext}`],
});

describe("isFormatNotEnabled", () => {
  it("recognizes the CTA payload and not a real diff", () => {
    expect(isFormatNotEnabled(payload(".glb"))).toBe(true);
    const diff: SemanticFileDiff = {
      version: "1.0",
      format: "gltf-scene",
      handlerId: "gltf-scene",
      path: "model.gltf",
      changes: [],
      baseSha: null,
      headSha: "abc",
    };
    expect(isFormatNotEnabled(diff)).toBe(false);
  });
});

describe("notEnabledScopeKey", () => {
  it("keys by repo AND head ref so different views never cross-aggregate", () => {
    expect(notEnabledScopeKey("/alice/scene", "sha1")).toBe("/alice/scene@sha1");
    expect(notEnabledScopeKey("/alice/scene", "sha1")).not.toBe(notEnabledScopeKey("/alice/scene", "sha2"));
    expect(notEnabledScopeKey("/alice/scene", "sha1")).not.toBe(notEnabledScopeKey("/bob/scene", "sha1"));
  });
});

describe("registerNotEnabledFormat / notEnabledFormatsInScope", () => {
  it("aggregates several formats in one scope, sorted by extension", () => {
    const scope = "test-scope-multi";
    const off1 = registerNotEnabledFormat(scope, payload(".step"));
    const off2 = registerNotEnabledFormat(scope, payload(".glb"));
    expect(notEnabledFormatsInScope(scope).map((e) => e.ext)).toEqual([".glb", ".step"]);
    off1();
    off2();
    expect(notEnabledFormatsInScope(scope)).toEqual([]);
  });

  it("dedupes files of the same format and ref-counts unregistration", () => {
    const scope = "test-scope-refcount";
    // Two .glb files in one commit — the format is listed once…
    const off1 = registerNotEnabledFormat(scope, payload(".glb"));
    const off2 = registerNotEnabledFormat(scope, payload(".glb"));
    expect(notEnabledFormatsInScope(scope).map((e) => e.ext)).toEqual([".glb"]);
    // …and survives one of them unmounting.
    off1();
    expect(notEnabledFormatsInScope(scope).map((e) => e.ext)).toEqual([".glb"]);
    off2();
    expect(notEnabledFormatsInScope(scope)).toEqual([]);
  });

  it("keeps the server's hint commands attached to each format", () => {
    const scope = "test-scope-hints";
    const off = registerNotEnabledFormat(scope, payload(".glb"));
    expect(notEnabledFormatsInScope(scope)[0].hint).toEqual([
      "forge formats add .glb",
      "forge formats ignore .glb",
    ]);
    off();
  });

  it("does not leak across scopes", () => {
    const off = registerNotEnabledFormat("test-scope-a", payload(".glb"));
    expect(notEnabledFormatsInScope("test-scope-b")).toEqual([]);
    off();
  });

  it("unregistration is idempotent", () => {
    const scope = "test-scope-idem";
    const off1 = registerNotEnabledFormat(scope, payload(".glb"));
    const off2 = registerNotEnabledFormat(scope, payload(".glb"));
    off1();
    off1(); // double call must not steal off2's registration
    expect(notEnabledFormatsInScope(scope).map((e) => e.ext)).toEqual([".glb"]);
    off2();
    expect(notEnabledFormatsInScope(scope)).toEqual([]);
  });
});

describe("notEnabledMessage", () => {
  it("phrases one format in the singular", () => {
    expect(notEnabledMessage([".glb"])).toBe("Format .glb is not added to this repo's .forge/formats.");
  });

  it("lists several formats together, per the phrasing in #73", () => {
    expect(notEnabledMessage([".glb", ".step"])).toBe(
      "Formats .glb, .step are not added to this repo's .forge/formats.",
    );
  });
});
