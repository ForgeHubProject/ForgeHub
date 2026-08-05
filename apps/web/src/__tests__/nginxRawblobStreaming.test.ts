/**
 * The shipped reverse proxy must stream `/rawblob`, not buffer it (#157 phase 2).
 *
 * Why this is a test and not a comment: the API's whole claim is that a blob of
 * any size costs one relay buffer. `docker-compose.yml` and the README document
 * the nginx container as *the* way to run ForgeHub, and nginx buffers proxied
 * responses by default — it fills `proxy_buffers` and then spools the remainder
 * to a temp file (`proxy_max_temp_file_size`, 1 GiB by default) on the web
 * container's writable layer, where no volume is mounted, before any
 * backpressure reaches the API. With no size ceiling that is up to ~1 GiB of
 * container disk per in-flight download, and the streaming property holds only
 * inside the API process.
 *
 * The config is not executable here (no nginx in CI), so this asserts the two
 * things that must be true of it and would silently regress if the location
 * block were dropped or reordered. `location /git/` already carries the
 * request-side twin of this (`proxy_request_buffering off`) — the response side
 * is what streaming raw blobs needs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Comments stripped first, the way nginx reads it: `#` runs to end of line, and
// the word "location" inside a comment is not a location block.
const rawConf = readFileSync(fileURLToPath(new URL("../../nginx.conf", import.meta.url)), "utf8");
const conf = rawConf
  .split("\n")
  .map((line) => line.replace(/#.*$/, ""))
  .join("\n");

/** Split into `location <matcher> { ... }` blocks, in file order. */
function locations(): { matcher: string; body: string }[] {
  const out: { matcher: string; body: string }[] = [];
  const re = /\blocation\s+([^{}]+?)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(conf)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < conf.length && depth > 0; i++) {
      if (conf[i] === "{") depth++;
      else if (conf[i] === "}") depth--;
    }
    out.push({ matcher: m[1].trim(), body: conf.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** The regex nginx would use for a `~`-style location. */
function asRegex(matcher: string): RegExp | null {
  const m = /^~\s*(.+)$/.exec(matcher);
  return m ? new RegExp(m[1]) : null;
}

const RAWBLOB_PATH = "/repos/alice/assets/rawblob";

describe("nginx.conf — raw blob responses stream end to end", () => {
  it("routes /rawblob to a location that turns response buffering off", () => {
    // nginx tries regex locations in order of definition and takes the first
    // match, so "first location whose regex matches" is the one that serves it.
    const winner = locations().find((l) => asRegex(l.matcher)?.test(RAWBLOB_PATH));
    expect(winner, `no location matches ${RAWBLOB_PATH}`).toBeDefined();
    // Without this nginx reads the whole blob before the client sees any of it.
    expect(winner?.body).toMatch(/proxy_buffering\s+off\s*;/);
    // And without this the overflow goes to a temp file on disk instead.
    expect(winner?.body).toMatch(/proxy_max_temp_file_size\s+0\s*;/);
    expect(winner?.body).toMatch(/proxy_pass\s+http:\/\/api:3001\s*;/);
  });

  it("keeps that location ahead of the catch-all API location", () => {
    const all = locations();
    const rawblobIdx = all.findIndex((l) => asRegex(l.matcher)?.test(RAWBLOB_PATH));
    const generalIdx = all.findIndex((l) => l.matcher.includes("health|auth|repos"));
    expect(rawblobIdx).toBeGreaterThanOrEqual(0);
    expect(generalIdx).toBeGreaterThanOrEqual(0);
    // Reordering these is a silent regression: the general location matches
    // /rawblob too, and it buffers.
    expect(rawblobIdx).toBeLessThan(generalIdx);
  });

  it("raises the timeout that actually governs writing the body to a slow client", () => {
    // `send_timeout` is the one that governs writing the RESPONSE to the client.
    // `proxy_send_timeout` governs writing the *request* to the upstream and,
    // for a bodyless GET, never comes into play — an earlier revision raised
    // only that one and left the response side on nginx's 60 s default, which
    // is a cut-off for exactly the slow, large download this route exists to
    // serve.
    //
    // Raising it does NOT make it unreachable. `send_timeout` is not reset by
    // partial progress (nginx clears it only when the client socket becomes
    // writable, which needs a substantial fraction of the send buffer to
    // drain), so it imposes a rate floor of about (socket buffering) /
    // send_timeout. The value is large because raising it is the only way to
    // lower that floor.
    const winner = locations().find((l) => asRegex(l.matcher)?.test(RAWBLOB_PATH));
    expect(winner?.body).toMatch(/(?:^|[\s;])send_timeout\s+\S+\s*;/);
    // Reading the response from the API — only live when git itself goes quiet.
    expect(winner?.body).toMatch(/proxy_read_timeout\s+\S+\s*;/);
  });

  it("documents the rate floor send_timeout imposes instead of claiming it away", () => {
    // This route's whole premise is that nothing caps a slow download, and the
    // proxy is the one place that is not strictly true. Measured against this
    // file with nginx 1.24.0: at `send_timeout 5s` a client reading
    // continuously at 8/32/128/192 KiB/s was dropped at ~5 s; at `20s` the
    // floor moved to ~80 KiB/s. Earlier revisions of this file asserted the
    // opposite — that partial progress resets the timer — which is the failure
    // this guards: the comment must describe the floor, not deny it. Asserted
    // against the RAW file, comments included — that is where the claim lives.
    //
    // The guard is worded to still fail on the original sentence ("is reset by
    // partial progress") while allowing the corrected one ("is NOT reset by
    // partial progress"), so it pins the meaning rather than the keyword.
    expect(rawConf, "nginx.conf must not claim partial progress resets send_timeout").not.toMatch(
      /\bis reset by partial progress/i,
    );
    // And it must say what the limit actually is, so an operator can act on it.
    expect(rawConf, "nginx.conf must name the rate floor send_timeout imposes").toMatch(/floor/i);
  });

  it("caps raw-blob concurrency PER CLIENT at the edge, which is the only layer that can", () => {
    // This is what replaced the API-side semaphore. A global cap in the API is a
    // denial-of-service amplifier — the API sees the proxy's address as the peer
    // for every request, so it cannot tell clients apart, and a shared pool is
    // filled (and thereby denied to everyone) by a handful of sockets that take
    // the headers and read nothing. nginx is the edge and sees the real address.
    const winner = locations().find((l) => asRegex(l.matcher)?.test(RAWBLOB_PATH));
    const zone = /limit_conn_zone\s+\$binary_remote_addr\s+zone=(\w+):/.exec(conf);
    expect(zone, "no per-client limit_conn_zone declared").not.toBeNull();
    const use = new RegExp(`limit_conn\\s+${zone?.[1]}\\s+(\\d+)\\s*;`).exec(winner?.body ?? "");
    expect(use, "the rawblob location does not use that zone").not.toBeNull();
    // A count of simultaneous downloads, never a size or a duration — and
    // generous, since a browser opens at most ~6 connections per host.
    expect(Number(use?.[1])).toBeGreaterThanOrEqual(8);
  });

  it("still matches only the rawblob route, leaving the rest of the API alone", () => {
    const rawblob = locations().find((l) => asRegex(l.matcher)?.test(RAWBLOB_PATH));
    const re = asRegex(rawblob?.matcher ?? "");
    expect(re).not.toBeNull();
    for (const other of [
      "/repos/alice/assets/filediff",
      "/repos/alice/assets",
      "/health",
      "/git/alice/assets.git/info/refs",
    ]) {
      expect(re?.test(other), `${other} must not land in the rawblob location`).toBe(false);
    }
  });
});
