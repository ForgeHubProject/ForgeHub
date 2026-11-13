import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { sshHostKeyPath } from "../git-storage.js";
import { registrationMode } from "../registration.js";
import { sshClientConfig } from "../ssh/config.js";
import { fingerprintFromRaw, parsePublicKey } from "../ssh/keys.js";

/**
 * GET /server/info — public endpoint (no auth).
 *
 * Returns the server's SSH configuration so the web client can:
 *   1. Decide whether to show the SSH clone tab.
 *   2. Display the host-key fingerprint so users can verify their known_hosts
 *      entry without blindly accepting an unknown key (issue #154).
 *
 * Fingerprints are SHA256, in the "SHA256:…" format ssh-keygen -lf produces:
 * of the key a client actually meets on the advertised port (see
 * clientFingerprints).
 */

/** Read the persisted SSH host public key and return its fingerprint, or null. */
async function readHostKeyFingerprint(): Promise<string | null> {
  const pubPath = `${sshHostKeyPath()}.pub`;
  try {
    const pubKeyLine = (await readFile(pubPath, "utf8")).trim();
    const parsed = parsePublicKey(pubKeyLine);
    if (!parsed) return null;
    return fingerprintFromRaw(parsed.raw);
  } catch {
    // Host key not yet generated (SSH never started) or unreadable — that's fine.
    return null;
  }
}

export type HostFingerprint = { type: string | null; fingerprint: string };

/**
 * `FORGEHUB_SSH_HOST_FINGERPRINTS`: the host keys of whatever answers on the
 * public port when it isn't ForgeHub — the host's sshd on 22, forwarding to
 * ForgeHub (deploy/ssh/install.sh prints the value). Entries are
 * "TYPE SHA256:…" or bare "SHA256:…", separated by commas or new lines.
 */
export function parseHostFingerprints(raw: string | undefined): HostFingerprint[] {
  return (raw ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim().split(/\s+/))
    .flatMap((words) => {
      const fingerprint = words.find((w) => /^SHA256:[A-Za-z0-9+/=]+$/.test(w));
      if (!fingerprint) return [];
      const type = words.find((w) => w !== fingerprint) ?? null;
      return [{ type: type ? type.replace(/[()]/g, "").toUpperCase() : null, fingerprint }];
    });
}

/**
 * The fingerprints a client sees when it connects. ForgeHub's own host key
 * only when clients reach ForgeHub's listener; behind a forwarding sshd it's
 * that sshd's keys, from the environment — and none rather than a wrong one.
 */
export async function clientFingerprints(env: NodeJS.ProcessEnv = process.env): Promise<HostFingerprint[]> {
  const config = sshClientConfig(env);
  if (!config.sshEnabled) return [];
  const forwarded = config.sshPort !== Number(env["FORGEHUB_SSH_PORT"]);
  if (forwarded) return parseHostFingerprints(env["FORGEHUB_SSH_HOST_FINGERPRINTS"]);
  const own = await readHostKeyFingerprint();
  return own ? [{ type: "ED25519", fingerprint: own }] : [];
}

export async function serverInfoRoutes(app: FastifyInstance) {
  app.get("/server/info", async () => {
    const config = sshClientConfig();
    const sshFingerprints = await clientFingerprints();
    // sshFingerprint: the first one, for clients that read a single value.
    return { ...config, sshFingerprint: sshFingerprints[0]?.fingerprint ?? null, sshFingerprints, registration: registrationMode() };
  });
}
