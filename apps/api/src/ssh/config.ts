/**
 * What clients are told about the SSH transport. One definition for /server/info
 * and the repo payload, so the web app never sees two answers.
 *
 * `FORGEHUB_SSH_PORT` is where ForgeHub LISTENS (unset ⇒ SSH off).
 * `FORGEHUB_SSH_PUBLIC_PORT` is what clients are TOLD to connect to, for when
 * something else owns the public port and forwards to the listener — the host's
 * sshd on 22, see ssh/forward.ts. Unset ⇒ the listening port.
 */
export type SshClientConfig = { sshEnabled: boolean; sshPort: number | null; sshHost: string | null };

function validPort(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function sshClientConfig(env: NodeJS.ProcessEnv = process.env): SshClientConfig {
  const listen = validPort(env["FORGEHUB_SSH_PORT"]);
  if (listen === null) return { sshEnabled: false, sshPort: null, sshHost: null };
  return {
    sshEnabled: true,
    sshPort: validPort(env["FORGEHUB_SSH_PUBLIC_PORT"]) ?? listen,
    sshHost: env["FORGEHUB_SSH_HOST"]?.trim() || null,
  };
}
