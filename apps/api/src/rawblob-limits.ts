/**
 * Operational settings for the streamed `/rawblob` route (#157 phase 2).
 *
 * ## There is nothing here that can stop a download
 *
 * `/rawblob` streams (`git cat-file blob <oid>` piped straight to the response),
 * so serving a 4 GiB blob costs the same resident memory as serving a 4 KiB one.
 * A contributor who pushes a huge file can fetch it back; the cost of that choice
 * lands on their own connection, not on a server-side ceiling that reports their
 * file as unserveable.
 *
 * The only knob in this file is an **opt-in** byte ceiling that is unset by
 * default. Nothing else in the API bounds, times, paces or counts a raw-blob
 * download, and that is deliberate — see below.
 *
 * ## What used to be here, and why it is gone
 *
 * Earlier revisions of this route carried a concurrency semaphore (a global slot
 * pool, a queue, and 503 shedding) plus a "stall timeout" built on the socket's
 * own idle timer. Both are deleted. Three separate defects came out of them, and
 * two were not fixable in that shape:
 *
 * 1. **A socket idle timeout cannot tell "slow" from "stalled".** Node's socket
 *    timer is reset on write *dispatch*, and under pipe backpressure a dispatch
 *    only happens when the socket's write queue drains to empty — which is gated
 *    on the peer having consumed everything already buffered downstream (~1 MB on
 *    a typical host). A client reading continuously at 8 KiB/s therefore looks
 *    exactly like one reading nothing, and was dropped: measured on this route at
 *    the shipped 30 s default, 8 and 16 KiB/s were killed and only 32 KiB/s
 *    survived. Below that floor a large blob can never be fetched, every retry
 *    dies at the same offset, and `Accept-Ranges: none` means it cannot be
 *    resumed — a size ceiling for slow links wearing a different hat, which is
 *    precisely what this route must not have.
 * 2. **Arming it leaked the connection reaper API-wide.** Restoring the previous
 *    socket timeout on response close cancelled the `setTimeout(keepAliveTimeout)`
 *    that Node installs from its own `finish` handler, so any client could hold
 *    sockets and file descriptors open forever, on *any* route, by issuing one
 *    tiny `/rawblob` GET per connection. Nothing in this route touches
 *    `socket.setTimeout` any more, and nothing should.
 * 3. **A global slot pool is a denial-of-service amplifier, not a defence.** With
 *    64 shared slots, 64 sockets that take the headers and read nothing deny
 *    `/rawblob` to *everyone*. Reclaiming slots on a timer only changed the price
 *    from "hold a socket" to "reconnect every 30 s" — still about zero. A pool
 *    small enough to bound git children is small enough to be filled by one
 *    client, and the API cannot tell clients apart: behind the bundled nginx it
 *    sees the proxy's address as the peer for every request and Fastify is built
 *    without `trustProxy`, so a per-IP share would read the entire internet as
 *    one client.
 *
 * ## What bounds the route now
 *
 * The same things that bound every other streaming git host (GitLab and Gitea
 * serve raw blobs unbounded on exactly this basis), each of them in the layer
 * that can actually see what it is limiting:
 *
 * - **nginx**, which in the shipped topology is the edge and therefore *does*
 *   see the real client address. `apps/web/nginx.conf` gives `/rawblob` a
 *   per-client concurrent-connection cap (`limit_conn`), so one client can be
 *   bounded without denying anybody else, and a `send_timeout` that is an idle
 *   timer on the downstream write — reset by partial progress, unlike Node's.
 * - **Node's own connection reaping** — `keepAliveTimeout` for idle keep-alive
 *   sockets and `headersTimeout` for a request that never arrives — which now
 *   works on this route because nothing disarms it.
 * - **TCP backpressure**, which is what makes a slow reader cost the server one
 *   blocked `git cat-file` and one relay buffer rather than memory proportional
 *   to the file.
 *
 * A concurrent-download cap that is aware of who is asking belongs with the
 * deployment-wide decision to trust a forwarded-for header, not in this route.
 */

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
 *
 * Note that this is a ceiling on the *declared size*, checked once during the
 * pre-flight while the headers are still writable, so an over-limit request gets
 * an honest 413 naming the real size. It never interrupts a transfer that has
 * started.
 */
export function rawblobMaxBytes(): number | null {
  return intEnv("FORGEHUB_RAWBLOB_MAX_BYTES", 1);
}
