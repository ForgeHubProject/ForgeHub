# ForgeHub

ForgeHub is a collaboration platform that brings software-style version control workflows to hardware teams.

The goal is to make hardware changes reviewable and traceable without requiring everyone to be physically present. Teams can compare revisions, inspect visual diffs in 2D/3D contexts, discuss proposed changes, and approve updates through a merge-style workflow similar to modern code hosting platforms.

## Why this exists

Hardware teams still lose time in manual review loops:
- design updates are shared as files, screenshots, and meetings
- change intent is hard to reconstruct later
- review feedback is fragmented across chats, docs, and calls
- "what changed, why, and who approved it?" is difficult to answer quickly

ForgeHub aims to solve this by treating hardware artifacts as first-class, versioned assets with collaborative review tooling.

## Product direction

ForgeHub is inspired by the best parts of GitHub workflows:
- commit-style snapshots with metadata
- visual diff views between revisions
- comment and review cycles on proposed changes
- status checks and approvals before merge
- full history and auditability

But it is adapted for hardware artifacts (CAD, blueprints, and other 2D/3D deliverables), where geometry-aware visualization is critical.

## MVP scope

The initial MVP focuses on proving three core outcomes:
1. A hardware design can be snapshotted and versioned reliably.
2. A reviewer can understand changes quickly using visual diffs.
3. Teams can make remote decisions with clear review records.

Detailed requirements and rollout phases are in `docs/mvp-spec.md`.
Recommended implementation stack is in `docs/tech-stack.md`.

## Data and diff philosophy

ForgeHub will store hardware artifacts in a canonical JSON intermediate representation (IR), then drive both visual rendering and review diffs from that same model.

This enables:
- semantic, entity-level diffs (added/removed/modified/moved components)
- visual highlights in 2D/3D surfaces
- optional raw JSON/line-level inspection for advanced debugging
- stable review behavior across nested modules/submodules

Diff noise from exporter jitter or irrelevant metadata is controlled by:
- `.hwignore` rules for paths/fields to ignore
- tolerance thresholds for numeric changes (for example small transform drift)

## Current implementation status

Product specs and contracts live under `docs/`. The first running code path is **`apps/api`**: accounts (register, login, JWT session) and **repositories** owned by a user (`handle/repo-name`, GitHub-style naming). Hardware snapshot and diff APIs from the spec are not wired yet; they can build on this foundation.

## Local development

```bash
npm install
cd apps/api && cp .env.example .env   # set JWT_SECRET to a long random string
npm run db:push --workspace @forgehub/api
npm run dev:api
```

The API listens on `PORT` (default **3001**).

## Monorepo layout

- `apps/api` — Fastify + Prisma (SQLite in dev) — auth and repos today
- `apps/web`, `packages/*`, `workers/*` — not scaffolded yet (see `docs/tech-stack.md`)

### Accounts and repos (implemented)

- `GET /health`
- `POST /auth/register` — body: `email`, `password`, `handle`, optional `displayName`
- `POST /auth/login` — body: `email`, `password` → returns `token` (Bearer JWT)
- `GET /auth/me` — header: `Authorization: Bearer <token>`
- `POST /repos` — create repo for the current user — body: `name`, optional `description`
- `GET /repos/mine` — list repos for the authenticated user
- `GET /users/:handle/repos` — public list of a user’s repos
- `GET /repos/:handle/:name` — public repo metadata
- `PATCH /repos/:name` — authenticated owner updates `description`

Example register:

```json
{
  "email": "you@example.com",
  "password": "your-secure-password",
  "handle": "your-handle"
}
```

## License

MIT
