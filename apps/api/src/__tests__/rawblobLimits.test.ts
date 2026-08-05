/**
 * Env parsing for the `/rawblob` operational knobs (#157 phase 2).
 *
 * The behaviour under test is mostly about *not being quiet*: these are
 * operator-facing settings whose failure mode is a value that looks accepted
 * and isn't. `FORGEHUB_RAWBLOB_MAX_BYTES=0` is the sharp one — it reads as
 * "serve nothing" and resolves to "unlimited", the precise opposite — so the
 * rule is that a rejected value is announced, never swallowed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  rawblobMaxBytes,
  rawblobMaxConcurrentStreams,
  rawblobStallTimeoutMs,
  rawblobQueueWaitMs,
  DEFAULT_MAX_CONCURRENT_RAWBLOB_STREAMS,
  DEFAULT_RAWBLOB_STALL_TIMEOUT_MS,
  DEFAULT_RAWBLOB_QUEUE_WAIT_MS,
} from "../rawblob-limits.js";

const VARS = [
  "FORGEHUB_RAWBLOB_MAX_BYTES",
  "FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS",
  "FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS",
  "FORGEHUB_RAWBLOB_QUEUE_WAIT_MS",
] as const;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const v of VARS) delete process.env[v];
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  warn.mockRestore();
});

/** Every warning emitted so far, joined — the dedupe key is `name=value`. */
const warnings = () => warn.mock.calls.map((c) => c.join(" ")).join("\n");

describe("rawblob env limits", () => {
  it("is unlimited by default and reports nothing", () => {
    expect(rawblobMaxBytes()).toBeNull();
    expect(rawblobMaxConcurrentStreams()).toBe(DEFAULT_MAX_CONCURRENT_RAWBLOB_STREAMS);
    expect(rawblobStallTimeoutMs()).toBe(DEFAULT_RAWBLOB_STALL_TIMEOUT_MS);
    expect(rawblobQueueWaitMs()).toBe(DEFAULT_RAWBLOB_QUEUE_WAIT_MS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("honours a real ceiling", () => {
    process.env["FORGEHUB_RAWBLOB_MAX_BYTES"] = "1048576";
    expect(rawblobMaxBytes()).toBe(1048576);
    expect(warn).not.toHaveBeenCalled();
  });

  it("SAYS SO when a ceiling of 0 is quietly turned into 'unlimited'", () => {
    // The trap: an operator writes 0 meaning "serve nothing" and gets the
    // opposite. It still resolves to unlimited — 0 is not a serveable ceiling
    // and inventing another number would be worse — but it cannot be silent.
    process.env["FORGEHUB_RAWBLOB_MAX_BYTES"] = "0";
    expect(rawblobMaxBytes()).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(warnings()).toContain("FORGEHUB_RAWBLOB_MAX_BYTES");
    expect(warnings()).toMatch(/NOT read as 0/i);
  });

  it("SAYS SO for negative and unparseable values too", () => {
    process.env["FORGEHUB_RAWBLOB_MAX_BYTES"] = "-1";
    expect(rawblobMaxBytes()).toBeNull();
    process.env["FORGEHUB_RAWBLOB_MAX_BYTES"] = "64MiB";
    expect(rawblobMaxBytes()).toBeNull();
    process.env["FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS"] = "0";
    expect(rawblobMaxConcurrentStreams()).toBe(DEFAULT_MAX_CONCURRENT_RAWBLOB_STREAMS);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warnings()).toContain('"64MiB"');
  });

  it("warns once per distinct bad value, not once per read", () => {
    process.env["FORGEHUB_RAWBLOB_MAX_BYTES"] = "nonsense";
    rawblobMaxBytes();
    rawblobMaxBytes();
    rawblobMaxBytes();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("treats a blank value as unset, which is not a mistake to report", () => {
    process.env["FORGEHUB_RAWBLOB_MAX_BYTES"] = "  ";
    expect(rawblobMaxBytes()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts 0 where 0 is a meaningful setting — disabling, not misconfiguring", () => {
    // Unlike a byte ceiling, "no stall timeout" and "no queue" are coherent
    // choices, so 0 is taken at face value for these and nothing is logged.
    process.env["FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS"] = "0";
    process.env["FORGEHUB_RAWBLOB_QUEUE_WAIT_MS"] = "0";
    expect(rawblobStallTimeoutMs()).toBe(0);
    expect(rawblobQueueWaitMs()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
