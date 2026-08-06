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

    // 1 MiB of output against a 4 KiB cap — the `yes > /dev/stdout` shape.
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let i = 0; i < 16; i++) sink.write(chunk);
    await sink.end();

    const body = await readFile(path, "utf8");
    expect(sink.isTruncated).toBe(true);

    // The kept prefix is exactly the cap; the only overrun is the marker itself.
    const marker = body.slice(cap);
    expect(body.slice(0, cap)).toBe("a".repeat(cap));
    expect(marker).toContain("log truncated");
    expect(marker).toContain("CI_MAX_LOG_BYTES");

    // Written ONCE — not once per discarded chunk.
    expect(body.split("log truncated").length - 1).toBe(1);

    // The file on disk is bounded by cap + one marker, not by what the step emitted.
    const size = (await stat(path)).size;
    expect(size).toBeLessThan(cap + 512);
    expect(size).toBeLessThan(1024 * 1024);
  });

  it("splits the chunk that crosses the cap instead of dropping it whole", async () => {
    const { sink, path } = sinkAt(10);
    sink.write("12345");
    sink.write("6789ABCDEF"); // crosses at "0"… keeps 5 more bytes
    await sink.end();
    const body = await readFile(path, "utf8");
    expect(body.startsWith("123456789A")).toBe(true);
    expect(body).toContain("log truncated");
  });

  it("discards everything after truncation, including later runner framing", async () => {
    const { sink, path } = sinkAt(8);
    sink.write("XXXXXXXXXX");
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
    const sink = new LogSink(stream, 64);

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
