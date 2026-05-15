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

### Git over HTTPS

Bare repositories are served over standard Git HTTPS transport so any Git client works out of the box.

| Endpoint | Description |
|----------|-------------|
| `GET /git/:handle/:repo/info/refs?service=git-upload-pack` | Clone/fetch capability advertisement |
| `POST /git/:handle/:repo/git-upload-pack` | Clone/fetch pack transfer |
| `GET /git/:handle/:repo/info/refs?service=git-receive-pack` | Push capability advertisement |
| `POST /git/:handle/:repo/git-receive-pack` | Push pack transfer (triggers auto-ingest) |

Auth on Git endpoints accepts either `Authorization: Bearer <jwt>` or `Authorization: Basic base64(x:<jwt>)`. Public repos are readable anonymously; write requires owner or `writer` collaborator.

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

## Clone / push walkthrough

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
