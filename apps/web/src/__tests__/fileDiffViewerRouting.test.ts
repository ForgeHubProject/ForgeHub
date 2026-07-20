import { describe, it, expect } from "vitest";
import {
  extensionForFilename,
  resolveBaseFileDiffViewer,
  resolveFileDiffViewer,
} from "../views/fileDiffViewerRegistry";
import { FhrFileDiffViewer } from "../views/diffViewers/FhrFileDiffViewer";
import { TextFileDiffViewer } from "../views/diffViewers/TextFileDiffViewer";
import { FallbackFileDiffViewer } from "../views/diffViewers/FallbackFileDiffViewer";
import { ApiError, isFormatNotSupported } from "../api";
import { normalizeExtension } from "../lib/fhrFormats";

const semantic = (...exts: string[]): ReadonlySet<string> => new Set(exts);

describe("extensionForFilename", () => {
  it("returns the lowercased extension", () => {
    expect(extensionForFilename("model.GLTF")).toBe("gltf");
    expect(extensionForFilename("data.json")).toBe("json");
  });

  it("uses the full lowercased name for extensionless files", () => {
    expect(extensionForFilename("Dockerfile")).toBe("dockerfile");
    expect(extensionForFilename("Makefile")).toBe("makefile");
  });

  it("uses the final segment for multi-dot names", () => {
    expect(extensionForFilename("archive.tar.gz")).toBe("gz");
  });
});

describe("resolveBaseFileDiffViewer (no semantic knowledge)", () => {
  it("routes registered text extensions to the text viewer", () => {
    expect(resolveBaseFileDiffViewer("data.json")).toBe(TextFileDiffViewer);
    expect(resolveBaseFileDiffViewer("icon.svg")).toBe(TextFileDiffViewer);
  });

  it("routes registered binary extensions to the fallback viewer", () => {
    expect(resolveBaseFileDiffViewer("photo.png")).toBe(FallbackFileDiffViewer);
    expect(resolveBaseFileDiffViewer("bundle.wasm")).toBe(FallbackFileDiffViewer);
  });

  it("defaults unknown extensions to the text viewer", () => {
    expect(resolveBaseFileDiffViewer("model.gltf")).toBe(TextFileDiffViewer);
    expect(resolveBaseFileDiffViewer("weird.xyz")).toBe(TextFileDiffViewer);
  });

  it("never returns the semantic viewer", () => {
    expect(resolveBaseFileDiffViewer("model.gltf")).not.toBe(FhrFileDiffViewer);
  });
});

describe("resolveFileDiffViewer (manifest-driven)", () => {
  it("routes a semantic extension to the FHR viewer", () => {
    expect(resolveFileDiffViewer("model.gltf", semantic("gltf"))).toBe(FhrFileDiffViewer);
    expect(resolveFileDiffViewer("part.stl", semantic("stl", "gltf"))).toBe(FhrFileDiffViewer);
  });

  it("gives the FHR viewer precedence over a text registration", () => {
    // .json is a registered text extension, but if the manifest advertises it,
    // the semantic viewer wins.
    expect(resolveFileDiffViewer("data.json", semantic("json"))).toBe(FhrFileDiffViewer);
  });

  it("gives the FHR viewer precedence over a binary registration", () => {
    expect(resolveFileDiffViewer("photo.png", semantic("png"))).toBe(FhrFileDiffViewer);
  });

  it("matches semantic extensions case-insensitively via the filename key", () => {
    expect(resolveFileDiffViewer("MODEL.GLTF", semantic("gltf"))).toBe(FhrFileDiffViewer);
  });

  it("falls back to the base viewer when the extension is NOT semantic", () => {
    expect(resolveFileDiffViewer("data.json", semantic("gltf"))).toBe(TextFileDiffViewer);
    expect(resolveFileDiffViewer("photo.png", semantic("gltf"))).toBe(FallbackFileDiffViewer);
    expect(resolveFileDiffViewer("model.gltf", semantic("stl"))).toBe(TextFileDiffViewer);
  });

  it("falls back to base viewers when the set is empty (manifest loading/unavailable)", () => {
    expect(resolveFileDiffViewer("model.gltf", semantic())).toBe(TextFileDiffViewer);
    expect(resolveFileDiffViewer("data.json", semantic())).toBe(TextFileDiffViewer);
    expect(resolveFileDiffViewer("photo.png", semantic())).toBe(FallbackFileDiffViewer);
  });

  it("falls back to base viewers when no set is provided at all", () => {
    expect(resolveFileDiffViewer("model.gltf")).toBe(TextFileDiffViewer);
    expect(resolveFileDiffViewer("data.json")).toBe(TextFileDiffViewer);
  });
});

describe("isFormatNotSupported (the viewer's 404-fallback decision)", () => {
  it("is true only for a 404 ApiError", () => {
    expect(isFormatNotSupported(new ApiError(404, "Not Found"))).toBe(true);
  });

  it("is false for other API statuses (genuine failures)", () => {
    expect(isFormatNotSupported(new ApiError(500, "Server Error"))).toBe(false);
    expect(isFormatNotSupported(new ApiError(403, "Forbidden"))).toBe(false);
    expect(isFormatNotSupported(new ApiError(503, "Unavailable"))).toBe(false);
  });

  it("is false for a plain Error (e.g. network failure) or non-errors", () => {
    expect(isFormatNotSupported(new Error("network"))).toBe(false);
    expect(isFormatNotSupported("nope")).toBe(false);
    expect(isFormatNotSupported(null)).toBe(false);
    expect(isFormatNotSupported(undefined)).toBe(false);
  });
});

describe("normalizeExtension", () => {
  it("strips a leading dot and lowercases (manifest key -> registry key)", () => {
    expect(normalizeExtension(".gltf")).toBe("gltf");
    expect(normalizeExtension(".GLTF")).toBe("gltf");
    expect(normalizeExtension(".STL")).toBe("stl");
  });

  it("leaves an already-normalized extension unchanged", () => {
    expect(normalizeExtension("json")).toBe("json");
  });
});
