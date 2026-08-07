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
import { resolveActorByFingerprint, touchSshKey, touchDeployKey, type SshActor } from "./store.js";

const { Server, utils: sshUtils } = ssh2;

// ─── auth rate-limiter (issue #154) ──────────────────────────────────────────
//
// Tracks failed publickey authentication attempts per source IP. After
// MAX_FAILURES failures within WINDOW_MS, further auth requests from that IP
// are rejected immediately for the remainder of the window. In-memory only —
// resets on restart — which is intentional: DoS/stuffing attacks are typically
// short-lived bursts; a persistent store would add complexity with little benefit
// at this scale.

const MAX_FAILURES = 5;
const WINDOW_MS = 60_000; // 1 minute

type FailRecord = { count: number; windowStart: number };
const failMap = new Map<string, FailRecord>();

/** Returns true if the IP is currently rate-limited (too many recent failures). */
export function isRateLimited(ip: string): boolean {
  const rec = failMap.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.windowStart > WINDOW_MS) {
    failMap.delete(ip);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}

/** Record one failed auth attempt for an IP. */
export function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const rec = failMap.get(ip);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    failMap.set(ip, { count: 1, windowStart: now });
  } else {
    rec.count += 1;
  }
}

/** Reset the failure record for an IP on successful auth (avoid penalising legit retries). */
export function resetAuthFailures(ip: string): void {
  failMap.delete(ip);
}

/**
 * Remove all expired failure records. Called periodically by startSshServer.
 *
 * `isRateLimited` already drops an expired record when it reads one, but that only
 * fires for an IP that comes back. An IP that fails five times and is never seen
 * again keeps its entry forever, so a scan across many source addresses grows
 * `failMap` without bound. This is the only thing that reclaims those.
 */
export function sweepExpiredFailures(): void {
  const now = Date.now();
  for (const [ip, rec] of failMap) {
    if (now - rec.windowStart > WINDOW_MS) {
      failMap.delete(ip);
    }
  }
}

/**
 * How many IPs `failMap` is currently holding. Test seam — nothing in the server
 * reads it.
 *
 * The sweep is invisible through `isRateLimited`: that function lazily deletes an
 * expired record as it reads it, so it answers `false` for an expired IP whether or
 * not the sweep ever ran. A test written against it passes with the sweep gutted to
 * a no-op (verified). Retention is only observable as a count.
 */
export function failureRecordCount(): number {
  return failMap.size;
}

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
  ip: string,
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
    if (actor.kind === "user") touchSshKey(actor.sshKeyId, ip);
    else touchDeployKey(actor.deployKeyId, ip);
    try {
      stream.exit(code ?? 0);
      stream.end();
    } catch {
      /* channel already gone */
    }
  });
}

// ─── connection wiring ────────────────────────────────────────────────────────

function onSession(app: FastifyInstance, actor: SshActor, ip: string, accept: () => Session): void {
  const session = accept();
  session.on("exec", (execAccept, execReject, info) => {
    const stream = execAccept();
    void handleExec(app, actor, info.command, stream, ip).catch((err) => {
      app.log.error({ err }, "ssh exec handler crashed");
      fail(stream, "internal error", 1);
    });
  });
  // Interactive shells, ptys, and subsystems (sftp/scp) are not offered.
  session.on("shell", (_accept, reject) => reject());
  session.on("pty", (_accept, reject) => reject());
  session.on("subsystem", (_accept, reject) => reject());
}

function onAuthentication(
  app: FastifyInstance,
  ctx: AuthContext,
  ip: string,
  bind: (actor: SshActor) => void,
): void {
  if (ctx.method !== "publickey") {
    ctx.reject(["publickey"]);
    return;
  }

  if (isRateLimited(ip)) {
    app.log.warn({ ip }, "ssh: auth rejected — rate limit exceeded");
    ctx.reject();
    return;
  }

  void (async () => {
    const fingerprint = fingerprintFromRaw(ctx.key.data);
    const actor = await resolveActorByFingerprint(fingerprint);
    if (!actor) {
      recordAuthFailure(ip);
      app.log.warn({ fingerprint, ip }, "ssh: auth failed — unknown fingerprint");
      ctx.reject();
      return;
    }

    // Signature present → verify it against the stored public key. Absent → this is
    // the client's "is this key acceptable?" probe; accept so it sends a signature.
    if (ctx.signature) {
      const pub = sshUtils.parseKey(actor.publicKey);
      if (pub instanceof Error) {
        app.log.error({ err: pub, fingerprint }, "ssh: stored public key failed to parse");
        recordAuthFailure(ip);
        ctx.reject();
        return;
      }
      const ok = ctx.blob ? pub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) : false;
      if (ok !== true) {
        recordAuthFailure(ip);
        app.log.warn({ fingerprint, ip }, "ssh: auth failed — signature verification failed");
        ctx.reject();
        return;
      }
      // Completed auth with verified signature.
      const actorInfo =
        actor.kind === "user"
          ? { kind: "user", userId: actor.userId, sshKeyId: actor.sshKeyId }
          : { kind: "deploy", deployKeyId: actor.deployKeyId, repoId: actor.repoId };
      app.log.info({ fingerprint, ip, actor: actorInfo }, "ssh: auth succeeded");
    }

    resetAuthFailures(ip);
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

  const sweep = setInterval(sweepExpiredFailures, WINDOW_MS);
  sweep.unref();

  const server = new Server({ hostKeys: [hostKey] }, (client, info) => {
    // Per-connection resolved actor, set on successful auth and read at exec time.
    let actor: SshActor | null = null;
    const ip = info.ip ?? "unknown";
    client.on("authentication", (ctx) => onAuthentication(app, ctx, ip, (a) => { actor = a; }));
    client.on("session", (accept) => {
      if (!actor) return; // ssh2 only emits `session` after `ready`, but guard anyway.
      onSession(app, actor, ip, accept);
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
        clearInterval(sweep);
        server.close(() => resolve());
      }),
  };
}
