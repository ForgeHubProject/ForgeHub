# Semantic Diff Schema (v0)

## Purpose
Define the canonical output of snapshot comparison for:
- visual highlighting
- review summaries
- proposal gating and audit trail

Diffs are entity-first. Line-level JSON diff is optional diagnostic output.

## Compare request
```json
{
  "projectId": "proj_123",
  "baseSnapshotId": "snap_001",
  "targetSnapshotId": "snap_002",
  "options": {
    "includeRawJsonDiff": false,
    "includeIgnoredStats": true
  }
}
```

## Compare response
```json
{
  "diffId": "diff_abc123",
  "projectId": "proj_123",
  "baseSnapshotId": "snap_001",
  "targetSnapshotId": "snap_002",
  "summary": {
    "added": 2,
    "removed": 1,
    "modified": 3,
    "moved": 1,
    "reparented": 1
  },
  "changes": [/* Change[] */],
  "ignoredStats": {
    "ignoredByRuleCount": 24,
    "ignoredByToleranceCount": 71
  },
  "rawJsonDiff": null,
  "computedAt": "2026-04-19T23:00:00Z",
  "durationMs": 842
}
```

## Change item contract
```json
{
  "changeId": "chg_1",
  "type": "modified",
  "entityId": "ent_cpu",
  "path": "computer/motherboard/cpu",
  "kind": "module",
  "before": {
    "parentEntityId": "ent_mobo",
    "transform": { "position": [10, 2, 0], "rotationEulerDeg": [0, 0, 90], "scale": [1, 1, 1] },
    "attributes": { "revision": "B1" },
    "opaquePayloadHash": null
  },
  "after": {
    "parentEntityId": "ent_mobo",
    "transform": { "position": [10, 2, 0], "rotationEulerDeg": [0, 0, 90], "scale": [1, 1, 1] },
    "attributes": { "revision": "B2" },
    "opaquePayloadHash": null
  },
  "fieldChanges": [
    {
      "fieldPath": "attributes.revision",
      "changeKind": "value",
      "before": "B1",
      "after": "B2"
    }
  ]
}
```

## Change types
- `added`: entity appears in target only.
- `removed`: entity appears in base only.
- `modified`: same `entityId`, one or more meaningful fields changed.
- `moved`: same parent, transform changed beyond tolerance.
- `reparented`: `parentEntityId` changed.

`moved` and `modified` may co-exist for same entity via multiple change entries or combined field changes (implementation choice, keep consistent).

## Field change kinds
- `value`: scalar/string/boolean changed.
- `numeric_tolerance_exceeded`: numeric change exceeds threshold.
- `parent_changed`: parent relationship changed.
- `render_ref_changed`: render reference changed.
- `opaque_payload_changed`: black-box hash changed.

## Raw JSON diff (optional)
When `includeRawJsonDiff=true`, populate:
```json
{
  "format": "json-patch",
  "operations": [
    { "op": "replace", "path": "/entities/3/attributes/revision", "value": "B2" }
  ]
}
```

This is diagnostic only and should not drive review UI by default.

## Determinism requirements
- Same input snapshots + same ignore/tolerance config must produce byte-equivalent diff output ordering.
- Changes should be sorted by:
  1. `path`
  2. `entityId`
  3. `type`

## Error response examples
```json
{
  "error": {
    "code": "SNAPSHOT_NOT_FOUND",
    "message": "Target snapshot snap_999 was not found."
  }
}
```

```json
{
  "error": {
    "code": "INVALID_COMPARE_OPTIONS",
    "message": "includeRawJsonDiff must be a boolean."
  }
}
```
