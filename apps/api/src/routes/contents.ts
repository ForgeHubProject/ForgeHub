import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, canWrite, resolveRepo } from "../repo-access.js";
import { bareRepoPathFromKey } from "../git-storage.js";
import { runPostReceiveEffects, snapshotHeadShas } from "../git-push-shared.js";
import { resolveActorIdentity } from "../pull-merge.js";
import { commitChanges, type FileChange } from "../web-commit.js";

/** GitHub's web limits: 25 MiB a file; we cap one commit at 50 MiB and 100 changes. */
const FILE_LIMIT = 25 * 1024 * 1024;
const COMMIT_LIMIT = 50 * 1024 * 1024;
const MAX_CHANGES = 100;

type ChangeBody = {
  path?: string;
  content?: string;
  encoding?: "utf8" | "base64";
  delete?: boolean;
  from?: string;
};

/**
 * Editing a repository from the browser (#254): create, edit, upload, delete
 * and move files, committed to the branch or to a new branch for a pull
 * request. The commit is built server-side (web-commit.ts) and then runs the
 * same follow-ups a push does: ingestion, webhooks, CI, PR head updates.
 */
export async function contentRoutes(app: FastifyInstance) {
  const write = app.requireScope("repo:write");

  // POST /repos/:handle/:name/contents
  //   { branch, newBranch?, expectedSha?, message, description?, changes: [...] }
  app.post(
    "/repos/:handle/:name/contents",
    { preHandler: [app.authenticate, write], bodyLimit: Math.ceil(COMMIT_LIMIT * 1.4) + 1024 * 1024 },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const userId = request.user.sub;

      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
      if (!canWrite(repo, userId)) return reply.status(403).send({ error: "Write access required" });
      if (!repo.storageKey) return reply.status(400).send({ error: "Repository has no git storage" });

      const body = request.body as {
        branch?: string;
        newBranch?: string;
        expectedSha?: string;
        message?: string;
        description?: string;
        changes?: ChangeBody[];
      };
      const branch = body.branch?.trim();
      if (!branch) return reply.status(400).send({ error: "branch is required" });
      const newBranch = body.newBranch?.trim() || null;
      if (newBranch && !/^[\w/._-]+$/.test(newBranch)) return reply.status(400).send({ error: "Invalid branch name" });
      const summary = body.message?.trim();
      if (!summary) return reply.status(400).send({ error: "A commit message is required" });
      if (!Array.isArray(body.changes) || body.changes.length === 0) {
        return reply.status(400).send({ error: "changes must list at least one change" });
      }
      if (body.changes.length > MAX_CHANGES) {
        return reply.status(400).send({ error: `A web commit can make at most ${MAX_CHANGES} changes` });
      }

      // Decode, checking sizes as we go.
      const changes: FileChange[] = [];
      let total = 0;
      for (const c of body.changes) {
        if (!c || typeof c.path !== "string") return reply.status(400).send({ error: "Every change needs a path" });
        if (c.delete) {
          changes.push({ path: c.path, delete: true });
          continue;
        }
        let content: Buffer | undefined;
        if (typeof c.content === "string") {
          content = c.encoding === "base64" ? Buffer.from(c.content, "base64") : Buffer.from(c.content, "utf8");
          if (content.length > FILE_LIMIT) {
            return reply.status(413).send({ error: `'${c.path}' is larger than 25 MB, the limit for files added on the web` });
          }
          total += content.length;
          if (total > COMMIT_LIMIT) return reply.status(413).send({ error: "These files add up to more than 50 MB" });
        }
        if (typeof c.from === "string") changes.push({ path: c.path, from: c.from, content });
        else if (content) changes.push({ path: c.path, content });
        else return reply.status(400).send({ error: `'${c.path}' needs content, delete, or from` });
      }

      // Branch protection (#85): server-side commits skip the pre-receive hook,
      // so the rule it would apply is checked here. A protected branch takes
      // changes through pull requests: commit to a new branch instead.
      const target = newBranch ?? branch;
      const rule = await prisma.protectedBranch.findFirst({ where: { repoId: repo.id, branch: target } });
      if (rule?.requirePullRequest) {
        return reply.status(409).send({
          error: `"${target}" is protected: changes go through a pull request. Commit to a new branch instead.`,
          protection: true,
        });
      }

      const repoPath = bareRepoPathFromKey(repo.storageKey);
      const shasBefore = await snapshotHeadShas(repoPath);
      const message = body.description?.trim() ? `${summary}\n\n${body.description.trim()}` : summary;
      const result = await commitChanges(repo.storageKey, {
        base: branch,
        target,
        expectedSha: body.expectedSha ?? null,
        changes,
        message,
        author: await resolveActorIdentity(userId),
      });

      if (!result.ok) {
        const status = result.reason === "invalid" ? 400 : result.reason === "missing" ? 404 : 409;
        const error = result.detail ?? {
          moved: `"${branch}" changed since you started editing. Reload and make your change again.`,
          exists: `Branch "${target}" already exists`,
          missing: "Not found",
          unchanged: "Nothing changed: the files already have this content",
          invalid: "Invalid change",
        }[result.reason];
        return reply.status(status).send({ error, reason: result.reason });
      }

      // The same follow-ups as a push: ingestion, webhooks, CI, PR heads.
      await runPostReceiveEffects(app, { id: repo.id, storageKey: repo.storageKey }, userId, repoPath, shasBefore);

      return reply.status(201).send({ sha: result.sha, branch: target, parent: result.parent });
    },
  );
}
