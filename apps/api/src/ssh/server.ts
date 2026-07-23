import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import ssh2 from "ssh2";
import type { AuthContext, ServerChannel, Session } from "ssh2";
import { bareRepoPathFromKey, sshHostKeyPath } from "../git-storage.js";
import { prisma } from "../prisma.js";
import { preparePushProtection, runPostReceiveEffects, snapshotHeadShas } from "../git-push-shared.js";
import { fingerprintFromRaw } from "./keys.js";
import { resolveActorByFingerprint, touchSshKey, type SshActor } from "./store.js";

const { Server, utils: sshUtils } = ssh2;

/**
 * SSH git transport (issue #116).
 *
 * A Node ssh2 server that authenticates by matching the presented public key's
 * SHA256 fingerprint to an SSHKey (→ acting user) or a DeployKey (→ repo-scoped
 * actor), then invokes `git upload-pack` / `git receive-pack` on the bare repo —
 * reusing the SAME access checks and post-receive ingestion as smart-HTTP
 * (`routes/git-http.ts` + `git-push-shared.ts`). Hard-off unless FORGEHUB_SSH_PORT
 * is set (mirroring how CI gates on FORGEHUB_CI). Only `publickey` auth and only
 * the two git exec commands are accepted — no shell, no pty, no port forwarding.
 */

type GitService = "git-upload-pack" | "git-receive-pack";

type ParsedGitCommand = { service: GitService; ownerHandle: string; repoName: string };

type AccessRepo = {
  id: string;
  ownerId: string;
  visibility: "PUBLIC" | "PRIVATE";
  storageKey: string | null;
  collaborators: Array<{ userId: string; role: "READER" | "WRITER" }>;
};

// ─── command parsing ──────────────────────────────────────────────────────────

/**
 * Parse `git-upload-pack '<path>'` / `git-receive-pack '<path>'` into a service +
 * owner/repo. Tolerates single/double quotes around the path, a missing leading
 * slash, and an optional `.git` suffix. Returns null for anything else — the exec
 * channel accepts ONLY these two commands.
 */
export function parseGitCommand(command: string): ParsedGitCommand | null {
  const trimmed = command.trim();
  const m = /^(git-upload-pack|git-receive-pack)\s+(.+)$/.exec(trimmed);
  if (!m) return null;
  const service = m[1] as GitService;

  let arg = m[2].trim();
  if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) {
    arg = arg.slice(1, -1);
  }
  arg = arg.trim().replace(/^\/+/, "").replace(/\.git$/i, "");
  const segments = arg.split("/").filter(Boolean);
  if (segments.length !== 2) return null;

  return { service, ownerHandle: segments[0].toLowerCase(), repoName: segments[1].toLowerCase() };
}

// ─── access decisions (mirror git-http.ts) ────────────────────────────────────

function userCanRead(repo: AccessRepo, userId: string): boolean {
  if (repo.visibility === "PUBLIC") return true;
  if (userId === repo.ownerId) return true;
  return repo.collaborators.some((c) => c.userId === userId);
}

function userCanWrite(repo: AccessRepo, userId: string): boolean {
  if (userId === repo.ownerId) return true;
  return repo.collaborators.some((c) => c.userId === userId && c.role === "WRITER");
}

export type AccessDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Decide whether `actor` may run `service` against `repo`. User SSH keys use the
 * exact HTTP checks (public read; owner/writer for the rest). A deploy key is
 * bound to its own repo — cross-repo use is refused — grants read there always,
 * and grants write only when it is NOT read-only and the service is receive-pack.
 */
export function decideAccess(actor: SshActor, repo: AccessRepo, service: GitService): AccessDecision {
  const wantsWrite = service === "git-receive-pack";

  if (actor.kind === "user") {
    if (wantsWrite) {
      return userCanWrite(repo, actor.userId) ? { allowed: true } : { allowed: false, reason: "Write access denied" };
    }
    return userCanRead(repo, actor.userId) ? { allowed: true } : { allowed: false, reason: "Repository not found" };
  }

  // Deploy key: repo-scoped credential.
  if (actor.repoId !== repo.id) {
    return { allowed: false, reason: "This deploy key is not authorized for this repository" };
  }
  if (wantsWrite && actor.readOnly) {
    return { allowed: false, reason: "This deploy key is read-only" };
  }
  return { allowed: true };
}

// ─── host key ─────────────────────────────────────────────────────────────────

/** Load the persisted host key, generating an ed25519 one on first start. */
async function loadOrCreateHostKey(app: FastifyInstance): Promise<string> {
  const keyPath = sshHostKeyPath();
  try {
    return await readFile(keyPath, "utf8");
  } catch {
    const pair = sshUtils.generateKeyPairSync("ed25519");
    await mkdir(path.dirname(keyPath), { recursive: true });
    await writeFile(keyPath, pair.private, { mode: 0o600 });
    await writeFile(`${keyPath}.pub`, pair.public, { mode: 0o644 });
    app.log.info(`Generated SSH host key at ${keyPath}`);
    return pair.private;
  }
}

// ─── exec handling ────────────────────────────────────────────────────────────

/** End the channel with a stderr message and a non-zero exit status. */
function fail(stream: ServerChannel, message: string, code = 128): void {
  try {
    stream.stderr.write(`ForgeHub: ${message}\n`);
    stream.exit(code);
    stream.end();
  } catch {
    /* channel already gone */
  }
}

async function handleExec(
  app: FastifyInstance,
  actor: SshActor,
  command: string,
  stream: ServerChannel,
): Promise<void> {
  const parsed = parseGitCommand(command);
  if (!parsed) {
    fail(stream, "only 'git-upload-pack' and 'git-receive-pack' are supported over SSH");
    return;
  }

  const repo = (await prisma.repo.findFirst({
    where: { name: parsed.repoName, owner: { handle: parsed.ownerHandle } },
    include: { collaborators: { select: { userId: true, role: true } } },
  })) as AccessRepo | null;

  if (!repo || !repo.storageKey) {
    fail(stream, "repository not found");
    return;
  }

  const decision = decideAccess(actor, repo, parsed.service);
  if (!decision.allowed) {
    fail(stream, decision.reason);
    return;
  }

  const storageKey = repo.storageKey;
  const repoPath = bareRepoPathFromKey(storageKey);
  // A deploy-key push has no user; attribute its downstream events to the repo
  // owner (who authorized the deploy key), so webhooks/CI still fire with a sender.
  const actorUserId = actor.kind === "user" ? actor.userId : repo.ownerId;

  if (parsed.service === "git-receive-pack") {
    await preparePushProtection(app, repo.id, storageKey, repoPath);
  }
  const shasBefore = parsed.service === "git-receive-pack" ? await snapshotHeadShas(repoPath) : null;

  // Spawn the real git server command against the bare repo. NOTE: we deliberately
  // do NOT set FORGEHUB_INTERNAL_PUSH, so receive-pack hits the pre-receive
  // branch-protection hook exactly like an HTTP push.
  const subcommand = parsed.service.replace("git-", ""); // "upload-pack" | "receive-pack"
  const child = spawn("git", [subcommand, repoPath], { stdio: ["pipe", "pipe", "pipe"] });

  // Pipe channel <-> git stdio. end:false on the outbound pipes so we can send the
  // exit-status BEFORE closing the channel (git clients read the exit code).
  stream.pipe(child.stdin);
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream.stderr, { end: false });

  const killChild = () => {
    if (!child.killed) child.kill();
  };
  stream.on("close", killChild);
  stream.on("error", killChild);

  child.on("error", (err) => {
    app.log.error({ err }, "ssh: failed to spawn git");
    fail(stream, "internal error", 1);
  });

  child.on("close", (code) => {
    if (parsed.service === "git-receive-pack" && shasBefore) {
      void runPostReceiveEffects(app, { id: repo.id, storageKey }, actorUserId, repoPath, shasBefore);
    }
    if (actor.kind === "user") touchSshKey(actor.sshKeyId);
    try {
      stream.exit(code ?? 0);
      stream.end();
    } catch {
      /* channel already gone */
    }
  });
}

// ─── connection wiring ────────────────────────────────────────────────────────

function onSession(app: FastifyInstance, actor: SshActor, accept: () => Session): void {
  const session = accept();
  session.on("exec", (execAccept, execReject, info) => {
    const stream = execAccept();
    void handleExec(app, actor, info.command, stream).catch((err) => {
      app.log.error({ err }, "ssh exec handler crashed");
      fail(stream, "internal error", 1);
    });
  });
  // Interactive shells, ptys, and subsystems (sftp/scp) are not offered.
  session.on("shell", (_accept, reject) => reject());
  session.on("pty", (_accept, reject) => reject());
  session.on("subsystem", (_accept, reject) => reject());
}

function onAuthentication(app: FastifyInstance, ctx: AuthContext, bind: (actor: SshActor) => void): void {
  if (ctx.method !== "publickey") {
    ctx.reject(["publickey"]);
    return;
  }

  void (async () => {
    const fingerprint = fingerprintFromRaw(ctx.key.data);
    const actor = await resolveActorByFingerprint(fingerprint);
    if (!actor) {
      ctx.reject();
      return;
    }

    // Signature present → verify it against the stored public key. Absent → this is
    // the client's "is this key acceptable?" probe; accept so it sends a signature.
    if (ctx.signature) {
      const pub = sshUtils.parseKey(actor.publicKey);
      if (pub instanceof Error) {
        app.log.error({ err: pub, fingerprint }, "ssh: stored public key failed to parse");
        ctx.reject();
        return;
      }
      const ok = ctx.blob ? pub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) : false;
      if (ok !== true) {
        ctx.reject();
        return;
      }
    }

    bind(actor);
    ctx.accept();
  })().catch((err) => {
    app.log.error({ err }, "ssh authentication error");
    ctx.reject();
  });
}

export type SshServerHandle = { port: number; close: () => Promise<void> };

/**
 * Start the SSH git transport when FORGEHUB_SSH_PORT is set; otherwise a no-op
 * (returns null). Safe to call from buildServer — it is hard-off by default.
 */
export async function startSshServer(app: FastifyInstance): Promise<SshServerHandle | null> {
  const portRaw = process.env["FORGEHUB_SSH_PORT"];
  if (!portRaw || !portRaw.trim()) return null;

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    app.log.warn(`Invalid FORGEHUB_SSH_PORT=${portRaw}; SSH transport disabled`);
    return null;
  }

  const hostKey = await loadOrCreateHostKey(app);

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    // Per-connection resolved actor, set on successful auth and read at exec time.
    let actor: SshActor | null = null;
    client.on("authentication", (ctx) => onAuthentication(app, ctx, (a) => { actor = a; }));
    client.on("session", (accept) => {
      if (!actor) return; // ssh2 only emits `session` after `ready`, but guard anyway.
      onSession(app, actor, accept);
    });
    client.on("error", (err) => {
      // Client-side disconnects are noisy and expected; log at debug level.
      app.log.debug({ err }, "ssh client error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.on("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  app.log.info(`SSH git transport listening on port ${port}`);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
