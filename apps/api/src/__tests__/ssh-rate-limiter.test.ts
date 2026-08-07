import { vi, describe, it, expect, beforeEach } from "vitest";

// Import the rate-limiter helpers directly — no server or DB needed.
import {
  failureRecordCount,
  isRateLimited,
  recordAuthFailure,
  resetAuthFailures,
  sweepExpiredFailures,
} from "../ssh/server.js";

// The module-level failMap is shared across tests; we reset state via resetAuthFailures.

const IP = "192.0.2.1";
const OTHER_IP = "192.0.2.2";
/** Stand-ins for a scan across many source addresses. */
const SCAN_IPS = Array.from({ length: 50 }, (_, i) => `198.51.100.${i}`);

beforeEach(() => {
  // Every IP this file may touch, so the sweep tests can assert exact counts
  // rather than deltas — a leftover record from an earlier test would otherwise
  // read as a sweep failure.
  resetAuthFailures(IP);
  resetAuthFailures(OTHER_IP);
  for (const ip of SCAN_IPS) resetAuthFailures(ip);
  vi.useRealTimers();
});

describe("SSH auth rate-limiter", () => {
  it("allows auth before any failures", () => {
    expect(isRateLimited(IP)).toBe(false);
  });

  it("does not rate-limit below the threshold (4 failures)", () => {
    for (let i = 0; i < 4; i++) recordAuthFailure(IP);
    expect(isRateLimited(IP)).toBe(false);
  });

  it("rate-limits after 5 failures", () => {
    for (let i = 0; i < 5; i++) recordAuthFailure(IP);
    expect(isRateLimited(IP)).toBe(true);
  });

  it("does not affect a different IP", () => {
    for (let i = 0; i < 5; i++) recordAuthFailure(IP);
    expect(isRateLimited("10.0.0.1")).toBe(false);
  });

  it("resetAuthFailures clears the record so the IP can auth again", () => {
    for (let i = 0; i < 5; i++) recordAuthFailure(IP);
    expect(isRateLimited(IP)).toBe(true);
    resetAuthFailures(IP);
    expect(isRateLimited(IP)).toBe(false);
  });

  it("window expires after 60 s and the record is cleared", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) recordAuthFailure(IP);
    expect(isRateLimited(IP)).toBe(true);

    // Advance past the 60 s window.
    vi.advanceTimersByTime(61_000);
    expect(isRateLimited(IP)).toBe(false);
    vi.useRealTimers();
  });

  it("a new failure after window expiry starts a fresh window", () => {
    vi.useFakeTimers();
    // Hit the limit then wait for expiry.
    for (let i = 0; i < 5; i++) recordAuthFailure(IP);
    vi.advanceTimersByTime(61_000);
    expect(isRateLimited(IP)).toBe(false);

    // Four fresh failures — should not re-lock.
    for (let i = 0; i < 4; i++) recordAuthFailure(IP);
    expect(isRateLimited(IP)).toBe(false);
    vi.useRealTimers();
  });

  // ─── the sweep ──────────────────────────────────────────────────────────────
  //
  // These assert on `failureRecordCount()` rather than `isRateLimited()`, and that
  // is the whole point. `isRateLimited` deletes an expired record as it reads it,
  // so it reports `false` for an expired IP whether or not the sweep ran: a test
  // phrased as "…then isRateLimited is false" passes with the sweep body replaced
  // by `return`. Retention is only visible as a count.

  it("sweepExpiredFailures removes entries whose window has elapsed", () => {
    vi.useFakeTimers();
    expect(failureRecordCount()).toBe(0);
    for (let i = 0; i < 5; i++) recordAuthFailure(IP);
    for (let i = 0; i < 5; i++) recordAuthFailure(OTHER_IP);
    expect(failureRecordCount()).toBe(2);

    vi.advanceTimersByTime(61_000);
    sweepExpiredFailures();

    expect(failureRecordCount()).toBe(0);
    vi.useRealTimers();
  });

  it("sweepExpiredFailures leaves entries whose window has not elapsed", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) recordAuthFailure(IP);
    expect(failureRecordCount()).toBe(1);

    // Sweep before the window expires — the entry must survive, still counting.
    vi.advanceTimersByTime(30_000);
    sweepExpiredFailures();
    expect(failureRecordCount()).toBe(1);
    expect(isRateLimited(IP)).toBe(true);
    vi.useRealTimers();
  });

  it("reclaims IPs that fail once and never come back — the leak the sweep exists for", () => {
    // The lazy delete in `isRateLimited` only fires for an IP that returns. A scan
    // from a wide range of source addresses leaves an entry per address, and
    // without the sweep nothing ever reclaims them.
    vi.useFakeTimers();
    expect(failureRecordCount()).toBe(0);
    for (const ip of SCAN_IPS) recordAuthFailure(ip);
    expect(failureRecordCount()).toBe(SCAN_IPS.length);

    vi.advanceTimersByTime(61_000);
    sweepExpiredFailures();

    expect(failureRecordCount()).toBe(0);
    vi.useRealTimers();
  });
});
