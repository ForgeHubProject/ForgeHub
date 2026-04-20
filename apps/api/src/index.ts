import Fastify from "fastify";
import type { CompareRequest } from "@forgehub/contracts";
import { compareCanonicalArtifacts } from "@forgehub/diff-core";
import {
  sampleBaseDoc,
  sampleBaseSnapshotId,
  sampleProjectId,
  sampleTargetDoc,
  sampleTargetSnapshotId
} from "./sample-data.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

app.get("/projects/sample/snapshots", async () => ({
  projectId: sampleProjectId,
  snapshots: [
    { id: sampleBaseSnapshotId, label: "Base snapshot" },
    { id: sampleTargetSnapshotId, label: "Target snapshot" }
  ]
}));

app.post<{ Body: CompareRequest }>("/diffs/compare", async (request, reply) => {
  const { projectId, baseSnapshotId, targetSnapshotId, options } = request.body as CompareRequest;

  if (
    projectId !== sampleProjectId ||
    baseSnapshotId !== sampleBaseSnapshotId ||
    targetSnapshotId !== sampleTargetSnapshotId
  ) {
    return reply.code(404).send({
      error: {
        code: "SNAPSHOT_NOT_FOUND",
        message:
          "Only sample snapshots are available in scaffold mode. Use proj_sample_computer snap_001 -> snap_002."
      }
    });
  }

  return compareCanonicalArtifacts({
    projectId,
    baseSnapshotId,
    targetSnapshotId,
    baseDoc: sampleBaseDoc,
    targetDoc: sampleTargetDoc,
    includeRawJsonDiff: options?.includeRawJsonDiff ?? false,
    includeIgnoredStats: options?.includeIgnoredStats ?? true
  });
});

const port = Number(process.env.PORT ?? 3001);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`ForgeHub API listening on port ${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
