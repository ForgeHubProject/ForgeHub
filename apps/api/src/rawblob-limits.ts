/**
 * Operational limits for the streamed `/rawblob` route (#157 phase 2).
 *
 * The important thing this file does is **not** cap file size. `/rawblob`
 * streams (`git cat-file blob <oid>` piped straight to the response), so serving
 * a 4 GiB blob costs the same resident memory as serving a 4 KiB one. A
 * contributor who pushes a huge file can fetch it back; the cost of that choice
 * lands on their own connection, not on a server-side ceiling that reports their
 * file as unserveable. An operator who *wants* a ceiling can opt into one, but
 * there is none by default.
 *
 * What is genuinely finite is **concurrency**: every in-flight response pins one
 * blocked `git cat-file` child for the lifetime of the connection, and a slow
 * client on a large file holds it for a long time. That — not file size — is the
 * only unbounded resource the streamed route has left, so it is the one thing
 * with a default limit.
 */

/**
 * How many raw-blob responses may be streaming at once before further requests
 * are shed with 503. Deliberately generous: this bounds *simultaneous
 * downloads*, never the size of any one of them.
 */
export const DEFAULT_MAX_CONCURRENT_RAWBLOB_STREAMS = 64;

/** Seconds advertised in `Retry-After` when the concurrency limit sheds a request. */
export const RAWBLOB_RETRY_AFTER_SECONDS = 5;

/** Read an env var as a positive integer; null when unset, blank or unusable. */
function positiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

/**
 * An OPTIONAL, opt-in size ceiling for `/rawblob`, in bytes, from
 * `FORGEHUB_RAWBLOB_MAX_BYTES`.
 *
 * **Unset by default, and unset means unlimited** — that is the product
 * decision, not an oversight (#157). It exists only so an operator running a
 * shared instance can choose a policy ceiling for their own bandwidth; nothing
 * in ForgeHub sets it. A value that isn't a positive integer is ignored (i.e.
 * stays unlimited) rather than silently becoming some other number.
 */
export function rawblobMaxBytes(): number | null {
  return positiveIntEnv("FORGEHUB_RAWBLOB_MAX_BYTES");
}

/**
 * The concurrent-stream limit, from `FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS`,
 * falling back to {@link DEFAULT_MAX_CONCURRENT_RAWBLOB_STREAMS}.
 */
export function rawblobMaxConcurrentStreams(): number {
  return positiveIntEnv("FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS")
    ?? DEFAULT_MAX_CONCURRENT_RAWBLOB_STREAMS;
}

let active = 0;

/** Gauge: raw-blob responses currently streaming (surfaced on `/health`). */
export function activeRawblobStreams(): number {
  return active;
}

/**
 * Take a slot for one streamed response, or return null when the instance is
 * already at its concurrency limit (the caller answers 503 + `Retry-After`).
 *
 * The returned release is idempotent on purpose: the route calls it from both
 * the child's `exit` and the connection's `close`, whichever happens first.
 */
export function acquireRawblobStream(): (() => void) | null {
  if (active >= rawblobMaxConcurrentStreams()) return null;
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
  };
}
