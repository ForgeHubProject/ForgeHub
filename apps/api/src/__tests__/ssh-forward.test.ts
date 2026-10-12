import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import ssh2 from "ssh2";
import type { AuthContext, ParsedKey } from "ssh2";
import type { FastifyInstance } from "fastify";

vi.mock("../ssh/store.js", () => ({
  resolveActorByFingerprint: vi.fn(),
  touchSshKey: vi.fn(),
  touchDeployKey: vi.fn(),
}));

import { isRateLimited, onAuthentication, resetAuthFailures, type BoundActor } from "../ssh/server.js";
import { resolveActorByFingerprint, type SshActor } from "../ssh/store.js";
import { decodeForwardUser, encodeForwardUser, forwardKeys, isForwardKey, isPrivateAddress, KEYS_USER } from "../ssh/forward.js";
import { generateEd25519KeyPair } from "../ssh/keygen.js";
import { fingerprintFromRaw, parsePublicKey } from "../ssh/keys.js";

// The host's sshd serves port 22 and forwards git to ForgeHub over a second SSH
// connection (ssh/forward.ts). That connection is trusted to name who it acts for
// ONLY if it proves possession of the forward key — these tests pin that boundary.

const { utils: sshUtils } = ssh2;
const mustParse = (k: string | Buffer): ParsedKey => {
  const p = sshUtils.parseKey(k);
  if (p instanceof Error) throw p;
  return p;
};

const forward = generateEd25519KeyPair(); // the host's forward key
const stranger = generateEd25519KeyPair(); // some other key pair
const person = generateEd25519KeyPair(); // a registered user's key

const forwardPriv = mustParse(forward.private);
const strangerPriv = mustParse(stranger.private);
const personFp = fingerprintFromRaw(parsePublicKey(person.public)!.raw);
const actor: SshActor = { kind: "user", userId: "u1", sshKeyId: "k1", publicKey: person.public };

const app = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as FastifyInstance;
const IP = "172.18.0.1";
const BLOB = Buffer.from("session-identifier-blob");

function attempt(opts: {
  ip?: string;
  username: string;
  key?: ParsedKey;
  signWith?: ParsedKey;
}): Promise<{ result: "accept" | "reject"; bound: BoundActor | null; boundIp?: string }> {
  return new Promise((resolve) => {
    const key = opts.key ?? forwardPriv;
    const signature = opts.signWith ? opts.signWith.sign(BLOB) : undefined;
    if (signature instanceof Error) throw signature;
    let bound: BoundActor | null = null;
    let boundIp: string | undefined;
    const ctx = {
      method: "publickey",
      username: opts.username,
      key: { algo: key.type, data: key.getPublicSSH() },
      blob: opts.signWith ? BLOB : undefined,
      signature,
      hashAlgo: undefined,
      accept: () => resolve({ result: "accept", bound, boundIp }),
      reject: () => resolve({ result: "reject", bound, boundIp }),
    } as unknown as AuthContext;
    onAuthentication(app, ctx, opts.ip ?? IP, (a, ip) => {
      bound = a;
      boundIp = ip;
    });
  });
}

beforeEach(() => {
  resetAuthFailures(IP);
  vi.clearAllMocks();
  vi.mocked(resolveActorByFingerprint).mockResolvedValue(actor);
  process.env["FORGEHUB_SSH_FORWARD_KEY"] = forward.public;
});
afterEach(() => {
  delete process.env["FORGEHUB_SSH_FORWARD_KEY"];
  delete process.env["FORGEHUB_SSH_FORWARD_KEY_FILE"];
});

describe("forward usernames", () => {
  it("round-trips a fingerprint and client ip", () => {
    expect(decodeForwardUser(encodeForwardUser(personFp, "203.0.113.9"))).toEqual({ fingerprint: personFp, ip: "203.0.113.9" });
    expect(decodeForwardUser(encodeForwardUser(personFp))).toEqual({ fingerprint: personFp, ip: null });
  });

  it("rejects anything that is not a well-formed forward username", () => {
    expect(decodeForwardUser("git")).toBeNull();
    expect(decodeForwardUser("fwd.")).toBeNull();
    expect(decodeForwardUser("fwd.AAAA.BBBB")).toBeNull();
    expect(decodeForwardUser(`fwd.${Buffer.from("not-a-fingerprint").toString("base64url")}.`)).toBeNull();
  });

  it("drops a client ip that is not an address", () => {
    expect(decodeForwardUser(encodeForwardUser(personFp, "<script>"))?.ip).toBeNull();
  });
});

describe("forward keys config", () => {
  it("is empty (forwarding off) when unset", () => {
    delete process.env["FORGEHUB_SSH_FORWARD_KEY"];
    expect(forwardKeys()).toEqual([]);
  });

  it("reads several keys and skips junk lines", () => {
    const keys = forwardKeys({ FORGEHUB_SSH_FORWARD_KEY: `${forward.public}\nnot a key\n${stranger.public}` });
    expect(keys).toHaveLength(2);
    expect(isForwardKey(parsePublicKey(stranger.public)!.raw, keys)).toBe(true);
    expect(isForwardKey(parsePublicKey(person.public)!.raw, keys)).toBe(false);
  });
});

describe("forwarded authentication", () => {
  it("accepts the forward key acting for a registered key, with the client ip", async () => {
    const r = await attempt({ username: encodeForwardUser(personFp, "203.0.113.9"), signWith: forwardPriv });
    expect(r.result).toBe("accept");
    expect(r.bound).toEqual(actor);
    expect(r.boundIp).toBe("203.0.113.9");
    expect(resolveActorByFingerprint).toHaveBeenCalledWith(personFp);
  });

  it("accepts the key lookup user", async () => {
    const r = await attempt({ username: KEYS_USER, signWith: forwardPriv });
    expect(r.result).toBe("accept");
    expect(r.bound).toEqual({ kind: "keylookup" });
  });

  it("refuses a key that is not the forward key, even for a registered fingerprint", async () => {
    const r = await attempt({ username: encodeForwardUser(personFp), key: strangerPriv, signWith: strangerPriv });
    expect(r.result).toBe("reject");
    expect(r.bound).toBeNull();
  });

  it("refuses the person's OWN key under a forward username (it only proves who they are, not that the host is calling)", async () => {
    const r = await attempt({ username: encodeForwardUser(personFp), key: mustParse(person.private), signWith: mustParse(person.private) });
    expect(r.result).toBe("reject");
  });

  it("refuses a forged signature under the forward key's public half", async () => {
    const r = await attempt({ username: KEYS_USER, key: forwardPriv, signWith: strangerPriv });
    expect(r.result).toBe("reject");
  });

  it("refuses to act for a key that is not registered", async () => {
    vi.mocked(resolveActorByFingerprint).mockResolvedValue(null);
    const r = await attempt({ username: encodeForwardUser(personFp), signWith: forwardPriv });
    expect(r.result).toBe("reject");
  });

  it("does nothing special when no forward key is configured", async () => {
    delete process.env["FORGEHUB_SSH_FORWARD_KEY"];
    // The forward key is not a registered key, so ordinary auth turns it away.
    vi.mocked(resolveActorByFingerprint).mockResolvedValue(null);
    const r = await attempt({ username: KEYS_USER, signWith: forwardPriv });
    expect(r.result).toBe("reject");
  });
});

describe("forwarded auth only from private addresses", () => {
  it("classifies addresses", () => {
    for (const ok of ["127.0.0.1", "::1", "10.1.2.3", "172.18.0.1", "172.31.255.1", "192.168.1.5", "::ffff:172.18.0.1", "fd00::1"]) {
      expect(isPrivateAddress(ok), ok).toBe(true);
    }
    for (const bad of ["203.0.113.9", "8.8.8.8", "172.32.0.1", "172.15.0.1", "2001:db8::1", "999.1.1.1", "unknown", ""]) {
      expect(isPrivateAddress(bad), bad).toBe(false);
    }
  });

  it("refuses the forward key from a public address, even a correctly signed one", async () => {
    const r = await attempt({ ip: "203.0.113.9", username: encodeForwardUser(personFp), signWith: forwardPriv });
    expect(r.result).toBe("reject");
    expect(r.bound).toBeNull();
    expect(resolveActorByFingerprint).not.toHaveBeenCalled();
  });

  it("throttles repeated public-address attempts", async () => {
    const ip = "203.0.113.50";
    resetAuthFailures(ip);
    for (let i = 0; i < 5; i++) await attempt({ ip, username: KEYS_USER, signWith: forwardPriv });
    expect(isRateLimited(ip)).toBe(true);
    resetAuthFailures(ip);
  });
});
