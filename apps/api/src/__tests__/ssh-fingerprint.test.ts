import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import ssh2 from "ssh2";
import { computeFingerprint, fingerprintFromRaw, parsePublicKey } from "../ssh/keys.js";

// A stable ed25519 fixture with its independently-computed SHA256 fingerprint.
const ED_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINF3319jjgEjhpwtrz3oEC7Q5v9ny/ubnpRxPF3Xt/1F";
const ED_FP = "SHA256:VCLjt8aUSHPMAP7Q67RG8wteqLWaiuYHoU5DqJUxXd8";

describe("parsePublicKey", () => {
  it("parses a valid ed25519 line into type/raw/comment/normalized", () => {
    const parsed = parsePublicKey(`${ED_LINE} alice@laptop`);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("ssh-ed25519");
    expect(parsed!.comment).toBe("alice@laptop");
    // normalized drops the comment but keeps type + canonical base64
    expect(parsed!.normalized).toBe(ED_LINE);
  });

  it("accepts a key with no comment", () => {
    const parsed = parsePublicKey(ED_LINE);
    expect(parsed).not.toBeNull();
    expect(parsed!.comment).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(parsePublicKey(`  ${ED_LINE}\n`)).not.toBeNull();
  });

  it("rejects an unknown key type", () => {
    expect(parsePublicKey("ssh-magic AAAAC3NzaC1lZDI1NTE5AAAAINF3")).toBeNull();
  });

  it("rejects a line whose blob type does not match the leading token", () => {
    // ED_LINE's blob self-describes as ssh-ed25519; claim ssh-rsa instead.
    const b64 = ED_LINE.split(/\s+/)[1];
    expect(parsePublicKey(`ssh-rsa ${b64}`)).toBeNull();
  });

  it("rejects non-base64 payloads", () => {
    expect(parsePublicKey("ssh-ed25519 not-base64-!@#$")).toBeNull();
  });

  it("rejects a bare type with no key data", () => {
    expect(parsePublicKey("ssh-ed25519")).toBeNull();
  });

  it("rejects empty / non-string input", () => {
    expect(parsePublicKey("")).toBeNull();
    expect(parsePublicKey("   ")).toBeNull();
    expect(parsePublicKey(undefined)).toBeNull();
    expect(parsePublicKey(42)).toBeNull();
  });

  it("parses freshly generated ed25519 and rsa keys", () => {
    expect(parsePublicKey(ssh2.utils.generateKeyPairSync("ed25519").public)).not.toBeNull();
    expect(parsePublicKey(ssh2.utils.generateKeyPairSync("rsa", { bits: 2048 }).public)).not.toBeNull();
  });
});

describe("fingerprint", () => {
  it("matches the ssh-keygen -lf SHA256 format for the fixture", () => {
    expect(computeFingerprint(ED_LINE)).toBe(ED_FP);
  });

  it("ignores the comment (fingerprint is over key bytes only)", () => {
    expect(computeFingerprint(`${ED_LINE} someone@host`)).toBe(ED_FP);
    expect(computeFingerprint(`${ED_LINE} other@host`)).toBe(ED_FP);
  });

  it("fingerprintFromRaw is SHA256: + unpadded base64(sha256(raw))", () => {
    const raw = Buffer.from(ED_LINE.split(/\s+/)[1], "base64");
    const expected = "SHA256:" + createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
    expect(fingerprintFromRaw(raw)).toBe(expected);
    expect(fingerprintFromRaw(raw)).not.toMatch(/=$/); // never padded
  });

  it("returns null for unparseable input", () => {
    expect(computeFingerprint("garbage")).toBeNull();
  });

  it("gives distinct fingerprints for distinct keys", () => {
    const a = ssh2.utils.generateKeyPairSync("ed25519").public;
    const b = ssh2.utils.generateKeyPairSync("ed25519").public;
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b));
  });
});
