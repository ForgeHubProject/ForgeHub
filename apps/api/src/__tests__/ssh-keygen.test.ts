import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ssh2 from "ssh2";

// server.ts imports the credential store; the host key needs no DB.
vi.mock("../ssh/store.js", () => ({
  resolveActorByFingerprint: vi.fn(),
  touchSshKey: vi.fn(),
  touchDeployKey: vi.fn(),
}));

import { generateEd25519KeyPair, isTruncatedEd25519Key } from "../ssh/keygen.js";
import { loadOrCreateHostKey } from "../ssh/server.js";

const { utils: sshUtils } = ssh2;

/**
 * A pair as ssh2's buggy generator writes it — drawn for real rather than
 * committed, so the test proves the bug's shape against the library itself. At
 * 1 draw in 256 a broken one turns up within a few hundred; 50,000 misses would
 * mean ssh2 fixed the bug, and the message says so.
 */
function drawTruncatedPair(): { private: string; public: string } {
  for (let i = 0; i < 50_000; i++) {
    const pair = sshUtils.generateKeyPairSync("ed25519");
    if (sshUtils.parseKey(pair.private) instanceof Error) return pair;
  }
  throw new Error("ssh2 no longer truncates ed25519 keys — keygen.ts's workaround can go");
}

const truncated = drawTruncatedPair();

describe("isTruncatedEd25519Key", () => {
  it("recognises the key ssh2's generator truncates", () => {
    expect(isTruncatedEd25519Key(truncated.private)).toBe(true);
  });

  it("recognises one that lost more than one leading zero byte", () => {
    // Two zero bytes in a row is 1 draw in 65,536 — too rare to draw, so built:
    // the header and public blob are all the detector reads.
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n, 0);
      return b;
    };
    const str = (b: Buffer) => Buffer.concat([u32(b.length), b]);
    const key = (pubLen: number) => {
      const blob = Buffer.concat([str(Buffer.from("ssh-ed25519")), str(Buffer.alloc(pubLen, 7))]);
      const body = Buffer.concat([
        Buffer.from("openssh-key-v1\0"), str(Buffer.from("none")), str(Buffer.from("none")), str(Buffer.alloc(0)), u32(1), str(blob),
      ]);
      return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`;
    };
    expect(isTruncatedEd25519Key(key(30))).toBe(true);
    expect(isTruncatedEd25519Key(key(31))).toBe(true);
    expect(isTruncatedEd25519Key(key(32))).toBe(false);
  });

  it("is false for anything else", () => {
    expect(isTruncatedEd25519Key(generateEd25519KeyPair().private)).toBe(false);
    expect(isTruncatedEd25519Key(sshUtils.generateKeyPairSync("rsa", { bits: 2048 }).private)).toBe(false);
    expect(isTruncatedEd25519Key(truncated.public)).toBe(false);
    expect(isTruncatedEd25519Key("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n")).toBe(false);
    expect(isTruncatedEd25519Key("")).toBe(false);
  });
});

describe("generateEd25519KeyPair", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redraws a pair ssh2 cannot parse", () => {
    const good = sshUtils.generateKeyPairSync("ed25519");
    const spy = vi
      .spyOn(sshUtils, "generateKeyPairSync")
      .mockReturnValueOnce(truncated as never)
      .mockReturnValueOnce(good as never);
    expect(generateEd25519KeyPair()).toBe(good);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives up loudly when the generator never produces a usable pair", () => {
    vi.spyOn(sshUtils, "generateKeyPairSync").mockReturnValue(truncated as never);
    expect(() => generateEd25519KeyPair()).toThrow(/no parsable ed25519 key pair/);
  });
});

describe("loadOrCreateHostKey", () => {
  let dir: string;
  let keyPath: string;
  const log = { info: vi.fn(), warn: vi.fn() };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fh-hostkey-"));
    keyPath = join(dir, "host_key");
    log.info.mockClear();
    log.warn.mockClear();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a parsable key and its .pub on first start", async () => {
    const key = await loadOrCreateHostKey(log, keyPath);
    expect(sshUtils.parseKey(key)).not.toBeInstanceOf(Error);
    expect(await readFile(keyPath, "utf8")).toBe(key);
    expect(sshUtils.parseKey(await readFile(`${keyPath}.pub`, "utf8"))).not.toBeInstanceOf(Error);
  });

  it("keeps an existing key", async () => {
    const existing = generateEd25519KeyPair().private;
    await writeFile(keyPath, existing);
    expect(await loadOrCreateHostKey(log, keyPath)).toBe(existing);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("replaces a key an earlier start generated truncated, keeping the old one aside", async () => {
    await writeFile(keyPath, truncated.private);
    const key = await loadOrCreateHostKey(log, keyPath);
    expect(sshUtils.parseKey(key)).not.toBeInstanceOf(Error);
    expect(await readFile(keyPath, "utf8")).toBe(key);
    expect(await readFile(`${keyPath}.unparsable`, "utf8")).toBe(truncated.private);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("truncated"));
  });

  it("leaves any other unparsable key alone — an admin's key is theirs to fix", async () => {
    const junk = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a key\n-----END OPENSSH PRIVATE KEY-----\n";
    await writeFile(keyPath, junk);
    expect(await loadOrCreateHostKey(log, keyPath)).toBe(junk);
    await expect(stat(`${keyPath}.unparsable`)).rejects.toThrow();
  });
});
