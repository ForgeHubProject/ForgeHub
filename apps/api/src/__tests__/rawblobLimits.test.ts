/**
 * Env parsing for the `/rawblob` operational knob (#157 phase 2).
 *
 * There is exactly one, and it is unset by default. The behaviour under test is
 * mostly about *not being quiet*: this is an operator-facing setting whose
 * failure mode is a value that looks accepted and isn't.
 * `FORGEHUB_RAWBLOB_MAX_BYTES=0` is the sharp one — it reads as "serve nothing"
 * and resolves to "unlimited", the precise opposite — so the rule is that a
 * rejected value is announced, never swallowed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rawblobMaxBytes } from "../rawblob-limits.js";
import * as limits from "../rawblob-limits.js";

const VARS = [
  "FORGEHUB_RAWBLOB_MAX_BYTES",
  // Retired knobs. Kept in the cleanup list so a stale value in a developer's
  // environment cannot influence anything, and asserted-absent below.
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
    expect(warn).not.toHaveBeenCalled();
  });

  it("exposes no concurrency, queue or stall knob at all", () => {
    // The API side of the route deliberately has no mechanism that can refuse
    // or interrupt a download that is making progress, so there is nothing here
    // to configure. Re-adding any of these would mean re-adding the mechanism —
    // including as a "compensation" for the rate floor nginx's send_timeout
    // imposes at the edge, which is documented there, not worked around here.
    expect(Object.keys(limits).sort()).toEqual(["RAWBLOB_SHARED_MAX_AGE_SECONDS", "rawblobMaxBytes"]);
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
    expect(warn).toHaveBeenCalledTimes(2);
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
});
