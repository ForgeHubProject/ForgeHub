# ForgeHub Tech Stack (v1 Proposal)

## Goals for stack selection
- Move fast from empty repo to working MVP.
- Keep contracts strongly typed across frontend and backend.
- Support 2D/3D rendering and semantic diff workflows.
- Stay production-viable without over-engineering.

## Recommended stack
### Frontend
- React + TypeScript + Vite
- `@react-three/fiber` (3D scene rendering)
- `@react-three/drei` (3D helpers and controls)
- Zustand (client state for viewer/review context)
- TanStack Query (server state caching and fetch lifecycle)
- React Router (screen routing)

### Backend
- Node.js + TypeScript
- Fastify (lightweight high-performance API framework)
- Zod (runtime validation and DTO/schema safety)
- OpenAPI generation (API discoverability and contract visibility)

### Data and storage
- PostgreSQL (metadata, proposals, reviews, audit trail)
- Prisma ORM (schema migrations and typed DB access)
- S3-compatible object storage (artifact payloads, snapshot blobs)
  - AWS S3 in cloud
  - MinIO for local development

### Background jobs
- Redis
- BullMQ
- Dedicated workers for normalization and diff computation

### Auth and permissions (MVP)
- Auth.js or Clerk
- Role-based access controls in API layer:
  - owner
  - maintainer
  - reviewer
  - viewer

### DevOps and local environment
- Docker Compose for Postgres, Redis, MinIO
- pnpm (workspace-aware package manager)
- GitHub Actions for CI (lint, test, build)

## Why this stack fits ForgeHub
1. TypeScript end-to-end aligns with contract-first development.
2. Fastify + Prisma keeps the backend simple and maintainable.
3. BullMQ isolates heavy compare jobs from request/response latency.
4. React + R3F supports direct visual mapping from semantic diff results.
5. S3-compatible storage cleanly separates large blobs from relational metadata.

## Alternatives and tradeoffs
### Backend framework
- **NestJS**: better built-in architecture for larger teams, slower initial velocity than Fastify.
- **Go (Fiber/Gin)**: stronger raw performance, but higher implementation overhead for early product iteration.

### ORM / data access
- **Drizzle**: lightweight and SQL-friendly, but Prisma has stronger migration ergonomics for many teams.

### Queue system
- **Temporal**: excellent workflow reliability, but too heavy for first MVP unless orchestration complexity grows quickly.

### Auth
- **Supabase Auth**: fast startup and integrated DB workflows.
- **Self-hosted OAuth/JWT stack**: lower vendor dependency, higher setup and maintenance burden.

## MVP implementation phases
### Phase 0: Contracts and sample data
- Use docs in `docs/contracts/` as source of truth.
- Add seed dataset (`computer -> motherboard -> cpu/gpu`) with two snapshots.

### Phase 1: Thin API + compare endpoint
- Implement:
  - `POST /projects`
  - `POST /projects/:id/snapshots`
  - `GET /projects/:id/snapshots`
  - `POST /diffs/compare`
- Start with in-memory adapters, then swap to Prisma/Postgres.

### Phase 2: Review flow
- Add proposal and review endpoints.
- Persist audit events for every workflow action.

### Phase 3: Performance and hardening
- Move compare to background jobs for large assemblies.
- Add caching and profiler-guided optimizations.
- Tune tolerance/ignore defaults with pilot team feedback.

## Initial monorepo layout
```text
apps/
  web/          # React + Vite frontend
  api/          # Fastify API
workers/
  diff-worker/  # BullMQ worker
packages/
  contracts/    # shared zod/types for schemas and API models
  diff-core/    # normalization + ignore + tolerance + semantic diff logic
infra/
  docker/       # docker-compose and service configs
docs/
  contracts/
  mvp-spec.md
  tech-stack.md
```

## Decision checkpoints
- Re-evaluate Fastify vs Nest after first 2-3 contributors join.
- Re-evaluate BullMQ vs Temporal only when orchestration complexity emerges.
- Re-evaluate database sharding only after proven scale pressure.
