# ForgeHub → VPS deploy plan (investor demo Wednesday)

## Audit result (done in cloud sandbox)
| Check | Result |
|---|---|
| API typecheck (`tsc --noEmit`) | clean |
| API tests | 95 files / 1623 tests pass |
| Web tests | 25 files / 254 tests pass |
| Web build (vite) | ok (930 kB chunk warning, harmless) |
| Docker/Podman image build | **NOT TESTED** — sandbox has no Docker daemon. Must test on VPS. |

No code bugs found by tests. Risks are all deploy/config side.

## Recommended topology
Combined image `docker.io/touficmajdalani/forgehub:latest` + `docker-compose.yml` (SQLite) → simplest, demo-safe.
Host reverse proxy (Caddy) terminates TLS → forwards to container `127.0.0.1:8080`.
Postgres/MySQL variants: skip for demo (see risk #5).

## Steps on VPS
1. Provision: Ubuntu 22/24, 2 vCPU / 2 GB+ RAM, 20 GB+ disk. Install Docker (or Podman + podman-compose).
2. DNS: A record `forge.<yourdomain>` → VPS IP. (Do this NOW — propagation.)
3. Firewall (ufw): allow 22 (admin ssh), 80, 443. If using git-SSH, see step 7 (port clash).
4. Clone repo / copy `docker-compose.yml` + `.env`.
5. `.env`:
   ```
   JWT_SECRET=$(openssl rand -hex 32)
   UNSUBSCRIBE_SECRET=$(openssl rand -hex 32)
   PUBLIC_URL=https://forge.<yourdomain>
   WEB_PORT=8080
   FORGEHUB_CI=            # leave OFF (runs repo shell code, no sandbox)
   SMTP_URL=               # optional; without it mail goes to a jsonl file
   ```
6. Bind web port to loopback only — edit compose `ports:` to `"127.0.0.1:${WEB_PORT:-8080}:80"` so nothing bypasses TLS.
7. Caddy (`/etc/caddy/Caddyfile`):
   ```
   forge.<yourdomain> {
       request_body { max_size 0 }     # big git pushes
       reverse_proxy 127.0.0.1:8080 {
           flush_interval -1           # streaming git/rawblob
       }
   }
   ```
8. `docker compose pull && docker compose up -d`; watch `docker compose logs -f forgehub` until healthy.
9. Smoke test: `curl https://forge.<domain>/health` → `{"ok":true}`.
10. Backups: cron `docker run --rm -v forgehub_forgehub-data:/data -v $PWD:/b alpine tar czf /b/forgehub-$(date +%F).tgz /data`. Volume `forgehub-data` = DB + all repos. Do one before demo.
11. Demo data: seed a user + org + a 3D repo (glTF) ahead of time; rehearse full flow (register → create repo → git push over HTTPS → PR → diff view).

## Risks / things to modify (ranked)
1. **No TLS in stack.** Compose only serves HTTP. Need Caddy/nginx+certbot (step 7). README itself says git credential helpers degrade on plain HTTP.
2. **`PUBLIC_URL` unset → emails link to `http://localhost:5173`.** Set it (step 5).
3. **Registered secrets.** `JWT_SECRET` required (>=16 chars) — compose refuses to start without it. Good. Also set `UNSUBSCRIBE_SECRET` (else falls back to JWT_SECRET / dev constant).
4. **Client IP behind proxy.** Fastify has no `trustProxy` → API sees proxy IP for every request (`request.ip` used in auth/session records). Cosmetic for demo; sessions list will show 127.0.0.1/docker IP. Fix later: enable `trustProxy` in `server.ts`.
5. **Postgres/MySQL path is weaker than SQLite.** Entrypoint uses `prisma db push` (no migration history) for those; README line ~438 still says Postgres unsupported — docs contradict compose files. Stay on SQLite for Wednesday.
6. **SSH git transport + VPS sshd both want port 22.** Use `FORGEHUB_SSH_PORT=2222`, uncomment `ports` block in `docker-compose.yml` (sqlite/mysql files have it commented; postgres file has it always on), open 2222 in ufw. Skip SSH entirely for demo if HTTPS push is enough.
7. **CI runner: keep `FORGEHUB_CI` empty.** Executes repo shell in the API container with access to secrets via `/proc/1/environ`. Fine only single-tenant. If demo needs CI, enable only with trusted users.
8. **CORS `origin: true`** reflects any origin. Same-origin deploy makes it moot; note for later hardening.
9. **Open registration** — anyone hitting the URL can sign up. No rate limit found on `/auth` routes (only SSH has one). Consider restricting via Caddy basic-auth or IP allowlist until demo time, or add Caddy rate limit.
10. **Entrypoint help text mentions compose service `api`**, but combined compose service is `forgehub` — chown/baseline hint commands would fail if copy-pasted. Docs fix only.
11. **Committed test artifacts**: `apps/api/git-storage/` and `apps/api/git-storage-e2e/` bare repos are tracked in git. Excluded from images by `.dockerignore`, but should be `git rm`'d (needs Toufic OK).
12. **Combined image runs as root** (documented trade-off). Separate-container layout (`apps/api/Dockerfile`, non-root uid 10001) is the safer alternative, but compose for it is not in repo root (only combined image is wired in compose).
13. **Image trust**: compose pulls `touficmajdalani/forgehub:latest`. Confirm the latest publish workflow run on `main` succeeded and image includes current code (last commit `7208933`). Pin to a `sha-<short>` tag for demo so it can't change under you.
14. **Arch**: images are amd64+arm64, fine for either VPS type.

## Test checklist on VPS (before Wednesday)
- [ ] `docker compose up -d` healthy, `/health` ok over HTTPS
- [ ] Register / login / logout, session revoke
- [ ] Create repo, `git clone`/`push` over HTTPS with PAT (large file ≥100 MB push)
- [ ] Upload glTF, view 3D diff, open PR, merge
- [ ] Issue + comment + notification (+ email if SMTP set)
- [ ] rawblob download of large file (streams via Caddy, no timeout)
- [ ] Restart VPS → `restart: unless-stopped` brings stack up, data persists
- [ ] Backup + restore into fresh volume works
- [ ] Container logs clean of stack traces

## Decisions needed from Toufic
- Domain name / DNS provider?
- Caddy (auto TLS, recommended) vs nginx+certbot?
- SSH git transport needed for demo? (default: no)
- SMTP provider needed? (default: no)
- OK to apply fixes #4 (trustProxy), #6/#10 (compose+doc tweaks), #11 (git rm test repos)?
