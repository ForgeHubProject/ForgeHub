import { vi, describe, it, expect, beforeEach } from "vitest";
import ssh2 from "ssh2";
import type { AuthContext, ParsedKey } from "ssh2";
import type { FastifyInstance } from "fastify";

// Mock the credential store so onAuthentication needs no DB. The keys themselves
// are real (generated below) so signature verification runs the production path.
vi.mock("../ssh/store.js", () => ({
  resolveActorByFingerprint: vi.fn(),
  touchSshKey: vi.fn(),
  touchDeployKey: vi.fn(),
}));

import { onAuthentication, isRateLimited, recordAuthFailure, resetAuthFailures } from "../ssh/server.js";
import { resolveActorByFingerprint, type SshActor } from "../ssh/store.js";

// ─── why this file exists ─────────────────────────────────────────────────────
//
// The publickey flow has two rounds: an unsigned "is this key acceptable?" probe,
// then a signed request. Fingerprints are NOT secret — anyone can hold a valid
// registered public key. If the unsigned probe clears the failure counter, an
// attacker can interleave probes with forged-signature attempts and the
// 5-failures/60s limiter never fires. So the limiter reset must happen only
// after a VERIFIED signature. These tests pin that placement; they were added
// with the fix that moved resetAuthFailures inside the signature branch.

const { utils: sshUtils } = ssh2;

function mustParseKey(key: string | Buffer): ParsedKey {
  const parsed = sshUtils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

/**
 * ssh2's own key generator occasionally emits an OpenSSH private key that its
 * own parser then rejects with "Malformed OpenSSH private key". Measured at
 * roughly 0.23% per key (7 unparsable in 3000 ed25519 pairs on this host), and
 * because these are generated at module scope, a bad draw fails the whole file
 * before a single test runs — an intermittent red CI on code that is fine.
 *
 * The fault is per-key and generation is cheap, so redraw instead of asserting.
 * Both halves are checked because the test uses both, and a pair is only useful
 * if it round-trips as a whole.
 */
function generateParsableKeyPair(): { public: string; private: string } {
  for (let attempt = 0; attempt < 8; attempt++) {
    const keys = sshUtils.generateKeyPairSync("ed25519");
    const parsedPriv = sshUtils.parseKey(keys.private);
    const parsedPub = sshUtils.parseKey(keys.public);
    if (!(parsedPriv instanceof Error) && !(parsedPub instanceof Error)) return keys;
  }
  // At the measured rate this is about 1 in 10^22 — so it means the generator
  // is broken outright, not that we were unlucky, and the message should say so.
  throw new Error("ssh2 produced no parsable ed25519 key pair in 8 attempts");
}

const userKeys = generateParsableKeyPair();
const strangerKeys = generateParsableKeyPair();

const rawUserPub = mustParseKey(userKeys.public).getPublicSSH();
const parsedUserPriv = mustParseKey(userKeys.private);
const parsedStrangerPriv = mustParseKey(strangerKeys.private);

const actor: SshActor = { kind: "user", userId: "u1", sshKeyId: "k1", publicKey: userKeys.public };

const app = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as FastifyInstance;

const IP = "192.0.2.77";
const SESSION_BLOB = Buffer.from("session-identifier-blob");

/**
 * Drive onAuthentication with a fake ssh2 AuthContext and resolve with what the
 * server decided. `signWith` present → a signed request; absent → the probe.
 */
function attempt(opts: { signWith?: ParsedKey } = {}): Promise<"accept" | "reject"> {
  return new Promise((resolve) => {
    const signature = opts.signWith ? opts.signWith.sign(SESSION_BLOB) : undefined;
    if (signature instanceof Error) throw signature;
    const ctx = {
      method: "publickey",
      key: { algo: "ssh-ed25519", data: rawUserPub },
      blob: opts.signWith ? SESSION_BLOB : undefined,
      signature,
      hashAlgo: undefined,
      accept: () => resolve("accept"),
      reject: () => resolve("reject"),
    } as unknown as AuthContext;
    onAuthentication(app, ctx, IP, () => {});
  });
}

beforeEach(() => {
  resetAuthFailures(IP);
  vi.clearAllMocks();
  vi.mocked(resolveActorByFingerprint).mockResolvedValue(actor);
});

describe("onAuthentication vs the rate limiter", () => {
  it("accepts the unsigned probe for a known key", async () => {
    await expect(attempt()).resolves.toBe("accept");
  });

  it("an unsigned probe does NOT clear recorded failures", async () => {
    for (let i = 0; i < 4; i++) recordAuthFailure(IP);

    await expect(attempt()).resolves.toBe("accept");

    // The 4 prior failures must survive the probe: one more locks the IP.
    // (Before the fix, the probe reset the counter and this stayed unlimited.)
    recordAuthFailure(IP);
    expect(isRateLimited(IP)).toBe(true);
  });

  it("a verified signature clears recorded failures", async () => {
    for (let i = 0; i < 4; i++) recordAuthFailure(IP);

    await expect(attempt({ signWith: parsedUserPriv })).resolves.toBe("accept");

    // Counter was reset on success — a single new failure must not lock.
    recordAuthFailure(IP);
    expect(isRateLimited(IP)).toBe(false);
  });

  it("a signature by the wrong key is rejected and counts as a failure", async () => {
    for (let i = 0; i < 4; i++) recordAuthFailure(IP);

    await expect(attempt({ signWith: parsedStrangerPriv })).resolves.toBe("reject");

    expect(isRateLimited(IP)).toBe(true);
  });

  it("a rate-limited IP is rejected before the probe is even considered", async () => {
    for (let i = 0; i < 5; i++) recordAuthFailure(IP);

    await expect(attempt()).resolves.toBe("reject");
    await expect(attempt({ signWith: parsedUserPriv })).resolves.toBe("reject");
  });

  it("unknown fingerprints lock the IP after 5 attempts through the real flow", async () => {
    vi.mocked(resolveActorByFingerprint).mockResolvedValue(null);

    for (let i = 0; i < 5; i++) {
      await expect(attempt()).resolves.toBe("reject");
    }
    expect(isRateLimited(IP)).toBe(true);
  });
});
