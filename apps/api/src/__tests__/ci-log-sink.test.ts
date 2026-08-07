import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogSink, maxLogBytes } from "../ci/log-sink.js";

/**
 * Byte cap + backpressure for job logs (issue #86, Tier 0). Before this, a step
 * could write to its log without limit — `yes > /dev/stdout` filled whatever
 * volume the log lived on, which on the shipped compose stack was the volume
 * holding the SQLite database.
 */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ci-log-sink-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env["CI_MAX_LOG_BYTES"];
});

let seq = 0;
function sinkAt(cap: number): { sink: LogSink; path: string } {
  const path = join(dir, `log-${seq++}.txt`);
  return { sink: new LogSink(createWriteStream(path, { flags: "w" }), cap), path };
}

describe("maxLogBytes", () => {
  it("defaults to 10 MiB and honors CI_MAX_LOG_BYTES", () => {
    expect(maxLogBytes()).toBe(10 * 1024 * 1024);
    process.env["CI_MAX_LOG_BYTES"] = "65536";
    expect(maxLogBytes()).toBe(65536);
  });

  it("clamps a nonsensical override up to a floor instead of producing a useless log", () => {
    process.env["CI_MAX_LOG_BYTES"] = "1";
    expect(maxLogBytes()).toBe(4096);
    process.env["CI_MAX_LOG_BYTES"] = "not-a-number";
    expect(maxLogBytes()).toBe(10 * 1024 * 1024);
  });
});

describe("LogSink byte cap", () => {
  it("writes through untouched while under the cap", async () => {
    const { sink, path } = sinkAt(1024);
    sink.write("hello ");
    sink.write("world\n");
    await sink.end();
    expect(await readFile(path, "utf8")).toBe("hello world\n");
    expect(sink.isTruncated).toBe(false);
  });

  it("stops at the cap and marks the truncation once, however much more is thrown at it", async () => {
    const cap = 4096;
    const { sink, path } = sinkAt(cap);
    const contentCap = sink.contentCapacity;

    // 1 MiB of output against a 4 KiB cap — the `yes > /dev/stdout` shape.
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let i = 0; i < 16; i++) sink.write(chunk);
    await sink.end();

    const body = await readFile(path, "utf8");
    expect(sink.isTruncated).toBe(true);

    // The kept prefix runs to the content cap; the marker occupies the rest.
    const marker = body.slice(contentCap);
    expect(body.slice(0, contentCap)).toBe("a".repeat(contentCap));
    expect(marker).toContain("log truncated");
    expect(marker).toContain("CI_MAX_LOG_BYTES");

    // Written ONCE — not once per discarded chunk.
    expect(body.split("log truncated").length - 1).toBe(1);

    // Bounded by what the sink was told, not by what the step emitted.
    expect((await stat(path)).size).toBeLessThan(1024 * 1024);
  });

  // REGRESSION (issue #86): the marker used to be appended ON TOP of the cap, so a
  // truncated log was `cap + markerLen` bytes on disk. The log endpoint serves at
  // most `cap` bytes, so it sliced the marker straight back off and every reader saw
  // a log that just stopped. Reserving the marker's bytes out of the cap is what
  // makes it survive the trip. If this assertion is relaxed, that bug is back.
  it("keeps the whole file — marker included — inside the cap, so the marker survives serving", async () => {
    const cap = 4096;
    const { sink, path } = sinkAt(cap);
    for (let i = 0; i < 100; i++) sink.write("x".repeat(100));
    await sink.end();

    const size = (await stat(path)).size;
    expect(size).toBeLessThanOrEqual(cap);

    // Simulate exactly what the route serves for a file this size: the first `cap`
    // bytes. The marker must be in there.
    const served = (await readFile(path, "utf8")).slice(0, cap);
    expect(served).toContain("log truncated");
  });

  it("splits the chunk that crosses the cap instead of dropping it whole", async () => {
    const cap = 4096;
    const { sink, path } = sinkAt(cap);
    const contentCap = sink.contentCapacity;
    sink.write("1".repeat(contentCap - 5));
    sink.write("6789ABCDEF"); // crosses the content cap; the first 5 bytes still land
    await sink.end();
    const body = await readFile(path, "utf8");
    expect(body.slice(contentCap - 5, contentCap)).toBe("6789A");
    expect(body).toContain("log truncated");
  });

  it("discards everything after truncation, including later runner framing", async () => {
    const cap = 4096;
    const { sink, path } = sinkAt(cap);
    sink.write("X".repeat(sink.contentCapacity + 10));
    sink.write("\n[runner] step exited with code 3\n");
    await sink.end();
    expect(await readFile(path, "utf8")).not.toContain("exited with code 3");
  });

  it("reports congestion so the caller can pause, and never blocks once truncated", async () => {
    // A tiny highWaterMark makes the stream report backpressure immediately, which
    // is the signal runner.ts uses to pause the child's pipe rather than buffering
    // the child's output in this process's heap.
    const path = join(dir, "backpressure.txt");
    const stream = createWriteStream(path, { flags: "w", highWaterMark: 16 });
    const sink = new LogSink(stream, 4096);

    let sawCongestion = false;
    for (let i = 0; i < 4; i++) {
      if (!sink.write(Buffer.alloc(16, 0x62))) sawCongestion = true;
    }
    expect(sawCongestion).toBe(true);

    // Past the cap the bytes are discarded rather than queued, so there is nothing
    // to wait on — always "accepted", or a truncated job would stall on a drain
    // that never comes.
    expect(sink.write(Buffer.alloc(4096, 0x63))).toBe(true);
    expect(sink.isTruncated).toBe(true);
    await sink.end();
  });
});
