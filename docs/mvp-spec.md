# ForgeHub MVP Specification

## 1) Product intent
ForgeHub brings software-style review workflows to hardware artifacts.

The MVP proves that a distributed team can:
1. Snapshot hardware states reliably.
2. Compare snapshots with clear visual and structured diffs.
3. Run a lightweight review flow (propose, comment, approve/reject, merge).
4. Trace who changed what and when for accepted changes.

## 2) Core principles
1. **Entity-first diffs over line-first diffs:** primary output is semantic changes on components/modules.
2. **Canonical JSON IR:** all ingest formats are normalized into an internal representation for stable diffing/rendering.
3. **Visual + structured review:** reviewers see both scene highlights and grouped change summaries.
4. **Configurable noise suppression:** irrelevant fields and tiny numeric jitter are filtered before diffing.
5. **Black-box module support:** nested modules are renderable and traceable even when internal semantics are opaque.

## 3) Target users
- Mechanical engineers collaborating on assembly changes.
- Hardware leads reviewing design updates before release.
- Manufacturing/prototyping stakeholders needing clear revision history.

## 4) In-scope capabilities
### 4.1 Repository and versioning primitives
- Project workspace ("hardware repo").
- Assembly model tracked as canonical JSON IR artifact.
- Snapshot/commit object:
  - id
  - author
  - timestamp
  - message
  - parent snapshot id
  - assembly payload hash
- Ordered history timeline.

### 4.2 Canonical JSON IR and hierarchy
- Internal schema for nodes/entities with stable IDs.
- Hierarchical submodule support (module, submodule, submodule-of-submodule).
- Required minimum per entity:
  - `entityId` (stable across snapshots)
  - `parentEntityId` (or null for root)
  - `kind` (part, assembly, module, annotation, etc.)
  - `transform` (position/rotation/scale where relevant)
  - `attributes` (extensible metadata map)
  - `renderRef` (pointer to geometry/2D primitive/asset)
- Black-box mode:
  - preserve nested payload
  - diff only interface-level fields + transform + metadata hash
  - still render if render payload exists

### 4.3 Visual diff engine (MVP level)
- Compare snapshot A vs snapshot B.
- Detect and classify:
  - added entities
  - removed entities
  - moved/rotated entities
  - metadata/attribute modifications
  - parent change (re-parented entities)
- Render:
  - color-coded entities in viewport
  - side panel with grouped changes
  - per-entity before/after details where available
  - optional raw JSON diff tab for advanced users

### 4.4 Noise filtering and tolerances
- Support `.hwignore` in project root for ignored paths/fields.
- Support tolerance config for numeric comparison, for example:
  - translation epsilon
  - rotation epsilon
  - scale epsilon
  - attribute-specific thresholds
- Diff pipeline:
  1. Normalize payload.
  2. Apply ignore rules.
  3. Apply tolerance comparisons.
  4. Emit semantic entity diff.

### 4.5 Change proposal workflow ("PR-lite")
- Create proposal from source snapshot to target snapshot.
- Add title and description.
- Request reviewers.
- Reviewer actions:
  - comment
  - approve
  - request changes
- Merge when required approvals are met.
- Merge semantics for MVP:
  - accepted proposal creates new target snapshot reference
  - immutable audit trail linking proposal, reviews, and resulting snapshot

### 4.6 Activity and audit trail
- Event log for:
  - snapshot creation
  - proposal creation/update
  - comment creation
  - review decisions
  - merge actions
- Immutable history view per project.

## 5) Out-of-scope for MVP
- True multi-user real-time co-editing.
- Auto-resolving geometric merge conflicts across parallel branches.
- Native CAD plugin ecosystem.
- Enterprise SSO/SCIM.
- Full regulatory compliance bundles (follow-on).

## 6) Non-functional requirements
- **Performance:** semantic diff generation for up to 2,000 entities under 3 seconds on baseline hardware.
- **Reliability:** snapshot integrity checks via content hash validation.
- **Usability:** reviewer identifies change meaning within 30 seconds in user tests.
- **Security (baseline):** authenticated access, role-based project permissions, encrypted transport.

## 7) MVP architecture (proposed)
### Frontend
- React + 2D/3D viewport.
- Diff inspector panel (semantic first, raw JSON optional).
- Review timeline panel.

### Backend (initial)
- API service for projects/snapshots/proposals/reviews/comments.
- Object storage for artifact payloads.
- Relational DB for metadata, review state, and event log.
- Background worker for normalization and diff computation jobs.

### Data model (core entities)
- User
- Project
- Snapshot
- Artifact
- DiffResult
- Proposal
- Review
- Comment
- AuditEvent

## 8) Milestones
### M0 - Contracts first (foundation)
- Define canonical JSON IR schema and validation.
- Define `.hwignore` grammar and tolerance schema.
- API contracts for project/snapshot/diff/proposal/review.
- Basic project CRUD and snapshot create/list/load.

### M1 - Diffable history
- Normalization pipeline and semantic diff endpoint.
- Visual diff rendering in client.
- Change summary panel with grouped entity changes.

### M2 - Review loop
- Proposal creation and reviewer assignment.
- Per-entity comments.
- Approval and merge gating with audit linking.

### M3 - Hardening
- Audit log screens.
- Performance tuning for target entity count.
- Pilot feedback cycle with 2-3 design teams.

## 9) Success metrics
- At least 70% of pilot review cycles completed without live meetings.
- Median review turnaround time reduced by 30% versus baseline process.
- At least 80% reviewer confidence score ("I understood what changed") in post-review survey.

## 10) Open research tracks
1. **Input adapters:** which source formats should be first-class import targets after MVP?
2. **Geometry-aware merge:** what conflict strategies are feasible for post-MVP branch workflows?
3. **Integration strategy:** which import/export integrations create the fastest adoption path in pilot teams?

## 11) Suggested immediate next steps
1. Publish v0 contracts:
   - `docs/contracts/canonical-entity-schema.md`
   - `docs/contracts/diff-schema.md`
   - `docs/contracts/hwignore-and-tolerances.md`
2. Implement minimal in-memory backend with these endpoints:
   - `POST /projects`
   - `POST /projects/:id/snapshots`
   - `GET /projects/:id/snapshots`
   - `POST /diffs/compare`
   - `POST /proposals`
3. Add a tiny sample dataset:
   - computer -> motherboard -> CPU/GPU submodules
   - one movement change, one metadata change, one added component
4. Build first vertical slice UI:
   - load snapshot pair
   - visualize diff
   - approve/reject proposal