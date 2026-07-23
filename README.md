# ForgeHub

ForgeHub is a collaboration platform that brings software-style version control workflows to hardware teams.

The goal is to make hardware changes reviewable and traceable without requiring everyone to be physically present. Teams can compare revisions, inspect visual diffs in 2D/3D contexts, discuss proposed changes, and approve updates through a merge-style workflow similar to modern code hosting platforms.

## Why this exists

Hardware teams still lose time in manual review loops:
- design updates are shared as files, screenshots, and meetings
- change intent is hard to reconstruct later
- review feedback is fragmented across chats, docs, and calls
- "what changed, why, and who approved it?" is difficult to answer quickly

ForgeHub solves this by treating hardware artifacts as first-class, versioned assets with collaborative review tooling backed by real Git storage.

## Product direction

ForgeHub is inspired by GitHub-style workflows:
- commit-level snapshots with full metadata
- semantic visual diff views between revisions (entity-level for 3D, line-level for text)
- comment and review cycles on proposed changes
- pull requests, merge strategies, and conflict resolution
- full history and auditability

But it is adapted for hardware artifacts (CAD, blueprints, and other 2D/3D deliverables), where geometry-aware visualization and tolerance-aware diffing are critical.

## Data and diff philosophy

Artifacts are stored in a canonical JSON intermediate representation (IR) and a bare Git repository. Diffs are computed at the **semantic** level:

- **glTF scenes** → entity-level diff: added / removed / modified / moved components, with field-level change tracking
- **Plain text** → line-level LCS diff, same model as Git
- New formats plug in via the **handler registry** without touching core logic

Diff noise (exporter jitter, irrelevant metadata) is designed to be controlled by `.hwignore` rules and configurable numeric tolerances — groundwork for this is laid in `docs/contracts/`.

## Current implementation

The API is fully functional end-to-end. Below is a summary of what is running.

### Accounts and authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Liveness check |
| `POST` | `/auth/register` | Create account (`email`, `password`, `handle`, optional `displayName`) |
| `POST` | `/auth/login` | Returns a Bearer JWT |
| `GET` | `/auth/me` | Current user from token |
| `POST` | `/auth/tokens` | Create a named, optionally-expiring Personal Access Token (plaintext shown once) |
| `GET` | `/auth/tokens` | List the caller's tokens (name, prefix, expiry, last used — never the secret) |
| `DELETE` | `/auth/tokens/:id` | Revoke a token immediately |

### Repositories

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/repos` | Create a repo (`name`, `visibility`: `public`\|`private`, optional `description`) |
| `GET` | `/repos/mine` | All repos owned by the caller |
| `GET` | `/users/:handle/repos` | Public repos for any user; all repos if the token is that user |
| `GET` | `/repos/:handle/:name` | Repo metadata; private repos return 404 for non-members |
| `PATCH` | `/repos/:name` | Update `description` or `visibility` |
| `PATCH` | `/repos/:name/rename` | Rename repo and move bare storage path |
| `DELETE` | `/repos/:name` | Delete repo and remove Git storage |
| `GET` | `/repos/:name/collaborators` | List collaborators (owner only) |
| `POST` | `/repos/:name/collaborators` | Add/update collaborator role (`reader` or `writer`) |
| `DELETE` | `/repos/:name/collaborators/:handle` | Remove collaborator |
| `GET` | `/repos/:handle/:name/storage` | Debug: storage key, path, bare-repo status |

### Snapshots and artifact ingestion

Snapshots are immutable point-in-time captures of an artifact file. They are created automatically on `git push` and can also be uploaded directly.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/repos/:handle/:name/snapshots` | Upload an artifact directly (`multipart/form-data`) |
| `GET` | `/repos/:handle/:name/snapshots` | List snapshots (filterable by `branch`, `tag`, `commitSha`) |
| `GET` | `/repos/:handle/:name/snapshots/:id` | Load snapshot with entities and constraints |

### Semantic diff (compare)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/repos/:handle/:name/compare?base=X&target=Y` | Handler-specific diff between two snapshots. Returns entity-level changes (glTF) or line-level changes (text) |

### Branches and tags

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/repos/:handle/:name/branches` | List branches with SHA and default flag |
| `POST` | `/repos/:handle/:name/branches` | Create a branch |
| `DELETE` | `/repos/:handle/:name/branches/:branch` | Delete a branch |
| `GET` | `/repos/:handle/:name/tags` | List tags |
| `POST` | `/repos/:handle/:name/tags` | Create a tag |
| `DELETE` | `/repos/:handle/:name/tags/:tag` | Delete a tag |

### Pull requests and merge

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/repos/:handle/:name/pulls` | List PRs (filter by `state`: `open`\|`closed`\|`merged`\|`all`) |
| `POST` | `/repos/:handle/:name/pulls` | Open a PR (`title`, `fromBranch`, optional `toBranch`, `description`) |
| `GET` | `/repos/:handle/:name/pulls/:number` | PR detail with `mergeable` status |
| `PATCH` | `/repos/:handle/:name/pulls/:number` | Close or reopen a PR |
| `POST` | `/repos/:handle/:name/pulls/:number/merge` | Auto-merge; returns `{ merged, sha }` or 409 on conflict |
| `POST` | `/repos/:handle/:name/pulls/:number/merge-resolve` | Resolve conflicts manually — per-hunk for text, per-entity/field for glTF |

### Forks

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/repos/:handle/:name/forks` | Fork a repo into the caller's namespace |
| `GET` | `/repos/:handle/:name/forks` | List forks |

### Actions-style CI (issue #86, v0)

Repos can define workflows in `.forgehub/workflows/*.yml` that run on `push`
and/or `pull_request`:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    name: Type-check tests
    steps:
      - run: npm ci
      - run: npm test
```

A `push` (branch tip moves) or a PR (open / head-sync) enqueues a **WorkflowRun**
holding one **CheckRun** per job. A built-in in-process runner (one job at a time
in v0) makes a fresh clone of the triggering commit, runs each step with `sh -c`
in that checkout, streams interleaved stdout+stderr to a per-job log, stops on the
first failing step, and times each job out after `CI_JOB_TIMEOUT` seconds. An
invalid workflow file never crashes the push — it surfaces as a failed CheckRun
whose log holds the parse error. Results appear as status dots on commits and in a
PR's Checks section, and in the repo's **Actions** tab (run list + monospace log
view). Logs live on disk under `<GIT_STORAGE_ROOT>-ci/`, never in the database.

> ⚠️ **Security model — single-tenant, self-hosted only.** The runner executes
> **repo-author-controlled shell** directly on the host as the API process user,
> with no container/VM/user sandbox in v0. It is therefore **hard-off unless you
> set `FORGEHUB_CI=1`**, and only meant for an instance where every pusher is
> already trusted with shell access. When `FORGEHUB_CI` is unset, pushes record
> nothing at all — no runs, no parsing. Multi-tenant isolation (containers,
> ephemeral runners, egress control) is a later stage of the epic and must land
> before untrusted authors can be allowed to run CI.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/repos/:handle/:name/commits/:sha/check-summary` | `{total, passing, failing, pending}` for a commit; 404 when it has no runs |
| `GET` | `/repos/:handle/:name/commit-statuses?shas=a,b,c` | Batch per-sha summaries (only shas with runs) |
| `GET` | `/repos/:handle/:name/actions/runs?sha=&prId=` | List workflow runs |
| `GET` | `/repos/:handle/:name/actions/runs/:id` | Run detail with its check runs |
| `GET` | `/repos/:handle/:name/actions/runs/:id/checks/:checkId/log` | Plain-text job log |

**Env:** `FORGEHUB_CI=1` enables the runner (default: off). `CI_JOB_TIMEOUT`
bounds each job in seconds (default: 600).

### Git over HTTPS

Bare repositories are served over standard Git HTTPS transport so any Git client works out of the box.

| Endpoint | Description |
|----------|-------------|
| `GET /git/:handle/:repo/info/refs?service=git-upload-pack` | Clone/fetch capability advertisement |
| `POST /git/:handle/:repo/git-upload-pack` | Clone/fetch pack transfer |
| `GET /git/:handle/:repo/info/refs?service=git-receive-pack` | Push capability advertisement |
| `POST /git/:handle/:repo/git-receive-pack` | Push pack transfer (triggers auto-ingest) |

Auth on Git endpoints accepts `Authorization: Bearer <jwt>`, `Authorization: Basic base64(x:<jwt>)`, or a Personal Access Token as the Basic-auth password (`git clone http://<handle>:<pat>@host/...`). Public repos are readable anonymously; write requires owner or `writer` collaborator. The `forge` CLI's `forge login <url>` command wraps this: it logs in, mints a PAT, and stores it via git's own credential-helper protocol so neither `git` nor `forge` need the token passed by hand afterward.

**Run self-hosted instances behind HTTPS.** Git credential helpers (and most OS/browser credential managers) key lookups on `protocol` + `host` and generally won't offer to fill or prompt for a plain `http://` remote the way they do for `https://`. Plain HTTP will work for git operations themselves, but credential-manager integration (`forge login`, `git credential fill`) degrades — put a TLS-terminating proxy in front of any instance where that matters.

## Local development

**Prerequisites:** Node 20+, Git 2.x.

```bash
# 1. Install dependencies
npm install

# 2. Set environment variables
cp apps/api/.env.example apps/api/.env
# Edit .env — set JWT_SECRET to a random string ≥ 16 characters
# DATABASE_URL defaults to file:./prisma/dev.db

# 3. Push the schema to SQLite
npm run db:push

# 4. Start the API
npm run dev:api
# Listens on http://localhost:3001

# 5. (Optional) Start the web app in a second terminal
npm run dev:web
```

### Running tests

```bash
# From repo root or apps/api
npm test

# Watch mode
npm run test:watch -w @forgehub/api
```

Tests run against mocked Prisma and Git I/O — no real database or Git storage needed.

## Containerized (Docker / Podman)

`docker-compose.yml` builds two images — `apps/api/Dockerfile` (Fastify API + SQLite on a named volume) and `apps/web/Dockerfile` (Vite build served by nginx, which also reverse-proxies `/auth`, `/repos`, `/users`, `/notifications`, `/search`, and `/git` to the api container — one origin for everything, which matters for `forge login`/credential-helper behavior). The compose spec is plain Compose v2 syntax with no Docker-specific extensions, so it runs unchanged under either engine.

```bash
cp .env.example .env   # set JWT_SECRET: openssl rand -base64 32

# Docker
docker compose up -d --build

# Podman (podman-compose, or podman v4.4+'s built-in `podman compose`)
podman compose up -d --build
```

Web (SPA + proxied API + git-http) is published on `${WEB_PORT:-8080}`. The api container isn't published directly — everything goes through the web container's nginx, same as a real deployment behind one TLS-terminating reverse proxy.

```bash
curl http://localhost:8080/health
forge login http://localhost:8080
```

Data (`forgehub.db` and `git-storage/`) lives on the `forgehub-data` named volume, so `docker compose down` (without `-v`) is safe — data survives a rebuild.

**Note on Postgres:** `apps/api/prisma/schema.prisma` targets SQLite, and the checked-in migrations under `apps/api/prisma/migrations/` are SQLite-dialect SQL — they will not run against Postgres as-is. Moving to Postgres for larger deployments means regenerating the migration history against a Postgres datasource first; that's a separate piece of work, not something this compose file does.

## Clone / push walkthrough

If you have the `forge` CLI installed, `forge login http://localhost:3001` handles registration-to-credential in one step (prompts for email/password, mints a PAT, stores it via git's credential helper) — skip straight to `git clone`/`git push` afterward. The manual walkthrough below is the same flow spelled out over raw `curl`.

```bash
# Register and get a token
TOKEN=$(curl -sS -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-secure-password","handle":"you"}' \
  | jq -r .token)

# Create a repo
curl -sS -X POST http://localhost:3001/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","visibility":"private"}'

# Clone (Basic auth: username=x, password=JWT)
git clone "http://x:$TOKEN@localhost:3001/git/you/demo.git"

# Push — ingest runs automatically on the server
cd demo
echo "hello" > README.md
git add README.md && git commit -m "init"
git push origin HEAD
```

## Monorepo layout

```
ForgeHub/
├── apps/
│   ├── api/                  # Fastify 5 + Prisma 6 (SQLite dev / PostgreSQL prod)
│   │   ├── src/
│   │   │   ├── handlers/     # Artifact handlers (gltf-scene, plain-text)
│   │   │   ├── merge/        # Merge resolution (text hunks, glTF entity picks)
│   │   │   ├── routes/       # All HTTP routes
│   │   │   └── __tests__/    # Vitest test suite (188+ tests)
│   │   └── prisma/
│   │       └── schema.prisma # 9 models
│   └── web/                  # React 19 + Three.js (Vite)
│       └── src/
│           ├── views/        # Handler-specific workspaces (GltfScene, PlainText)
│           └── pages/        # Login, RepoList, Snapshot
├── docs/
│   ├── mvp-spec.md
│   ├── tech-stack.md
│   └── contracts/            # Entity schema, diff schema, hwignore spec
└── test-data/                # Sample glTF and text files
```

### Adding a new artifact format

1. Implement `ArtifactHandler` in `apps/api/src/handlers/your-format/`
2. Register it in `apps/api/src/handlers/index.ts`
3. Add a Prisma migration if the format needs a new storage shape
4. Add a matching view component and register it in `apps/web/src/views/registry.tsx`

## License

MIT
