import type { CanonicalArtifactDocument } from "@forgehub/contracts";

export const sampleProjectId = "proj_sample_computer";
export const sampleBaseSnapshotId = "snap_001";
export const sampleTargetSnapshotId = "snap_002";

export const sampleBaseDoc: CanonicalArtifactDocument = {
  schemaVersion: "0.1.0",
  projectId: sampleProjectId,
  rootEntityId: "ent_computer",
  metadata: {
    sourceFormat: "gltf",
    importedAt: "2026-04-19T22:00:00Z",
    unitSystem: "mm"
  },
  entities: [
    {
      entityId: "ent_computer",
      parentEntityId: null,
      kind: "assembly",
      name: "Computer",
      path: "computer",
      attributes: {},
      renderRef: null,
      opaquePayloadHash: null,
      createdAt: "2026-04-19T22:00:00Z",
      updatedAt: "2026-04-19T22:00:00Z"
    },
    {
      entityId: "ent_mobo",
      parentEntityId: "ent_computer",
      kind: "module",
      name: "Motherboard",
      path: "computer/motherboard",
      attributes: {},
      renderRef: { type: "mesh", assetId: "asset_mobo", subPath: null },
      opaquePayloadHash: null,
      createdAt: "2026-04-19T22:00:00Z",
      updatedAt: "2026-04-19T22:00:00Z"
    },
    {
      entityId: "ent_cpu",
      parentEntityId: "ent_mobo",
      kind: "module",
      name: "CPU",
      path: "computer/motherboard/cpu",
      transform: {
        position: [10, 2, 0],
        rotationEulerDeg: [0, 0, 90],
        scale: [1, 1, 1]
      },
      attributes: { revision: "B1" },
      renderRef: { type: "mesh", assetId: "asset_cpu", subPath: null },
      opaquePayloadHash: null,
      createdAt: "2026-04-19T22:00:00Z",
      updatedAt: "2026-04-19T22:00:00Z"
    },
    {
      entityId: "ent_gpu",
      parentEntityId: "ent_mobo",
      kind: "module",
      name: "GPU",
      path: "computer/motherboard/gpu",
      transform: {
        position: [14, 2, 0],
        rotationEulerDeg: [0, 0, 90],
        scale: [1, 1, 1]
      },
      attributes: { vendor: "NVIDIA" },
      renderRef: { type: "mesh", assetId: "asset_gpu", subPath: null },
      opaquePayloadHash: null,
      createdAt: "2026-04-19T22:00:00Z",
      updatedAt: "2026-04-19T22:00:00Z"
    }
  ]
};

export const sampleTargetDoc: CanonicalArtifactDocument = {
  ...sampleBaseDoc,
  metadata: {
    ...sampleBaseDoc.metadata,
    importedAt: "2026-04-19T22:05:00Z"
  },
  entities: sampleBaseDoc.entities
    .filter((entity) => entity.entityId !== "ent_gpu")
    .map((entity) => {
      if (entity.entityId === "ent_cpu") {
        return {
          ...entity,
          attributes: { ...entity.attributes, revision: "B2" },
          updatedAt: "2026-04-19T22:05:00Z"
        };
      }
      return entity;
    })
    .concat({
      entityId: "ent_nic",
      parentEntityId: "ent_mobo",
      kind: "module",
      name: "Network Card",
      path: "computer/motherboard/nic",
      transform: {
        position: [16, 2, 0],
        rotationEulerDeg: [0, 0, 90],
        scale: [1, 1, 1]
      },
      attributes: { speedGbps: 10 },
      renderRef: { type: "mesh", assetId: "asset_nic", subPath: null },
      opaquePayloadHash: null,
      createdAt: "2026-04-19T22:05:00Z",
      updatedAt: "2026-04-19T22:05:00Z"
    })
};
