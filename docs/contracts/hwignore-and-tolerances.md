# `.hwignore` and Tolerance Rules (v0)

## Purpose
Reduce diff noise caused by irrelevant fields and tiny numeric jitter.

This contract defines:
- `.hwignore` syntax and matching behavior
- tolerance comparison rules for semantic diffs

## `.hwignore` file location
- Project root: `.hwignore`
- Optional extra config embedded in snapshot metadata for reproducibility

## `.hwignore` syntax
One rule per line. Empty lines and lines beginning with `#` are ignored.

Rule forms:
- `path:<glob>` ignore matching field paths
- `kind:<value>` ignore all entities of a specific kind
- `attr:<glob>` ignore matching attributes under `attributes`
- `render:<glob>` ignore matching renderRef fields

Examples:
```text
# Ignore importer metadata noise
path:metadata.importedAt
path:metadata.exporterVersion

# Ignore camera or view state if present in attributes
attr:view.*

# Ignore all annotation entities in MVP diffs
kind:annotation

# Ignore render cache keys
render:cacheKey
```

## Path matching rules
- Dot-separated field paths.
- `*` matches one segment.
- `**` matches zero or more segments.
- Matching is case-sensitive.

Examples:
- `path:entities.*.updatedAt`
- `path:entities.**.temporaryId`
- `attr:debug.*`

## Tolerance config
Tolerance values are absolute unless stated otherwise.

Recommended initial contract:
```json
{
  "translationEpsilon": 0.01,
  "rotationEpsilonDeg": 0.1,
  "scaleEpsilon": 0.001,
  "numericAttributeRules": [
    { "path": "attributes.mass", "mode": "absolute", "epsilon": 0.05 },
    { "path": "attributes.powerDrawW", "mode": "relative", "epsilon": 0.01 }
  ]
}
```

## Numeric comparison behavior
- **Absolute mode:** change is ignored if `abs(a - b) <= epsilon`.
- **Relative mode:** change is ignored if `abs(a - b) / max(abs(a), abs(b), 1e-9) <= epsilon`.
- Arrays compare element-wise with same mode.
- NaN and infinity are always treated as meaningful changes.

## Diff pipeline order
1. Normalize artifact into canonical entities.
2. Remove ignored fields/rules from both snapshots.
3. Compare numeric values with tolerance rules.
4. Emit semantic entity-level change set.

## Reporting ignored changes
Diff response should include counts for transparency:
```json
{
  "ignoredByRuleCount": 24,
  "ignoredByToleranceCount": 71
}
```

## Recommended defaults for MVP
- `translationEpsilon = 0.01` (in project unit, default mm)
- `rotationEpsilonDeg = 0.1`
- `scaleEpsilon = 0.001`
- Ignore:
  - importer timestamps
  - exporter/version metadata
  - runtime view/camera fields

## Safety guidelines
- Never ignore `entityId`, `parentEntityId`, or `kind`.
- Never ignore proposal/review/audit metadata.
- Treat rule changes as auditable configuration changes.
