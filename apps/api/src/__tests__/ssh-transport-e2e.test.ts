import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import ssh2 from "ssh2";
import { fingerprintFromRaw, parsePublicKey } from "../ssh/keys.js";

const execFile = promisify(execFileCb);
const SSH_PORT = 2252;
const SHIM = fileURLToPath(new URL("./helpers/ssh-shim.mjs", import.meta.url));

// Real bare repos + real git + real ssh2 server. Prisma and the fire-and-forget
// post-receive side effects are mocked so the test needs no database, while the
// full transport path — publickey auth, access decision, receive-pack, and the
// shared ingestion hook — runs for real.

// ── shared state (mock factories are hoisted, so they read from this holder) ───
// vi.hoisted runs before imports; it may only use `vi`. The credential values are
// filled in beforeAll and read LAZILY inside the mock callbacks (which fire during
// the test, after beforeAll), so imported helpers can compute them normally.
const H = vi.hoisted(() => ({
  userFp: "",
  deployFp: "",
  userPub: "",
  deployPub: "",
  USER_ID: "e2e-user",
  REPO_ID: "e2e-repo",
  STORAGE_KEY: "e2e/repo.git",
  ingestSpy: vi.fn().mockResolvedValue(undefined),
}));
const STORAGE_KEY = "e2e/repo.git";
const ingestSpy = H.ingestSpy;

let userPair: { public: string; private: string };
let deployPair: { public: string; private: string };
let strangerPair: { public: string; private: string };

vi.mock("../prisma.js", () => ({
  prisma: {
    sSHKey: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.fingerprint === H.userFp
          ? { id: "user-key-1", userId: H.USER_ID, publicKey: H.userPub }
          : null,
      ),
      update: vi.fn().mockResolvedValue(undefined),
    },
    deployKey: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.fingerprint === H.deployFp
          ? { id: "deploy-key-1", repoId: H.REPO_ID, readOnly: true, publicKey: H.deployPub }
          : null,
      ),
    },
    repo: {
      findFirst: vi.fn(async () => ({
        id: H.REPO_ID,
        ownerId: H.USER_ID,
        visibility: "PRIVATE",
        storageKey: H.STORAGE_KEY,
        collaborators: [],
      })),
    },
  },
}));

// Isolate the transport from the heavy prisma-backed side effects; keep a spy on
// ingestion so we can assert it fires for an SSH push (parity with HTTP).
vi.mock("../ingest.js", () => ({ ingestCommitRange: H.ingestSpy }));
vi.mock("../timeline-service.js", () => ({ emitHeadPushedForPush: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../push-events.js", () => ({ emitPushEvents: vi.fn(), ZERO_SHA: "0".repeat(40) }));
vi.mock("../ci/trigger.js", () => ({
  triggerWorkflowsForPrSync: vi.fn().mockResolvedValue(undefined),
  triggerWorkflowsForPush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../branch-protection.js", () => ({ syncProtectionConfig: vi.fn().mockResolvedValue(undefined) }));

import { createTestServer } from "./helpers/server.js";
import { createTestRepo, type TestRepo } from "./helpers/git.js";
import type { FastifyInstance } from "fastify";

type GitResult = { code: number; stdout: string; stderr: string };

async function runGit(args: string[], opts: { cwd?: string; keyPath?: string } = {}): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: `node ${SHIM}`,
    // Tell git the shim speaks OpenSSH's option dialect (so it passes `-p PORT`
    // rather than assuming the "simple" variant that cannot set a port).
    GIT_SSH_VARIANT: "ssh",
    FH_SSH_PORT: String(SSH_PORT),
    ...(opts.keyPath ? { FH_SSH_KEY: opts.keyPath } : {}),
  };
  try {
    const { stdout, stderr } = await execFile("git", args, { cwd: opts.cwd, env, timeout: 25000 });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) };
  }
}

async function bareHeadSha(bareRepoPath: string, branch = "main"): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["--git-dir", bareRepoPath, "rev-parse", `refs/heads/${branch}`]);
    return stdout.trim();
  } catch {
    return null;
  }
}

const url = `ssh://git@127.0.0.1:${SSH_PORT}/e2e/repo.git`;

describe("SSH transport — real end-to-end", () => {
  let app: FastifyInstance;
  let repo: TestRepo;
  let tmpDirs: string[] = [];
  let userKeyPath: string;
  let deployKeyPath: string;
  let strangerKeyPath: string;

  beforeAll(async () => {
    // Generate credentials and publish them to the mock holder BEFORE any SSH
    // connection can happen (auth reads H.userPub / H.userFp lazily).
    userPair = ssh2.utils.generateKeyPairSync("ed25519");
    deployPair = ssh2.utils.generateKeyPairSync("ed25519");
    strangerPair = ssh2.utils.generateKeyPairSync("ed25519");
    H.userPub = userPair.public.trim();
    H.deployPub = deployPair.public.trim();
    H.userFp = fingerprintFromRaw(parsePublicKey(userPair.public)!.raw);
    H.deployFp = fingerprintFromRaw(parsePublicKey(deployPair.public)!.raw);

    // createTestRepo sets GIT_STORAGE_ROOT and makes the bare repo; buildServer then
    // reads GIT_STORAGE_ROOT for the SSH host-key path, so order matters.
    repo = await createTestRepo(STORAGE_KEY);
    process.env["FORGEHUB_SSH_PORT"] = String(SSH_PORT);
    app = await createTestServer();

    const keyDir = await mkdtemp(join(tmpdir(), "fh-ssh-keys-"));
    tmpDirs.push(keyDir);
    userKeyPath = join(keyDir, "user");
    deployKeyPath = join(keyDir, "deploy");
    strangerKeyPath = join(keyDir, "stranger");
    await writeFile(userKeyPath, userPair.private, { mode: 0o600 });
    await writeFile(deployKeyPath, deployPair.private, { mode: 0o600 });
    await writeFile(strangerKeyPath, strangerPair.private, { mode: 0o600 });
  }, 60000);

  afterAll(async () => {
    await app.close();
    await repo.cleanup();
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    delete process.env["FORGEHUB_SSH_PORT"];
  });

  it("a registered user key pushes over SSH and ingestion fires (HTTP parity)", async () => {
    const work = await mkdtemp(join(tmpdir(), "fh-ssh-work-"));
    tmpDirs.push(work);
    await execFile("git", ["init", "-q", "-b", "main", work]);
    await execFile("git", ["-C", work, "config", "user.email", "e2e@forgehub.io"]);
    await execFile("git", ["-C", work, "config", "user.name", "E2E"]);
    await execFile("git", ["-C", work, "config", "commit.gpgsign", "false"]);
    await writeFile(join(work, "README.md"), "# hello over ssh\n");
    await execFile("git", ["-C", work, "add", "-A"]);
    await execFile("git", ["-C", work, "commit", "-q", "-m", "initial over ssh"]);
    const { stdout: shaOut } = await execFile("git", ["-C", work, "rev-parse", "HEAD"]);
    const localSha = shaOut.trim();

    await execFile("git", ["-C", work, "remote", "add", "origin", url]);
    const push = await runGit(["-C", work, "push", "origin", "HEAD:main"], { keyPath: userKeyPath });

    expect(push.code, `push stderr:\n${push.stderr}`).toBe(0);
    expect(await bareHeadSha(repo.bareRepoPath)).toBe(localSha);
    // Give the fire-and-forget post-receive effects a tick to run.
    await new Promise((r) => setTimeout(r, 300));
    expect(ingestSpy).toHaveBeenCalled();
    const call = ingestSpy.mock.calls[0];
    expect(call[3]).toBe(localSha); // newSha argument matches the pushed tip
  }, 45000);

  it("a read-only deploy key can clone but its push is REFUSED", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fh-ssh-deploy-"));
    tmpDirs.push(dir);
    const clone = await runGit(["clone", url, dir], { keyPath: deployKeyPath });
    expect(clone.code, `clone stderr:\n${clone.stderr}`).toBe(0);

    const before = await bareHeadSha(repo.bareRepoPath);
    await execFile("git", ["-C", dir, "config", "user.email", "ci@forgehub.io"]);
    await execFile("git", ["-C", dir, "config", "user.name", "CI"]);
    await execFile("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
    await writeFile(join(dir, "ci.txt"), "from a read-only deploy key\n");
    await execFile("git", ["-C", dir, "add", "-A"]);
    await execFile("git", ["-C", dir, "commit", "-q", "-m", "should be refused"]);

    const push = await runGit(["-C", dir, "push", "origin", "HEAD:main"], { keyPath: deployKeyPath });
    expect(push.code).not.toBe(0);
    expect(push.stderr.toLowerCase()).toContain("read-only");
    expect(await bareHeadSha(repo.bareRepoPath)).toBe(before); // unchanged
  }, 45000);

  it("an unregistered key is rejected at authentication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fh-ssh-stranger-"));
    tmpDirs.push(dir);
    const clone = await runGit(["clone", url, dir], { keyPath: strangerKeyPath });
    expect(clone.code).not.toBe(0);
  }, 45000);
});
