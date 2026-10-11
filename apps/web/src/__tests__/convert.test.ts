/**
 * "Convert to…" on the blob view (FHR SPEC §7 import/export): what is offered for a
 * file, the request the download makes, and how failures read. fetch is stubbed —
 * the server side is covered in apps/api.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchConverted, fetchConvertFormats, type ConvertFormat } from "../api";
import {
  __resetConvertFormats,
  convertedName,
  convertTargets,
  downloadConverted,
  extOf,
  loadConvertFormats,
} from "../lib/convert";

const FORMATS: ConvertFormat[] = [
  { ext: ".stl", handlerId: "stl", canImport: true, canExport: true },
  { ext: ".obj", handlerId: "obj", canImport: true, canExport: true },
  { ext: ".glb", handlerId: "gltf-scene", canImport: false, canExport: true }, // export-only here
  { ext: ".blend", handlerId: "blend", canImport: true, canExport: false }, // import-only
];

beforeEach(() => __resetConvertFormats());
afterEach(() => vi.unstubAllGlobals());

describe("convertTargets", () => {
  it("offers every other exportable format, sorted, to a file that can be imported", () => {
    expect(convertTargets(FORMATS, "bracket.obj")).toEqual([".glb", ".stl"]);
    expect(convertTargets(FORMATS, "parts/Scan.STL")).toEqual([".glb", ".obj"]);
  });
  it("offers an import-only format (.blend) every export target but not itself", () => {
    expect(convertTargets(FORMATS, "scene.blend")).toEqual([".glb", ".obj", ".stl"]);
  });
  it("offers nothing for a format that cannot be imported, an unknown one, or no extension", () => {
    expect(convertTargets(FORMATS, "model.glb")).toEqual([]);
    expect(convertTargets(FORMATS, "notes.txt")).toEqual([]);
    expect(convertTargets(FORMATS, "Makefile")).toEqual([]);
    expect(convertTargets([], "a.obj")).toEqual([]);
  });
});

describe("names", () => {
  it("swaps the extension and keeps dots in the stem", () => {
    expect(extOf("a.b.OBJ")).toBe(".obj");
    expect(extOf(".gitignore")).toBe(""); // a dotfile is a name, not an extension
    expect(convertedName("a.b.obj", ".stl")).toBe("a.b.stl");
    expect(convertedName("Makefile", ".stl")).toBe("Makefile.stl");
  });
});

describe("loadConvertFormats", () => {
  it("asks once per session, and treats a failure as 'none'", async () => {
    const ok = vi.fn(async () => FORMATS);
    expect(await loadConvertFormats(ok)).toEqual(FORMATS);
    expect(await loadConvertFormats(ok)).toEqual(FORMATS);
    expect(ok).toHaveBeenCalledTimes(1);

    __resetConvertFormats();
    const bad = vi.fn(async () => {
      throw new Error("404");
    });
    expect(await loadConvertFormats(bad)).toEqual([]);
    expect(await loadConvertFormats(bad)).toEqual([]);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe("requests", () => {
  it("fetchConvertFormats reads the format list", async () => {
    const mock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ formats: FORMATS }) });
    vi.stubGlobal("fetch", mock);
    expect(await fetchConvertFormats()).toEqual(FORMATS);
    expect(String(mock.mock.calls[0]![0])).toMatch(/\/convert\/formats$/);
  });

  it("fetchConverted sends path, sha and target, with the token", async () => {
    const blob = new Blob(["x"]);
    const mock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    vi.stubGlobal("fetch", mock);
    expect(await fetchConverted("tok", "alice", "models", "parts/a b.obj", "abc123", ".stl")).toBe(blob);
    const [url, init] = mock.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.pathname).toBe("/repos/alice/models/convert");
    expect(u.searchParams.get("path")).toBe("parts/a b.obj");
    expect(u.searchParams.get("sha")).toBe("abc123");
    expect(u.searchParams.get("to")).toBe(".stl");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("fetchConverted reports which side refused and why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ error: "The target handler could not convert this file", message: "the scene has no triangles to write" }),
      }),
    );
    const err = await fetchConverted(null, "a", "r", "x.obj", "s", ".stl").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).message).toBe("The target handler could not convert this file: the scene has no triangles to write");
  });
});

describe("downloadConverted", () => {
  it("saves the result under the converted name", async () => {
    const saved: Array<{ blob: Blob; name: string }> = [];
    const blob = new Blob(["stl bytes"]);
    const fetcher = vi.fn(async () => blob);
    await downloadConverted("tok", "alice", "models", "parts/bracket.obj", "abc", ".stl", fetcher, (b, name) => saved.push({ blob: b, name }));
    expect(fetcher).toHaveBeenCalledWith("tok", "alice", "models", "parts/bracket.obj", "abc", ".stl");
    expect(saved).toEqual([{ blob, name: "bracket.stl" }]);
  });

  it("does not save when the conversion fails", async () => {
    const save = vi.fn();
    await expect(
      downloadConverted(null, "a", "r", "x.obj", "s", ".stl", async () => { throw new ApiError(422, "no"); }, save),
    ).rejects.toThrow("no");
    expect(save).not.toHaveBeenCalled();
  });
});
