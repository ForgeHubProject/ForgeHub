import type { FastifyInstance } from "fastify";
import { canRead, resolveRepo } from "../repo-access.js";
import { defaultBranch, getCommit, listCommits, listTree, readFileAtBranch } from "../git-utils.js";

// Checked in priority order: prefer .md > .txt > .rst > .adoc > bare README
const README_NAMES = ["readme.md", "readme.txt", "readme.rst", "readme.adoc", "readme"];

function findReadmeEntry(entries: Array<{ name: string; path: string; type: string }>) {
  for (const target of README_NAMES) {
    const entry = entries.find((e) => e.type === "blob" && e.name.toLowerCase() === target);
    if (entry) return entry;
  }
  return null;
}

export async function commitRoutes(app: FastifyInstance) {
  // GET /repos/:handle/:name/commits?branch=X&page=N&per_page=N
  app.get("/repos/:handle/:name/commits", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.send({ commits: [], branch: "main", page: 1, perPage: 20 });

    const { branch: branchQ, page: pageQ, per_page: perPageQ } = request.query as Record<string, string | undefined>;
    const ref = branchQ ?? await defaultBranch(repo.storageKey);
    const page = Math.max(1, parseInt(pageQ ?? "1", 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(perPageQ ?? "20", 10) || 20));

    const commits = await listCommits(repo.storageKey, ref, { page, perPage });
    return { commits, branch: ref, page, perPage };
  });

  // GET /repos/:handle/:name/commits/:sha
  app.get("/repos/:handle/:name/commits/:sha", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, sha } = request.params as { handle: string; name: string; sha: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(404).send({ error: "No git storage" });

    const commit = await getCommit(repo.storageKey, sha);
    if (!commit) return reply.status(404).send({ error: "Commit not found" });
    return commit;
  });

  // GET /repos/:handle/:name/tree/:ref  (root listing)
  app.get("/repos/:handle/:name/tree/:ref", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, ref } = request.params as { handle: string; name: string; ref: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(404).send({ error: "No git storage" });

    const entries = await listTree(repo.storageKey, ref, "");
    if (entries.length === 0) {
      // Could be an empty/invalid ref — treat as 404
      return reply.status(404).send({ error: "Ref not found or empty tree" });
    }
    return { ref, path: "", entries };
  });

  // GET /repos/:handle/:name/tree/:ref/*  (subdirectory listing)
  app.get("/repos/:handle/:name/tree/:ref/*", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, ref } = request.params as { handle: string; name: string; ref: string };
    const treePath = (request.params as Record<string, string>)["*"] ?? "";
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(404).send({ error: "No git storage" });

    const entries = await listTree(repo.storageKey, ref, treePath);
    if (entries.length === 0) return reply.status(404).send({ error: "Path not found or empty directory" });
    return { ref, path: treePath, entries };
  });

  // GET /repos/:handle/:name/readme?ref=X&path=Y
  // Scans the directory at `path` (default: root) for a README file and returns its content.
  app.get("/repos/:handle/:name/readme", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey) return reply.status(404).send({ error: "No git storage" });

    const { ref: refQ, path: pathQ } = request.query as { ref?: string; path?: string };
    const ref = refQ ?? await defaultBranch(repo.storageKey);
    const dirPath = pathQ ?? "";

    const entries = await listTree(repo.storageKey, ref, dirPath);
    const readmeEntry = findReadmeEntry(entries);
    if (!readmeEntry) return reply.status(404).send({ error: "No README found" });

    const content = await readFileAtBranch(repo.storageKey, ref, readmeEntry.path);
    if (content === null) return reply.status(404).send({ error: "README could not be read" });

    return { path: readmeEntry.path, name: readmeEntry.name, ref, content };
  });

  // GET /repos/:handle/:name/blob/:ref/*  (raw file content)
  app.get("/repos/:handle/:name/blob/:ref/*", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name, ref } = request.params as { handle: string; name: string; ref: string };
    const filePath = (request.params as Record<string, string>)["*"] ?? "";
    const userId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Not found" });
    if (!repo.storageKey || !filePath) return reply.status(404).send({ error: "No git storage or missing path" });

    const content = await readFileAtBranch(repo.storageKey, ref, filePath);
    if (content === null) return reply.status(404).send({ error: "File not found" });
    return reply.type("text/plain").send(content);
  });
}
