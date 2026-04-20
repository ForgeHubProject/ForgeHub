# Canonical Entity Schema (v0)

## Purpose
Define a stable internal JSON intermediate representation (IR) for 2D/3D hardware artifacts.

This contract is the source of truth for:
- snapshot storage
- semantic diff computation
- review rendering

## Design goals
- Keep schema minimal and implementation-friendly.
- Support deeply nested module/submodule hierarchies.
- Preserve black-box payloads without requiring semantic understanding.
- Provide stable identity across snapshots.

## Document shape
```json
{
  "schemaVersion": "0.1.0",
  "projectId": "proj_123",
  "rootEntityId": "ent_root",
  "entities": [/* Entity[] */],
  "metadata": {
    "sourceFormat": "gltf",
    "importedAt": "2026-04-19T22:00:00Z",
    "unitSystem": "mm"
  }
}
```

## Entity contract
```json
{
  "entityId": "ent_cpu_001",
  "parentEntityId": "ent_mobo_001",
  "kind": "module",
  "name": "CPU",
  "path": "computer/motherboard/cpu",
  "transform": {
    "position": [10.0, 2.0, 0.0],
    "rotationEulerDeg": [0.0, 0.0, 90.0],
    "scale": [1.0, 1.0, 1.0]
  },
  "attributes": {
    "material": "silicon",
    "revision": "B2"
  },
  "renderRef": {
    "type": "mesh",
    "assetId": "asset_cpu_mesh_v3",
    "subPath": null
  },
  "opaquePayloadHash": null,
  "createdAt": "2026-04-19T22:00:00Z",
  "updatedAt": "2026-04-19T22:00:00Z"
}
```

## Field requirements
- `entityId` (string, required): globally unique in a project and stable across snapshots.
- `parentEntityId` (string | null, required): null only for root.
- `kind` (string, required): suggested values `assembly`, `module`, `part`, `annotation`, `primitive2d`.
- `name` (string, required): human-readable label.
- `path` (string, required): canonical path from root for UI and comments.
- `transform` (object, optional): required for renderable spatial nodes.
- `attributes` (object, required): extensible metadata map.
- `renderRef` (object | null, required): render pointer for 2D/3D surface.
- `opaquePayloadHash` (string | null, required): hash of opaque internals when black-boxed.
- `createdAt`, `updatedAt` (ISO timestamp, required).

## Black-box module behavior
When internals are unknown, unsupported, or intentionally hidden:
- keep a single visible parent entity with `renderRef` if available.
- set `opaquePayloadHash` to represent internal payload state.
- do not require children to be expanded in canonical entities.
- diff only exposed fields plus payload hash changes.

## Identity and stability rules
1. `entityId` must not change across snapshots for the same logical component.
2. Parent re-linking is represented by changing `parentEntityId`.
3. Replacing an entity must use a new `entityId`.
4. `path` may change if hierarchy changes; identity still comes from `entityId`.

## Minimal validation rules
- Exactly one root entity where `parentEntityId = null` and `entityId = rootEntityId`.
- Every non-root `parentEntityId` references an existing entity.
- No directed cycles in parent-child graph.
- Entity IDs are unique.
- `transform` arrays must have exactly 3 numeric values.

## Example hierarchy
```json
{
  "rootEntityId": "ent_computer",
  "entities": [
    { "entityId": "ent_computer", "parentEntityId": null, "kind": "assembly", "name": "Computer", "path": "computer", "attributes": {}, "renderRef": null, "opaquePayloadHash": null, "createdAt": "2026-04-19T22:00:00Z", "updatedAt": "2026-04-19T22:00:00Z" },
    { "entityId": "ent_mobo", "parentEntityId": "ent_computer", "kind": "module", "name": "Motherboard", "path": "computer/motherboard", "attributes": {}, "renderRef": { "type": "mesh", "assetId": "asset_mobo", "subPath": null }, "opaquePayloadHash": null, "createdAt": "2026-04-19T22:00:00Z", "updatedAt": "2026-04-19T22:00:00Z" },
    { "entityId": "ent_cpu", "parentEntityId": "ent_mobo", "kind": "module", "name": "CPU", "path": "computer/motherboard/cpu", "attributes": { "revision": "B2" }, "renderRef": { "type": "mesh", "assetId": "asset_cpu", "subPath": null }, "opaquePayloadHash": null, "createdAt": "2026-04-19T22:00:00Z", "updatedAt": "2026-04-19T22:00:00Z" },
    { "entityId": "ent_gpu", "parentEntityId": "ent_mobo", "kind": "module", "name": "GPU", "path": "computer/motherboard/gpu", "attributes": { "vendor": "NVIDIA" }, "renderRef": { "type": "mesh", "assetId": "asset_gpu", "subPath": null }, "opaquePayloadHash": null, "createdAt": "2026-04-19T22:00:00Z", "updatedAt": "2026-04-19T22:00:00Z" }
  ]
}
```

## Versioning policy
- Backward-compatible additions: minor bump (`0.1.x` -> `0.2.0` while still in pre-1.0).
- Breaking changes: next minor pre-1.0 (`0.x` semantics) with migration notes in this file.
