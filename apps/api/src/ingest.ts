import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "./prisma.js";
import { parseGltf, type GltfDocument } from "./gltf-parser.js";

const execFile = promisify(execFileCb);

export async function ingestGltfContent(
  repoId: string,
  gltfContent: string,
  sourceFile: string,
  label: string | null,
  gitCommitSha: string | null,
): Promise<string> {
  // Idempotent: skip if already ingested for this exact commit + file
  if (gitCommitSha) {
    const existing = await prisma.snapshot.findFirst({
      where: { repoId, gitCommitSha, sourceFile },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  const gltf = JSON.parse(gltfContent) as GltfDocument;
  const entities = parseGltf(gltf);

  const snapshot = await prisma.snapshot.create({
    data: {
      repoId,
      label,
      sourceFile,
      gitCommitSha,
      entities: {
        create: entities.map((e) => ({
          entityId: e.entityId,
          parentEntityId: e.parentEntityId ?? null,
          kind: e.kind,
          name: e.name,
          path: e.path,
          posX: e.transform?.position[0] ?? null,
          posY: e.transform?.position[1] ?? null,
          posZ: e.transform?.position[2] ?? null,
          rotX: e.transform?.rotationEulerDeg[0] ?? null,
          rotY: e.transform?.rotationEulerDeg[1] ?? null,
          rotZ: e.transform?.rotationEulerDeg[2] ?? null,
          scaleX: e.transform?.scale[0] ?? null,
          scaleY: e.transform?.scale[1] ?? null,
          scaleZ: e.transform?.scale[2] ?? null,
          attributes: JSON.stringify(e.attributes),
          renderRef: e.renderRef ? JSON.stringify(e.renderRef) : null,
        })),
      },
    },
    select: { id: true },
  });

  return snapshot.id;
}

// Walk all commits in oldSha..newSha (or all commits if oldSha is the null SHA)
// and ingest every .gltf file found in each commit tree.
export async function ingestCommitRange(
  repoId: string,
  repoPath: string,
  oldSha: string,
  newSha: string,
): Promise<void> {
  const NULL_SHA = "0".repeat(40);
  const revRange = oldSha === NULL_SHA ? newSha : `${oldSha}..${newSha}`;

  const { stdout: logOut } = await execFile(
    "git",
    ["log", "--format=%H|%s", "--reverse", revRange],
    { cwd: repoPath },
  );

  const commits = logOut
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf("|");
      return { sha: line.slice(0, idx), message: line.slice(idx + 1).trim() };
    });

  for (const commit of commits) {
    const { stdout: treeOut } = await execFile(
      "git",
      ["ls-tree", "-r", "--name-only", commit.sha],
      { cwd: repoPath },
    );

    const gltfFiles = treeOut
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.toLowerCase().endsWith(".gltf"));

    for (const file of gltfFiles) {
      try {
        const { stdout: content } = await execFile(
          "git",
          ["show", `${commit.sha}:${file}`],
          { cwd: repoPath, maxBuffer: 50 * 1024 * 1024 },
        );
        await ingestGltfContent(repoId, content, file, commit.message || null, commit.sha);
      } catch (e) {
        console.error(`[ingest] skipping ${file}@${commit.sha.slice(0, 7)}: ${String(e)}`);
      }
    }
  }
}
