import ssh2 from "ssh2";

/**
 * ed25519 key generation that works around a bug in ssh2 (1.17.0).
 *
 * ssh2.utils.generateKeyPairSync("ed25519") converts node's DER output to
 * OpenSSH form, and strips "leading zero bytes" from the public key's BIT STRING
 * — meaning the one unused-bits byte, but it strips every leading zero. When the
 * 32-byte public key itself begins with 0x00 (1 draw in 256) that byte goes too,
 * and so does every zero byte after it (two in a row: 1 draw in 65,536): the key
 * is written with a public half shorter than 32 bytes, and ssh2's own parser
 * rejects it with "Malformed OpenSSH private key". Measured: 70 of 20,000 pairs.
 *
 * For the SSH host key that is not a flaky test but a broken install: the key is
 * persisted on first start and read back on every start after, so a bad draw
 * stops the API from starting, every time. Redrawing costs microseconds.
 */

const { utils: sshUtils } = ssh2;

export type SshKeyPair = { private: string; public: string };

/** An ed25519 pair that ssh2 can parse back, both halves. */
export function generateEd25519KeyPair(): SshKeyPair {
  for (let attempt = 0; attempt < 8; attempt++) {
    const pair = sshUtils.generateKeyPairSync("ed25519");
    if (!(sshUtils.parseKey(pair.private) instanceof Error) && !(sshUtils.parseKey(pair.public) instanceof Error)) {
      return pair;
    }
  }
  // Eight bad draws in a row is ~1 in 10^19: the generator is broken outright.
  throw new Error("ssh2 produced no parsable ed25519 key pair in 8 attempts");
}

/**
 * True when `pem` is an unencrypted OpenSSH ed25519 private key whose public
 * half is shorter than 32 bytes — the shape ssh2's bug writes, one byte short
 * per leading zero it dropped. Anything else (another key type, an encrypted
 * key, junk) is false: such a key was put there by someone, and is theirs to fix.
 */
export function isTruncatedEd25519Key(pem: string): boolean {
  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(pem);
  if (!match) return false;
  const buf = Buffer.from(match[1].replace(/\s+/g, ""), "base64");

  const magic = Buffer.from("openssh-key-v1\0");
  if (buf.length < magic.length || !buf.subarray(0, magic.length).equals(magic)) return false;
  let pos = magic.length;

  const readString = (from: Buffer): Buffer | null => {
    if (pos + 4 > from.length) return null;
    const len = from.readUInt32BE(pos);
    if (pos + 4 + len > from.length) return null;
    const out = from.subarray(pos + 4, pos + 4 + len);
    pos += 4 + len;
    return out;
  };

  const cipher = readString(buf);
  if (cipher?.toString() !== "none") return false;
  if (!readString(buf) || !readString(buf)) return false; // kdf name, kdf options
  if (pos + 4 > buf.length || buf.readUInt32BE(pos) !== 1) return false; // one key
  pos += 4;

  const blob = readString(buf);
  if (!blob) return false;
  pos = 0;
  const type = readString(blob);
  const pub = readString(blob);
  return type?.toString() === "ssh-ed25519" && pub !== null && pub.length > 0 && pub.length < 32;
}
