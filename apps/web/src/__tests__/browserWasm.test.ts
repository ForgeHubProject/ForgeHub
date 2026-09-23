/**
 * Tier-B (wasm-in-browser) compute path tests. The Worker itself is faked via
 * injected `createWorker` (issue #177 — the diff runs off the main thread), so
 * no real wasm build, network, or actual Worker thread is involved; what's
 * under test is the load/memoize/timeout/respawn contract, mirroring the
 * server's wasm-runtime.test.ts for its worker_threads twin.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __resetBrowserHandlers,
  browserWasmDiff,
  loadBrowserHandler,
  type BrowserWasmDeps,
  type WorkerLike,
} from "../lib/browserWasm";
import { API_BASE } from "../api";

const RAW_DIFF = JSON.stringify({
  format: "gltf-scene",
  changes: [{ path: "nodes/0", kind: "modified", label: "Cube" }],
});

/** A fake Worker whose behavior on `diff` is scripted per test. */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];

  constructor(private readonly onDiff: (msg: { id: number; base: Uint8Array; head: Uint8Array }) => void) {}

  postMessage(msg: unknown): void {
    this.posted.push(msg);
    const m = msg as { type: string; id?: number; base?: Uint8Array; head?: Uint8Array };
    if (m.type === "init") {
      queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent));
    } else if (m.type === "diff") {
      this.onDiff({ id: m.id!, base: m.base!, head: m.head! });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Test helper: simulate the worker answering a diff call. */
  respond(id: number, raw: string): void {
    this.onmessage?.({ data: { type: "result", id, raw } } as MessageEvent);
  }
}

function deps(over: Partial<BrowserWasmDeps> = {}, worker?: FakeWorker): BrowserWasmDeps {
  const w = worker ?? new FakeWorker(({ id }) => w.respond(id, RAW_DIFF));
  return {
    fetchImpl: vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })) as unknown as typeof fetch,
    createWorker: vi.fn(() => w),
    timeoutMs: 5000,
    ...over,
  };
}

beforeEach(() => __resetBrowserHandlers());

describe("loadBrowserHandler", () => {
  it("fetches the build through the API's /handlers proxy (official-only source)", async () => {
    const d = deps();
    await loadBrowserHandler("gltf-scene", d);
    expect(d.fetchImpl).toHaveBeenCalledWith(`${API_BASE}/handlers/gltf-scene`);
    expect(d.createWorker).toHaveBeenCalledTimes(1);
  });

  it("memoizes the instance across loads (one worker for repeated diffs)", async () => {
    const d = deps();
    const a = await loadBrowserHandler("gltf-scene", d);
    const b = await loadBrowserHandler("gltf-scene", d);
    expect(a).toBe(b);
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
    expect(d.createWorker).toHaveBeenCalledTimes(1);
  });

  it("rejects when the proxy has no build, and does NOT memoize the failure", async () => {
    const failing = vi.fn(async () => new Response("nope", { status: 404 }));
    const d = deps({ fetchImpl: failing as unknown as typeof fetch });
    await expect(loadBrowserHandler("gltf-scene", d)).rejects.toThrow("HTTP 404");

    // a later attempt retries instead of replaying the cached rejection
    const ok = deps();
    await expect(loadBrowserHandler("gltf-scene", ok)).resolves.toBeDefined();
    expect(ok.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects when the worker reports an init error, allowing a retry", async () => {
    let w: WorkerLike;
    const initFailWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (msg) => {
        const m = msg as { type: string };
        if (m.type === "init") {
          queueMicrotask(() =>
            w.onmessage?.({ data: { type: "init-error", error: "invalid wasm" } } as MessageEvent),
          );
        }
      },
      terminate: () => {},
    };
    w = initFailWorker;
    const d = deps({ createWorker: () => initFailWorker });
    await expect(loadBrowserHandler("gltf-scene", d)).rejects.toThrow("invalid wasm");
    const ok = deps();
    await expect(loadBrowserHandler("gltf-scene", ok)).resolves.toBeDefined();
  });
});

describe("browserWasmDiff", () => {
  it("runs the handler and returns the parsed structured diff", async () => {
    const result = await browserWasmDiff("gltf-scene", new Uint8Array([1]), new Uint8Array([2]), deps());
    expect(result.format).toBe("gltf-scene");
    expect(result.version).toBe("1.0");
    expect(result.changes).toEqual([{ path: "nodes/0", kind: "modified", label: "Cube" }]);
  });

  it("hands the exact blob bytes to the worker", async () => {
    let seen: { base: Uint8Array; head: Uint8Array } | undefined;
    const w = new FakeWorker(({ id, base, head }) => {
      seen = { base, head };
      w.respond(id, RAW_DIFF);
    });
    const base = new Uint8Array([1, 2, 3]);
    const head = new Uint8Array([4, 5]);
    await browserWasmDiff("gltf-scene", base, head, deps({}, w));
    expect(seen).toEqual({ base, head });
  });

  it("surfaces a handler-reported error as a rejection", async () => {
    const w = new FakeWorker(({ id }) => w.respond(id, '{"error":"bad gltf"}'));
    await expect(browserWasmDiff("gltf-scene", new Uint8Array(), new Uint8Array(), deps({}, w)))
      .rejects.toThrow("bad gltf");
  });

  it("times out and rejects when the worker hangs, then respawns for the next call", async () => {
    let worker: FakeWorker | undefined;
    let spawnCount = 0;
    const createWorker = () => {
      spawnCount += 1;
      worker = new FakeWorker(() => {
        /* never responds — simulates a pathological wasm call */
      });
      return worker;
    };
    const handler = await loadBrowserHandler("gltf-scene", deps({ timeoutMs: 30, createWorker }));
    await expect(handler.diff(new Uint8Array(), new Uint8Array())).rejects.toThrow(/timed out/);
    expect(worker!.terminated).toBe(true);
    // Respawns transparently for the next call (still hangs, still times out —
    // proving self-healing rather than throwing "worker unavailable").
    await expect(handler.diff(new Uint8Array(), new Uint8Array())).rejects.toThrow(/timed out/);
    expect(spawnCount).toBe(2);
  }, 10_000);
});
