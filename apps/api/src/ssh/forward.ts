import { readFileSync } from "node:fs";
import { parsePublicKey, type ParsedPublicKey } from "./keys.js";

/**
 * Forwarded SSH: serving git on the standard port 22 while the host's own sshd
 * keeps it for administration.
 *
 * The host's sshd takes the `git` user's connections on port 22, authenticates
 * them with an `AuthorizedKeysCommand`, and hands each git command to a forced
 * command that opens a second SSH connection to ForgeHub's built-in server
 * (loopback only). That second connection authenticates with a *forward key* —
 * a keypair that exists only on the host — and names the person it is acting for
 * in its username. So the host's sshd proves WHO the person is (they signed in
 * with their registered key) and ForgeHub still decides WHAT they may do, with
 * the same access checks as every other transport.
 *
 * Trust: whoever holds a forward key can act as any registered key by name.
 * The private half therefore lives on the host, readable only by the `git` user
 * the forced command runs as, and the published SSH port must be loopback-only.
 * With no forward key configured, none of this is reachable.
 *
 * Usernames:
 *   `_keys`                          key lookup for AuthorizedKeysCommand
 *   `fwd.<fingerprint>.<client ip>`  act as the registered key with that
 *                                    fingerprint; both fields base64url, the ip
 *                                    may be empty
 */

/** Username of the key-lookup session. */
export const KEYS_USER = "_keys";
const FORWARD_PREFIX = "fwd.";

/** The command a key-lookup session may run: print the registered key for a fingerprint. */
export const KEY_LOOKUP_COMMAND = "forgehub-authorized-key";

const b64u = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

export function encodeForwardUser(fingerprint: string, clientIp = ""): string {
  return `${FORWARD_PREFIX}${b64u(fingerprint)}.${b64u(clientIp)}`;
}

export type ForwardUser = { fingerprint: string; ip: string | null };

/** Parse a `fwd.` username; null when it is not one or is malformed. */
export function decodeForwardUser(username: string): ForwardUser | null {
  if (!username.startsWith(FORWARD_PREFIX)) return null;
  const parts = username.slice(FORWARD_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const fingerprint = unb64u(parts[0]);
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) return null;
  const ip = unb64u(parts[1]);
  // The ip is only ever stored as `lastUsedIp`; bound it so it cannot be abused as a blob store.
  return { fingerprint, ip: /^[0-9a-fA-F:.]{1,45}$/.test(ip) ? ip : null };
}

/**
 * The configured forward keys: FORGEHUB_SSH_FORWARD_KEY (inline, one key per line)
 * and/or FORGEHUB_SSH_FORWARD_KEY_FILE (a file of the same). Empty ⇒ forwarding off.
 */
export function forwardKeys(env: NodeJS.ProcessEnv = process.env): ParsedPublicKey[] {
  const lines: string[] = [];
  const inline = env["FORGEHUB_SSH_FORWARD_KEY"];
  if (inline) lines.push(...inline.split(/\r?\n/));
  const file = env["FORGEHUB_SSH_FORWARD_KEY_FILE"]?.trim();
  if (file) {
    try {
      lines.push(...readFileSync(file, "utf8").split(/\r?\n/));
    } catch {
      /* unreadable ⇒ no keys from it; forwarding stays off unless inline keys exist */
    }
  }
  const keys: ParsedPublicKey[] = [];
  for (const line of lines) {
    const parsed = parsePublicKey(line);
    if (parsed) keys.push(parsed);
  }
  return keys;
}

/** Is `raw` (the presented key blob) one of the configured forward keys? */
export function isForwardKey(raw: Buffer, keys: ParsedPublicKey[] = forwardKeys()): boolean {
  return keys.some((k) => k.raw.equals(raw));
}
