# Session handoff — ForgeHub / Forge / FHR

**Written:** 2026-08-14, from a Claude Code web session, for a local session.
**Purpose:** move development to local inference so the stack can actually be run and tested.

Everything below was verified against the repos at the SHAs listed, not recalled. Where
something could not be verified, it says so.

---

## 0. Read this first — your local clones are almost certainly stale

The screenshot of `RZ15\Projects\GitHub\ForgeHubProject\` shows folders last modified
**2026-07-26/27**. Main has moved a long way since then in two of the three repos.
Before anything else:

```bash
cd forge     && git fetch origin && git checkout main && git pull
cd ../ForgeHub && git fetch origin && git checkout main && git pull
# FHR isn't in your screenshot — clone it, you need it:
git clone https://github.com/ForgeHubProject/FHR
```

Note the local folder is `ForgeHub-repos` in your screenshot — that is not one of the three
project repos and nothing here touches it.

Also: **the web sessions' clones were shallow.** If you script anything that walks history,
`git rev-parse --is-shallow-repository` should say `false`. A shallow clone makes
`git merge-base` return garbage — it made this session briefly conclude ForgeHub's history
had been rewritten, which it had not.

---

## 1. What the three repos are, and which way the arrows point

```
FHR  ───────────────▶  Forge  ───────────────▶  ForgeHub
(handler registry)     (git-compatible VCS)     (web platform)
```

- **FHR** — *Forge Handler Repository*. Defines what a file format **is**: how to diff it,
  merge it, render it. Ships handler binaries (Go, also compiled to WASM) and renderer
  bundles (TS/React). `manifest.toml` at the repo root is the registry index.
- **Forge** — Go CLI, git-compatible storage/transport, replaces git's text-only diff/merge
  with the handler plugin system. Pulls handlers from FHR and runs them as subprocesses.
- **ForgeHub** — the web platform (Fastify API + React SPA). Pulls *renderer* bundles from
  FHR to display a `StructuredDiff` in the browser; the diff computation itself happens in
  Forge, or in ForgeHub's own WASM runner using the same FHR handler.

Only one format is live end-to-end today: **glTF/GLB** via the `gltf-scene` handler.
`manifest.toml` pins it at build `c81446f`.

Neither Forge nor ForgeHub defines its own handler types — `@fhr/types` is the single
source of truth for the contract both consume. If you change the contract, change it in FHR.

---

## 2. Exact state as of this handoff

| Repo | `main` | Date | Designated branch `claude/project-review-continuation-f7f0e2` |
|---|---|---|---|
| **ForgeHub** | `ba4e38f` | 2026-08-06 | fully merged; 239 commits behind main |
| **FHR** | `d16355d` | 2026-08-05 | fully merged; 71 commits behind main |
| **forge** | `fd8e6d3` | 2026-07-31 | **3 unmerged commits, no open PR** |

### The forge branch has orphaned work

`forge`'s designated branch is pushed but has never been opened as a PR:

```
5edeccb docs: document the write half of the MCP server
5002eec merge: bring this branch up to main
d103035 feat(cli): bulk `forge formats add` + clearer inactive-format messaging
```

That is the only unmerged work of mine anywhere in the three repos. It needs either a PR or
a decision to drop it. Worth a look before you build on `forge` main, since `forge formats
add` behaviour differs between the two.

### Open PRs

- **ForgeHub — none.**
- **forge — 2, both stale:**
  - #55 `fix(login): timeout fetchServerInfo and require fingerprint verification` (2026-08-03)
  - #39 `build: release workflow, prebuilt-binary installer, and forge --version` (2026-07-24)
- **FHR — 11, all stale.** Ten are format-handler PRs opened 2026-07-18/20 and untouched
  since: csv (#20), ipynb (#21), obj (#31), toml (#32), json (#33), yaml (#34),
  image-meta (#35), svg (#36), stl (#37), wav (#38), geojson (#39).

Those ten FHR PRs are a standing decision you should make deliberately. They were all
generated at the same time against `6af078f`, which is now far behind main — and the
handler/renderer contract has changed since (WASM builds, the `mount()` renderer contract,
per-repo format scoping). They will not merge clean and probably should not be merged as-is.
Either rebase them one at a time as each format becomes a real requirement, or close them
and regenerate against the current contract. Leaving eleven stale PRs open is the worst of
the three options.

**I could not list open issues** — the GitHub API rate limit for this account was already
exceeded when I tried, twice. Check issues locally; several are referenced by number below.

---

## 3. Running each repo locally

### ForgeHub

Prerequisites: Node 20+, Git 2.x.

```bash
npm install
cp apps/api/.env.example apps/api/.env    # set JWT_SECRET to ≥16 random chars
npm run db:push                            # schema → SQLite at file:./prisma/dev.db
npm run dev:api                            # http://localhost:3001
npm run dev:web                            # second terminal
```

> **Trap, and it is the one that just bit this project.** Local dev uses `prisma db push`,
> which mutates the database directly and records nothing. The container path uses
> `migrate deploy`. Those two drifted until `migrations/` was 37 tables behind
> `schema.prisma` and `docker compose up` on a fresh volume produced a database missing most
> of the application — while the entire test suite stayed green, because nothing ran the
> migrations. That is fixed (`27c271c`), and `apps/api/src/__tests__/migration-drift.test.ts`
> now asserts both directions. **If you add a model to `schema.prisma`, write the migration.**
> `db:push` alone will pass every test you have and break every fresh deploy.

Containerized:

```bash
cp .env.example .env      # JWT_SECRET required
docker compose up --build # or podman compose
# web on ${WEB_PORT:-8080}, api internal on 3001
```

Two named volumes, deliberately: `forgehub-data` (SQLite + bare repos — losing it loses the
instance) and `forgehub-ci` (logs and job workspaces — reconstructible, safe to delete).

Tests: `npm test` (root, runs api then web), `npm run test:api`, `npm run test:web`.
**92 API test files, 22 web test files.** CI (`.github/workflows/ci.yml`) runs api tests,
web tests, and a typecheck job.

Features off by default that you will want on for real testing:
- `FORGEHUB_CI=1` — Actions-style CI. Off because v0 runs repo-author-controlled shell with
  no sandbox. See §4.
- `FORGEHUB_SSH_PORT=2222` — built-in SSH git server, no system sshd needed. Generates an
  ed25519 host key on first start and logs the fingerprint.

### forge

Go 1.25. No Makefile.

```bash
go vet ./...
go build ./...
go test -race ./...
```

`cmd/forge` is the CLI, `cmd/gltfcheck` a helper. `internal/` holds `mcpserver` (the agent
interface, `forge mcp`), `webdiff` (`forge diff --web`), `handler`, `manifest`, `fhr`,
`gitrepo`, `forgerepo`, `credential`.

### FHR

Node 20+ workspaces, plus Go for the handler.

```bash
npm ci
npm run build --workspace @fhr/types
npm run build --workspace @fhr/renderer-sdk
npm run build --workspace @fhr/renderer-gltf-scene   # build order matters
npm run typecheck
npm test
```

The build order is not optional — typecheck resolves `@fhr/types` and `@fhr/renderer-sdk`
through their built `.d.ts`. The Go handler lives in `packages/handler-gltf-scene/` with its
own `go.mod` (Go 1.22, `qmuntal/gltf`). CI has a separate `go` job building native + WASM.

The renderer enforces a gzip bundle budget in `package.json`: 20 KiB for `renderer.js`,
250 KiB for `renderer-3d.js`. The 3D view is lazy-loaded specifically to stay under it.

### Testing the three together

This is the reason for moving local, so: the wiring point is `manifest.toml` in FHR, which
pins `.gltf`/`.glb` → `gltf-scene` at build `c81446f`, with asset URLs pointing at the
`gltf-scene-latest` rolling GitHub release. A local FHR build does **not** update that
release. To test a locally-modified handler end to end you need to point forge at a local
source or overwrite the downloaded artifact — worth confirming how `forge source add` and
`forge formats update` behave against a `file://` manifest, which I have not verified.

`ForgeHub/test-data/` has eight glTF fixtures (`mouse.gltf`, `mouse-assembly.gltf`,
`keyboard.gltf`, `single-part.gltf`, and the mouse sub-parts) — that is your diff corpus.

---

## 4. What landed most recently in ForgeHub

Three PRs, all merged, main now `ba4e38f`:

| PR | Merge | What |
|---|---|---|
| **#173** | `2cf97a2` | CI Tier 0 hardening (#86) — step env allowlist, non-root, CI volume split, boot sweep, log cap, `--no-hardlinks` |
| **#168** | `1eef60f` | SSH observability; entrypoint revert; a sweep test that can actually fail |
| **#174** | `ba4e38f` | Migration history repaired — `docker compose up` on a fresh volume builds a working DB again |

### The `/proc` residual — understand this before touching CI

`step-env.ts` builds a CI step's environment from a small allowlist, so `JWT_SECRET`,
`DATABASE_URL`, SMTP creds etc. are not handed to workflow code. **That is not a secrecy
guarantee and must not be described as one.** The runner spawns each step as a direct child
of the API process under the same OS user, so a step reads the API's entire environment out
of `/proc/<ppid>/environ` — `tr '\0' '\n' < /proc/1/environ` in the shipped container.
`process.env` deletions do not help; `/proc` reflects the exec-time stack.

`apps/api/src/__tests__/ci-step-env-residual.test.ts` **performs that read and asserts it
succeeds.** It is supposed to pass today. It is a tripwire on the documentation: the day the
runner is extracted into its own process under its own uid, that test fails, and the failure
message tells you to go delete the now-obsolete warnings in `README.md` and `step-env.ts`.
Do not "fix" it by deleting it.

---

## 5. Open threads, ranked

**1. Runner extraction — the only thing that actually closes #86.**
It is the only change that stops the token-signing key being in an ancestor's address space.
Two shapes, both measured:
- A separate `ci-runner` compose service without `JWT_SECRET` closes the headline finding.
- Adding `CAP_SETUID` and a per-step uid also closes `DATABASE_URL`, since a different-uid
  child gets `EACCES` on `/proc/<ppid>/environ`.

Not started, and it wants your decision first: it means a new compose service, a DB
claim/lease replacing the current in-heap queue, and cancel becomes eventually-consistent.

**2. SSH `lastUsedIp` stamping is unasserted.** PR #168 added a `deployKey.update` mock that
stops a crash; nothing checks the value is actually written.

**3. Probe-path rate-limit reset.** In `apps/api/src/ssh/server.ts:354`, `resetAuthFailures(ip)`
runs outside the `if (ctx.signature)` block — so a key *offer* with no signature clears the
limiter. Anyone holding a valid public key fingerprint can reset the 5-failures/60s counter
without ever proving they hold the private key. Pre-existing, in PR #55's area, so I left it
alone; fix it with #55 or right after it.

**4. No lint job in CI, and `noUnusedLocals` is off.** Same shape of gap as the migration
drift: nothing was checking, so it rotted quietly. Cheap to add, and worth adding *before*
the runner extraction rather than after.

**5. Decide the eleven stale FHR PRs** (see §2).

**6. Open the forge branch's 3 commits as a PR, or drop them** (see §2).

---

## 6. Conventions that carried over

- Branch naming in these repos is `claude/<topic>`; ForgeHub CI triggers on
  `main`, `claude/**`, `feature/**` — forge and FHR CI trigger on all branches.
- Commit subjects are `type(scope): imperative summary`, often with `(#NN)` or `closes #NN`.
- Test files sit in `apps/api/src/__tests__/` in ForgeHub, alongside sources in Go repos.
- Several tests carry long block comments explaining *why the test exists and what it pins*.
  `migration-drift.test.ts` and `ci-step-env-residual.test.ts` are the two to read first —
  they encode reasoning you would otherwise have to rediscover.
