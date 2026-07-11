import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { instantiateWasmHandler } from "../fhr/wasm-runtime.js";

const echoWorker = fileURLToPath(new URL("./fixtures/echo-worker.cjs", import.meta.url));
const hangWorker = fileURLToPath(new URL("./fixtures/hang-worker.cjs", import.meta.url));

describe("wasm worker runtime", () => {
  it("runs diff in a worker and returns the parsed StructuredDiff", async () => {
    const h = await instantiateWasmHandler(Buffer.from("x"), "gltf-scene", { workerPath: echoWorker });
    const diff = await h.diff(Buffer.from("aa"), Buffer.from("bbbb"));
    expect(diff.format).toBe("gltf-scene");
    // the fixture echoes byte lengths, proving base/head crossed the thread boundary
    expect(diff.changes[0]).toMatchObject({ path: "echo", before: 2, after: 4 });
  });

  it("reuses one worker across calls", async () => {
    const h = await instantiateWasmHandler(Buffer.from("x"), "gltf-scene", { workerPath: echoWorker });
    const a = await h.diff(Buffer.from("a"), Buffer.from("b"));
    const b = await h.diff(Buffer.from("aa"), Buffer.from("bb"));
    expect(a.changes[0]).toMatchObject({ before: 1, after: 1 });
    expect(b.changes[0]).toMatchObject({ before: 2, after: 2 });
  });

  it("times out and rejects when the worker hangs, then respawns for the next call", async () => {
    const h = await instantiateWasmHandler(Buffer.from("x"), "gltf-scene", { workerPath: hangWorker, timeoutMs: 80 });
    await expect(h.diff(Buffer.from("a"), Buffer.from("b"))).rejects.toThrow(/timed out/);
    // worker was terminated on timeout; a subsequent call respawns and times out again
    // (rather than throwing "worker unavailable"), proving self-healing.
    await expect(h.diff(Buffer.from("a"), Buffer.from("b"))).rejects.toThrow(/timed out/);
  }, 10_000);

  it("rejects instantiation when the worker never reports ready", async () => {
    const missing = fileURLToPath(new URL("./fixtures/does-not-exist.cjs", import.meta.url));
    await expect(instantiateWasmHandler(Buffer.from("x"), "gltf-scene", { workerPath: missing })).rejects.toThrow();
  });
});
