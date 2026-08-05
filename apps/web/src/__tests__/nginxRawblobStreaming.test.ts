/**
 * The shipped reverse proxy must stream `/rawblob`, not buffer it (#157 phase 2).
 *
 * Why this is a test and not a comment: the API's whole claim is that a blob of
 * any size costs one relay buffer. `docker-compose.yml` and the README document
 * the nginx container as *the* way to run ForgeHub, and nginx buffers proxied
 * responses by default — it fills `proxy_buffers` and then spools the remainder
 * to a temp file (`proxy_max_temp_file_size`, 1 GiB by default) on the web
 * container's writable layer, where no volume is mounted, before any
 * backpressure reaches the API. With no size ceiling and a 64-slot pool that is
 * up to ~64 GiB of container disk, and the streaming property holds only inside
 * the API process.
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
const conf = readFileSync(fileURLToPath(new URL("../../nginx.conf", import.meta.url)), "utf8")
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

  it("does not cut a large, slow download off at nginx's 60s defaults", () => {
    const winner = locations().find((l) => asRegex(l.matcher)?.test(RAWBLOB_PATH));
    expect(winner?.body).toMatch(/proxy_read_timeout\s+\S+\s*;/);
    expect(winner?.body).toMatch(/proxy_send_timeout\s+\S+\s*;/);
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
