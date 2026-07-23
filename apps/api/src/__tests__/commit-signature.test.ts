import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import {
  classifySignature,
  commitHeaderHasGpgSig,
  getCommit,
  listCommits,
} from "../git-utils.js";

const execFile = promisify(execFileCb);

/**
 * Commit signature status (Verified badge — issue #117).
 *
 * gpg is not available in this environment, so git's own `%G?` verification
 * cannot reach the full "verified" verdict here; that path is proven via the
 * `classifySignature` matrix (unit). The "signed but unverifiable" path is proven
 * end-to-end against a REAL crafted commit object that carries a `gpgsig` header
 * (written with `git hash-object`), which the raw-header probe detects.
 */

// ─── classifySignature matrix (pure) ──────────────────────────────────────────

describe("classifySignature (%G? matrix)", () => {
  it("G (good) → verified, carrying signer + key", () => {
    expect(classifySignature("G", "Alice <a@x>", "KEY123", false)).toEqual({
      status: "verified", signer: "Alice <a@x>", keyId: "KEY123",
    });
  });

  it("U (good, unknown validity) → verified", () => {
    expect(classifySignature("U", "Bob <b@x>", "K2", false).status).toBe("verified");
  });

  it.each(["B", "X", "Y", "R", "E"])("%s (present but not verifiable) → signed-unverified", (code) => {
    const sig = classifySignature(code, "Carol <c@x>", "K3", false);
    expect(sig.status).toBe("signed-unverified");
    expect(sig.signer).toBe("Carol <c@x>");
  });

  it("N with no raw gpgsig header → unsigned (no signer leaked)", () => {
    expect(classifySignature("N", "", "", false)).toEqual({ status: "unsigned", signer: null, keyId: null });
  });

  it("N but a raw gpgsig header is present (gpg absent) → signed-unverified", () => {
    expect(classifySignature("N", "", "", true).status).toBe("signed-unverified");
  });

  it("empty verdict but raw gpgsig present → signed-unverified", () => {
    expect(classifySignature("", "", "", true).status).toBe("signed-unverified");
  });
});

// ─── commitHeaderHasGpgSig (raw-commit fixtures) ───────────────────────────────

const UNSIGNED_RAW = [
  "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "author A <a@x> 1700000000 +0000",
  "committer A <a@x> 1700000000 +0000",
  "",
  "plain unsigned commit",
  "",
].join("\n");

const SIGNED_RAW = [
  "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "parent 1111111111111111111111111111111111111111",
  "author A <a@x> 1700000000 +0000",
  "committer A <a@x> 1700000000 +0000",
  "gpgsig -----BEGIN PGP SIGNATURE-----",
  " ",
  " iQEzBAABCAAdFiEEfakefakefakefakefake",
  " -----END PGP SIGNATURE-----",
  "",
  "signed commit subject",
  "",
].join("\n");

describe("commitHeaderHasGpgSig (raw commit parsing)", () => {
  it("returns false for an unsigned commit object", () => {
    expect(commitHeaderHasGpgSig(UNSIGNED_RAW)).toBe(false);
  });

  it("returns true for a commit object with a gpgsig header", () => {
    expect(commitHeaderHasGpgSig(SIGNED_RAW)).toBe(true);
  });

  it("does not mistake a 'gpgsig' occurrence in the message body for a header", () => {
    const raw = [
      "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "author A <a@x> 1700000000 +0000",
      "committer A <a@x> 1700000000 +0000",
      "",
      "gpgsig mentioned only in the message",
      "",
    ].join("\n");
    expect(commitHeaderHasGpgSig(raw)).toBe(false);
  });
});

// ─── end-to-end against a real repo ────────────────────────────────────────────

describe("signature status on real commits", () => {
  let repo: TestRepo;
  let unsignedSha: string;
  let signedSha: string;

  beforeAll(async () => {
    repo = await createTestRepo("test/sig.git");
    unsignedSha = await makeCommit(repo.workDir, { "a.txt": "hello" }, "init: unsigned");

    // Craft a REAL signed commit object: reuse the init commit's tree, add a
    // gpgsig header, and write it with `git hash-object` (no gpg needed). Point a
    // branch at it so listCommits/getCommit read it back.
    const tree = (await execFile("git", ["-C", repo.bareRepoPath, "rev-parse", "HEAD^{tree}"])).stdout.trim();
    const body = [
      `tree ${tree}`,
      `parent ${unsignedSha}`,
      "author ForgeHub Test <test@forgehub.io> 1700000000 +0000",
      "committer ForgeHub Test <test@forgehub.io> 1700000000 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " iQEzBAABCAAdFiEEfakefakefakefakefakefakefakefake",
      " -----END PGP SIGNATURE-----",
      "",
      "feat: crafted signed fixture commit",
      "",
    ].join("\n");
    const objFile = join(repo.workDir, "commit-object.txt");
    await writeFile(objFile, body, "utf8");
    signedSha = (await execFile("git", ["-C", repo.bareRepoPath, "hash-object", "-w", "-t", "commit", objFile])).stdout.trim();
    await execFile("git", ["-C", repo.bareRepoPath, "update-ref", "refs/heads/signed", signedSha]);
  }, 30_000);

  afterAll(async () => { await repo.cleanup(); });

  it("reports an ordinary commit as unsigned", async () => {
    const commit = await getCommit(repo.storageKey, unsignedSha);
    expect(commit).not.toBeNull();
    expect(commit!.signature).toEqual({ status: "unsigned", signer: null, keyId: null });
  });

  it("reports a gpgsig-bearing commit as signed (unverifiable without gpg) via getCommit", async () => {
    const commit = await getCommit(repo.storageKey, signedSha);
    expect(commit).not.toBeNull();
    expect(commit!.signature.status).toBe("signed-unverified");
  });

  it("surfaces the signed status through listCommits", async () => {
    const commits = await listCommits(repo.storageKey, "signed");
    const head = commits.find((c) => c.sha === signedSha);
    expect(head).toBeDefined();
    expect(head!.signature.status).toBe("signed-unverified");
    // The parent (ordinary) commit remains unsigned in the same page.
    const parent = commits.find((c) => c.sha === unsignedSha);
    expect(parent!.signature.status).toBe("unsigned");
  });
});
