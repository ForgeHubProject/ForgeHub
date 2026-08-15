import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_CONCURRENT_RAWBLOB_STREAMS,
  tryAcquireRawblobStream,
  releaseRawblobStream,
  activeRawblobStreams,
  rawblobCacheControl,
  etagMatches,
} from "../rawblob-http.js";

// ─── why this file exists ─────────────────────────────────────────────────────
//
// The /rawblob integration tests (rawblob-stream.test.ts) need a POSIX shell and
// a real socket, so they never run on Windows. The pure HTTP semantics of the
// #157 hardening — cache visibility split, ETag matching, the stream cap — are
// platform-independent and are pinned here where every machine runs them.

const OID_ETAG = '"0123456789abcdef0123456789abcdef01234567"';

beforeEach(() => {
  // The counter is module-level shared state; drain whatever an earlier test
  // (or an aborted one) left behind so each test starts from zero.
  while (activeRawblobStreams() > 0) releaseRawblobStream();
});

describe("rawblobCacheControl", () => {
  it("marks public-repo blobs shared-cacheable and immutable", () => {
    expect(rawblobCacheControl("PUBLIC")).toBe("public, max-age=3600, immutable");
  });

  it("keeps private-repo blobs out of shared caches", () => {
    expect(rawblobCacheControl("PRIVATE")).toBe("private, max-age=3600");
  });

  it("treats anything that is not exactly PUBLIC as private — fail closed", () => {
    expect(rawblobCacheControl("public")).toBe("private, max-age=3600");
    expect(rawblobCacheControl("")).toBe("private, max-age=3600");
    expect(rawblobCacheControl("INTERNAL")).toBe("private, max-age=3600");
  });
});

describe("etagMatches", () => {
  it("matches the exact strong ETag", () => {
    expect(etagMatches(OID_ETAG, OID_ETAG)).toBe(true);
  });

  it("matches a weak-prefixed candidate (If-None-Match uses weak comparison)", () => {
    expect(etagMatches(`W/${OID_ETAG}`, OID_ETAG)).toBe(true);
  });

  it("matches within a comma-separated list", () => {
    expect(etagMatches(`"aaa", ${OID_ETAG}, "bbb"`, OID_ETAG)).toBe(true);
  });

  it("matches the * wildcard", () => {
    expect(etagMatches("*", OID_ETAG)).toBe(true);
  });

  it("rejects a different ETag, an empty header, and an absent header", () => {
    expect(etagMatches('"another"', OID_ETAG)).toBe(false);
    expect(etagMatches("", OID_ETAG)).toBe(false);
    expect(etagMatches(undefined, OID_ETAG)).toBe(false);
  });

  it("handles a repeated header arriving as an array", () => {
    expect(etagMatches(['"aaa"', OID_ETAG], OID_ETAG)).toBe(true);
    expect(etagMatches(['"aaa"', '"bbb"'], OID_ETAG)).toBe(false);
  });
});

describe("stream cap", () => {
  it("grants exactly MAX_CONCURRENT_RAWBLOB_STREAMS slots, then refuses", () => {
    for (let i = 0; i < MAX_CONCURRENT_RAWBLOB_STREAMS; i++) {
      expect(tryAcquireRawblobStream()).toBe(true);
    }
    expect(tryAcquireRawblobStream()).toBe(false);
    expect(activeRawblobStreams()).toBe(MAX_CONCURRENT_RAWBLOB_STREAMS);
  });

  it("a refused acquire does not consume a slot", () => {
    for (let i = 0; i < MAX_CONCURRENT_RAWBLOB_STREAMS; i++) tryAcquireRawblobStream();
    tryAcquireRawblobStream(); // refused
    releaseRawblobStream();
    // If the refusal had incremented anything, this acquire would now fail.
    expect(tryAcquireRawblobStream()).toBe(true);
  });

  it("release frees a slot for the next acquire", () => {
    for (let i = 0; i < MAX_CONCURRENT_RAWBLOB_STREAMS; i++) tryAcquireRawblobStream();
    releaseRawblobStream();
    expect(tryAcquireRawblobStream()).toBe(true);
    expect(tryAcquireRawblobStream()).toBe(false);
  });

  it("release floors at zero — a double release cannot mint extra capacity", () => {
    tryAcquireRawblobStream();
    releaseRawblobStream();
    releaseRawblobStream(); // extra
    releaseRawblobStream(); // extra
    expect(activeRawblobStreams()).toBe(0);
    // Capacity is still exactly MAX, not MAX + the extra releases.
    for (let i = 0; i < MAX_CONCURRENT_RAWBLOB_STREAMS; i++) {
      expect(tryAcquireRawblobStream()).toBe(true);
    }
    expect(tryAcquireRawblobStream()).toBe(false);
  });
});
