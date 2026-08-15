/**
 * HTTP semantics for /rawblob — the caching, validator, and concurrency rules
 * (issue #157 hardening). Kept apart from the route so everything that needs
 * neither a git repo nor a real socket stays unit-testable on any platform.
 */

/**
 * Ceiling on concurrently streaming /rawblob responses. Each in-flight stream
 * pins one `git cat-file` child for the connection's lifetime — a deliberate
 * property of streaming with no size cap — so an unbounded number of slow
 * clients means an unbounded number of live git children. Saturation answers
 * 503 + Retry-After rather than queueing: the client can retry cheaply, the
 * server cannot un-spawn a child.
 *
 * Conditional requests (If-None-Match → 304) bypass the cap entirely: they
 * spawn nothing, and a saturated server should still be able to say "you
 * already have it".
 */
export const MAX_CONCURRENT_RAWBLOB_STREAMS = 6;

let activeStreams = 0;

/** Claim a stream slot. Returns false — without side effects — when saturated. */
export function tryAcquireRawblobStream(): boolean {
  if (activeStreams >= MAX_CONCURRENT_RAWBLOB_STREAMS) return false;
  activeStreams += 1;
  return true;
}

/** Release a claimed slot. Floors at zero so a double release cannot corrupt the count. */
export function releaseRawblobStream(): void {
  if (activeStreams > 0) activeStreams -= 1;
}

/** Test seam — nothing in the server reads it. */
export function activeRawblobStreams(): number {
  return activeStreams;
}

/**
 * Cache policy for a raw blob, split by repo visibility.
 *
 * The URL pins `sha` + `path`, and a blob at a commit can never change, so the
 * response is immutable in the RFC 8246 sense — but only a PUBLIC repo may say
 * `public`: the previous unconditional `public, max-age=3600` let any shared
 * cache (a corporate proxy, a CDN) store and re-serve private-repo bytes to
 * whoever asked next. Private repos get `private`, which keeps the browser
 * cache win and excludes shared caches.
 */
export function rawblobCacheControl(visibility: string): string {
  return visibility === "PUBLIC" ? "public, max-age=3600, immutable" : "private, max-age=3600";
}

/**
 * RFC 9110 §13.1.2 If-None-Match, for the one shape /rawblob emits: a single
 * strong ETag. `W/`-prefixed candidates are accepted (weak comparison is what
 * §13.1.2 prescribes for If-None-Match), as is the `*` wildcard.
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw.trim() === "*") return true;
  return raw.split(",").some((candidate) => {
    const v = candidate.trim();
    return v === etag || v === `W/${etag}`;
  });
}
