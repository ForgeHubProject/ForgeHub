import { describe, expect, it } from "vitest";
import { fileBody } from "../lib/fileBody";

const figcraft = { ext: ".figcraft", handlerId: "figcraft", semanticDiffs: true };

describe("fileBody: what a file page draws", () => {
  it("lets a renderer draw the files it draws", () => {
    expect(fileBody({ semantic: true, manifestSettled: true, meta: undefined })).toBe("renderer");
  });

  it("waits for the manifest and the blob's facts before choosing", () => {
    expect(fileBody({ semantic: false, manifestSettled: false, meta: { binary: false, format: null } })).toBe("pending");
    expect(fileBody({ semantic: false, manifestSettled: true, meta: undefined })).toBe("pending");
  });

  it("shows text files as text, and falls back to text when the facts can't be had", () => {
    expect(fileBody({ semantic: false, manifestSettled: true, meta: { binary: false, format: null } })).toBe("text");
    expect(fileBody({ semantic: false, manifestSettled: true, meta: null })).toBe("text");
  });

  it("never decodes a binary file as text", () => {
    expect(fileBody({ semantic: false, manifestSettled: true, meta: { binary: true, format: null } })).toBe("binary");
  });

  it("shows a binary design file's latest change when its diffs are semantic", () => {
    expect(fileBody({ semantic: false, manifestSettled: true, meta: { binary: true, format: figcraft } })).toBe("latest-change");
    // Not opted in to .forge/formats: nothing semantic to show, so a download.
    expect(
      fileBody({ semantic: false, manifestSettled: true, meta: { binary: true, format: { ...figcraft, semanticDiffs: false } } }),
    ).toBe("binary");
  });
});
