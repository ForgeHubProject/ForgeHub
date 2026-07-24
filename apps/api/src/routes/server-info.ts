import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { sshHostKeyPath } from "../git-storage.js";
import { fingerprintFromRaw, parsePublicKey } from "../ssh/keys.js";

/**
 * GET /server/info — public endpoint (no auth).
 *
 * Returns the server's SSH configuration so the web client can:
 *   1. Decide whether to show the SSH clone tab.
 *   2. Display the host-key fingerprint so users can verify their known_hosts
 *      entry without blindly accepting an unknown key (issue #154).
 *
 * The fingerprint is the SHA256 fingerprint of the ed25519 host public key,
 * in the same "SHA256:…" format ssh-keygen -lf produces.
 */

function sshConfig(): { sshEnabled: boolean; sshPort: number | null; sshHost: string | null } {
  const portRaw = process.env["FORGEHUB_SSH_PORT"];
  if (!portRaw || !portRaw.trim()) return { sshEnabled: false, sshPort: null, sshHost: null };
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { sshEnabled: false, sshPort: null, sshHost: null };
  }
  return {
    sshEnabled: true,
    sshPort: port,
    sshHost: process.env["FORGEHUB_SSH_HOST"]?.trim() || null,
  };
}

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

export async function serverInfoRoutes(app: FastifyInstance) {
  app.get("/server/info", async () => {
    const config = sshConfig();
    const sshFingerprint = config.sshEnabled ? await readHostKeyFingerprint() : null;
    return { ...config, sshFingerprint };
  });
}
