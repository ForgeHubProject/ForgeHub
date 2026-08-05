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
 * blocked `git cat-file` child for as long as the client keeps reading, and a
 * slow client on a large file holds it for a long time. So the streamed route
 * gets a slot limit — and, because a slot limit is itself a shared resource, two
 * things that keep it from becoming a denial-of-service surface in its own right:
 *
 * 1. **A stall timeout** ({@link rawblobStallTimeoutMs}). A slot is held for as
 *    long as the transfer is *making progress*, not for as long as the socket is
 *    open. A client that takes the headers and then reads nothing — free to
 *    mount, costing the attacker no bandwidth — would otherwise hold its slot
 *    forever; instead it is reaped and the slot comes back on its own. A
 *    genuinely slow client that keeps consuming bytes is never touched, which is
 *    the point: this bounds *idleness*, not throughput, and never file size.
 * 2. **A short queue** ({@link rawblobQueueWaitMs}). A burst past the limit waits
 *    briefly for a slot instead of being refused outright, so a momentary spike
 *    costs latency rather than a failed download. 503 is what happens when the
 *    queue *also* fails to clear.
 *
 * What this deliberately does NOT do, and what an operator should know:
 *
 * - **It is still a shared limit.** Enough clients that each keep reading, just
 *   slowly, can hold every slot; the rest queue and are then shed with 503. The
 *   stall timeout makes that cost an attacker real, sustained bandwidth rather
 *   than an idle socket, but the ceiling is global, and a saturated instance
 *   refuses raw-blob downloads to everyone. That is a genuine availability
 *   trade-off accepted in exchange for bounding git children — not free
 *   insurance. Raise {@link rawblobMaxConcurrentStreams} if it ever bites.
 * - **There is no per-client share.** It would be the obvious next control, and
 *   it is deliberately absent: in the shipped topology (docker-compose, nginx in
 *   the `web` container proxying to `api`) the API sees the proxy's address as
 *   the peer for every request, and the server is built without `trustProxy` —
 *   so a per-IP cap would read the entire internet as one client and throttle
 *   everybody to a single share. Making it work means trusting a forwarded-for
 *   header, which is a deployment-wide decision, not a rawblob-shaped one.
 * - **The pre-flight is not covered.** Slots are taken around the streaming body
 *   only. Every request — 404s, 304s, and the ones shed with 503 — still spawns
 *   one short-lived `git cat-file --batch-check` for the size lookup, inherited
 *   from phase 1 and no different from any other git-touching route. So this is
 *   the last unbounded *long-lived* resource on the route, not the last spawn.
 */

/**
 * How many raw-blob responses may be streaming at once before further requests
 * queue and then shed with 503. Deliberately generous: this bounds *simultaneous
 * downloads*, never the size of any one of them.
 */
export const DEFAULT_MAX_CONCURRENT_RAWBLOB_STREAMS = 64;

/**
 * How long a streaming response may make **no progress at all** before the
 * connection is dropped and its slot returned, in milliseconds.
 *
 * This is a socket-idle timeout, so it measures stalling, not slowness: every
 * byte that actually reaches the client restarts the clock. Thirty seconds is
 * long enough that no real transfer — however slow the link — trips it, and
 * short enough that a pool wedged by non-reading clients clears itself.
 */
export const DEFAULT_RAWBLOB_STALL_TIMEOUT_MS = 30_000;

/**
 * How long a request may wait for a free slot before it is shed, in
 * milliseconds. Turns a brief pile-up into added latency instead of a 503.
 */
export const DEFAULT_RAWBLOB_QUEUE_WAIT_MS = 10_000;

/** Seconds advertised in `Retry-After` when the concurrency limit sheds a request. */
export const RAWBLOB_RETRY_AFTER_SECONDS = 5;

/**
 * `s-maxage` for a public repo's blobs: how long a **shared** cache (a CDN, a
 * corporate proxy) may serve them without revalidating.
 *
 * The bytes behind a commit-pinned URL never change, so `immutable` and a
 * year-long `max-age` are truthful about *content* — but they say nothing about
 * *authorization*, and a repo can be flipped from public to private. Without
 * this, that flip would leave the old bytes servable from any intermediary for a
 * year, with `immutable` suppressing the revalidation that would have caught it.
 * `s-maxage` bounds only the shared copy; a private browser cache keeps the full
 * year, which is harmless because that client already holds the bytes.
 */
export const RAWBLOB_SHARED_MAX_AGE_SECONDS = 600;

/**
 * Env values already rejected, so a misconfiguration is announced once instead
 * of being silently swallowed. Keyed by `name=value`, so a different bad value
 * still gets its own warning.
 */
const warnedEnv = new Set<string>();

function warnBadEnv(name: string, raw: string, expectation: string) {
  const key = `${name}=${raw}`;
  if (warnedEnv.has(key)) return;
  warnedEnv.add(key);
  console.warn(
    `[rawblob] ignoring ${name}=${JSON.stringify(raw)}: expected ${expectation}. ` +
      `Using the default instead — this is NOT read as 0 or as "off".`,
  );
}

/**
 * Read an env var as an integer of at least `min`; null when unset or blank.
 *
 * A value that is present but unusable is **reported**, not silently dropped:
 * `FORGEHUB_RAWBLOB_MAX_BYTES=0` reads as "serve nothing" and would otherwise
 * become "unlimited", the exact opposite of the operator's intent.
 */
function intEnv(name: string, min: number): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min) {
    warnBadEnv(name, raw, `an integer >= ${min}`);
    return null;
  }
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
 * stays unlimited) *and logged*, rather than silently becoming another number.
 */
export function rawblobMaxBytes(): number | null {
  return intEnv("FORGEHUB_RAWBLOB_MAX_BYTES", 1);
}

/**
 * The concurrent-stream limit, from `FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS`,
 * falling back to {@link DEFAULT_MAX_CONCURRENT_RAWBLOB_STREAMS}.
 */
export function rawblobMaxConcurrentStreams(): number {
  return intEnv("FORGEHUB_RAWBLOB_MAX_CONCURRENT_STREAMS", 1)
    ?? DEFAULT_MAX_CONCURRENT_RAWBLOB_STREAMS;
}

/**
 * The stall timeout, from `FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS`, falling back to
 * {@link DEFAULT_RAWBLOB_STALL_TIMEOUT_MS}. `0` disables it, restoring "a
 * stalled client holds its slot until it disconnects" — an explicit choice, and
 * one a typo cannot reach: a malformed value warns and uses the default.
 */
export function rawblobStallTimeoutMs(): number {
  return intEnv("FORGEHUB_RAWBLOB_STALL_TIMEOUT_MS", 0) ?? DEFAULT_RAWBLOB_STALL_TIMEOUT_MS;
}

/**
 * How long to wait for a slot before shedding, from
 * `FORGEHUB_RAWBLOB_QUEUE_WAIT_MS`. `0` sheds immediately with no queue.
 */
export function rawblobQueueWaitMs(): number {
  return intEnv("FORGEHUB_RAWBLOB_QUEUE_WAIT_MS", 0) ?? DEFAULT_RAWBLOB_QUEUE_WAIT_MS;
}

/** Releases a slot. Idempotent: callers fire it from whichever event wins. */
export type RawblobSlot = () => void;

type Waiter = { resolve: (slot: RawblobSlot | null) => void; timer: NodeJS.Timeout };

let active = 0;
const waiting: Waiter[] = [];

/** Gauge: raw-blob responses currently streaming (surfaced on `/health`). */
export function activeRawblobStreams(): number {
  return active;
}

/** Gauge: requests parked waiting for a slot (surfaced on `/health`). */
export function queuedRawblobStreams(): number {
  return waiting.length;
}

function takeSlot(): RawblobSlot {
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    pump();
  };
}

/** Hand freed slots to whoever has been waiting longest. */
function pump() {
  while (waiting.length > 0 && active < rawblobMaxConcurrentStreams()) {
    const next = waiting.shift();
    if (!next) return;
    clearTimeout(next.timer);
    next.resolve(takeSlot());
  }
}

/**
 * Take a slot for one streamed response.
 *
 * Resolves with a release function, or with `null` when the instance is at its
 * limit and stays there for the whole queue window (the caller answers 503 +
 * `Retry-After`). The queue is itself bounded by the concurrency limit, so a
 * flood cannot turn "too many downloads" into "unbounded parked requests".
 *
 * The release is idempotent on purpose: the route calls it from the child's
 * `close` and from the connection's `close`, whichever happens first.
 */
export function acquireRawblobStream(): Promise<RawblobSlot | null> {
  if (active < rawblobMaxConcurrentStreams()) return Promise.resolve(takeSlot());

  const waitMs = rawblobQueueWaitMs();
  if (waitMs <= 0 || waiting.length >= rawblobMaxConcurrentStreams()) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const waiter: Waiter = {
      resolve,
      timer: setTimeout(() => {
        const i = waiting.indexOf(waiter);
        if (i >= 0) waiting.splice(i, 1);
        resolve(null);
      }, waitMs),
    };
    // A parked request must never be the reason the process stays alive.
    waiter.timer.unref?.();
    waiting.push(waiter);
  });
}
