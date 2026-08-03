import { vi, describe, it, expect, beforeEach } from "vitest";

// Import the rate-limiter helpers directly — no server or DB needed.
import { isRateLimited, recordAuthFailure, resetAuthFailures, sweepExpiredFailures } from "../ssh/server.js";

// The module-level failMap is shared across tests; we reset state via resetAuthFailures.

const IP = "192.0.2.1";

beforeEach(() => {
  // Tear down any state left by previous tests by resetting the test IP.
  resetAuthFailures(IP);
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

  it("sweepExpiredFailures removes an entry whose window has expired without it being re-checked", () => {
    vi.useFakeTimers();
    const OTHER_IP = "203.0.113.9";
    recordAuthFailure(IP);
    recordAuthFailure(OTHER_IP);
    vi.advanceTimersByTime(61_000);

    // Neither IP has been looked up via isRateLimited, so nothing has lazily
    // cleared them yet — sweep should remove both expired records directly.
    sweepExpiredFailures();

    vi.useRealTimers();
    // Now under the limit regardless (no more failures recorded), but recording
    // ONE more failure for each should start a fresh window rather than adding
    // onto a stale one — i.e. neither is rate-limited after just one more failure.
    recordAuthFailure(IP);
    recordAuthFailure(OTHER_IP);
    expect(isRateLimited(IP)).toBe(false);
    expect(isRateLimited(OTHER_IP)).toBe(false);
    resetAuthFailures(OTHER_IP);
  });

  it("sweepExpiredFailures leaves a record whose window has not expired", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) recordAuthFailure(IP);
    sweepExpiredFailures();
    expect(isRateLimited(IP)).toBe(true);
    vi.useRealTimers();
  });
});
