import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { writeAvatarBuffer, readAvatarBuffer, removeAvatar } from "../git-storage.js";

// ─── Profiles (issue #115): avatar upload/serve/delete + contribution graph ─────
//
// All new profile routes live in this file (kept separate from routes/auth.ts,
// whose auth/session surfaces are being reworked in parallel). Registered last in
// server.ts. The only auth.ts change is the single-line `avatarKey` addition to
// the user-payload builders.

/** Default avatar upload cap (2 MiB); overridable via AVATAR_MAX_BYTES. */
function avatarMaxBytes(): number {
  const raw = Number(process.env["AVATAR_MAX_BYTES"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 1024 * 1024;
}

/**
 * Detect the image type from its magic bytes (not the client-supplied
 * Content-Type, which is trivially spoofed). Only PNG / JPEG / WebP are accepted.
 */
export function detectImageType(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// ─── Contribution aggregation ───────────────────────────────────────────────────
//
// Source decision (issue #115): we aggregate authorship timestamps that already
// live in the DB — Issue, PullRequest, IssueComment, PullRequestComment, and the
// (submitted) PullRequestReview. Each row is a distinct authored artifact, so
// there is nothing to double-count. We deliberately do NOT also fold in
// TimelineEvent: its events (opened/closed/merged/commented/…) are *derived* from
// exactly these artifacts, so combining the two would double-count. Snapshots are
// skipped because the model carries no authorId. This keeps us to one activity
// pipeline (the caution raised in #88) without building a new event store.
//
// Visibility: activity in a private repo the viewer cannot read is EXCLUDED (the
// simpler correct choice over a separate privateCount) — the readable-repo filter
// is pushed into every query, so nothing leaks. Buckets are keyed by UTC date.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hard cap on the queried window so a hostile `from`/`to` can't scan forever. */
const MAX_RANGE_DAYS = 366;

export type ContributionDay = { date: string; count: number };
export type Contributions = { days: ContributionDay[]; total: number };

/** UTC `YYYY-MM-DD` key for a timestamp. */
function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket authorship timestamps into per-UTC-day counts. Returns only days that
 * have activity (sparse), sorted ascending; the client fills the empty cells of
 * the calendar grid. `total` is the sum of all counts.
 */
export function bucketContributions(timestamps: Date[]): Contributions {
  const counts = new Map<string, number>();
  for (const ts of timestamps) {
    if (!(ts instanceof Date) || Number.isNaN(ts.getTime())) continue;
    const key = utcDateKey(ts);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const days = [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const total = days.reduce((sum, d) => sum + d.count, 0);
  return { days, total };
}

/** Parse a `from`/`to` query into a bounded [from, to] UTC window. */
function resolveRange(fromQ?: string, toQ?: string): { from: Date; to: Date } {
  const now = Date.now();
  const parse = (s: string | undefined): number | null => {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  };
  let toMs = parse(toQ) ?? now;
  let fromMs = parse(fromQ) ?? toMs - 365 * DAY_MS;
  if (fromMs > toMs) [fromMs, toMs] = [toMs, fromMs];
  // Clamp the window so the per-table scans stay bounded.
  if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) fromMs = toMs - MAX_RANGE_DAYS * DAY_MS;
  return { from: new Date(fromMs), to: new Date(toMs) };
}

export async function profileRoutes(app: FastifyInstance) {
  // ── POST /users/me/avatar (multipart image upload) ──────────────────────────
  app.post("/users/me/avatar", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;

    let data;
    try {
      data = await request.file({ limits: { fileSize: avatarMaxBytes() }, throwFileSizeLimit: false });
    } catch {
      return reply.status(400).send({ error: "Invalid multipart upload" });
    }
    if (!data) return reply.status(400).send({ error: "An image file is required" });

    const buf = await data.toBuffer();
    if (data.file.truncated) {
      return reply.status(413).send({ error: "Avatar exceeds the maximum allowed size" });
    }

    const kind = detectImageType(buf);
    if (!kind) {
      return reply.status(400).send({ error: "Avatar must be a PNG, JPEG, or WebP image" });
    }

    await writeAvatarBuffer(userId, buf);
    // Rotate the cache-buster token on every upload so stale avatars can't linger
    // in a browser/proxy cache.
    const avatarKey = randomBytes(8).toString("hex");
    await prisma.user.update({ where: { id: userId }, data: { avatarKey } });

    return reply.status(201).send({ avatarKey, contentType: kind, size: buf.length });
  });

  // ── DELETE /users/me/avatar (clear) ─────────────────────────────────────────
  app.delete("/users/me/avatar", { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = request.user.sub;
    await removeAvatar(userId).catch(() => {});
    await prisma.user.update({ where: { id: userId }, data: { avatarKey: null } });
    return reply.status(204).send();
  });

  // ── GET /users/:handle/avatar?s=64 (serve bytes) ────────────────────────────
  //
  // No server-side resizing (that would need an image dependency such as sharp,
  // which is explicitly off the table). We serve the original bytes and let the
  // browser scale them via the width/height it renders at; `s` is accepted for
  // forward-compat + as a cache key but does not change the returned bytes. The
  // avatar is public metadata, so a long immutable cache is safe — the URL carries
  // the rotating `avatarKey` as a cache-buster, so a new upload is picked up.
  app.get("/users/:handle/avatar", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const user = await prisma.user.findUnique({
      where: { handle: handle.toLowerCase() },
      select: { id: true, avatarKey: true },
    });
    if (!user || !user.avatarKey) return reply.status(404).send({ error: "No avatar" });

    let buf: Buffer;
    try {
      buf = await readAvatarBuffer(user.id);
    } catch {
      return reply.status(404).send({ error: "No avatar" });
    }
    const contentType = detectImageType(buf) ?? "application/octet-stream";
    return reply
      .header("Content-Type", contentType)
      .header("Content-Length", String(buf.length))
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .header("ETag", `"${user.avatarKey}"`)
      .send(buf);
  });

  // ── GET /users/:handle/contributions?from=&to= ──────────────────────────────
  app.get("/users/:handle/contributions", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const { from: fromQ, to: toQ } = request.query as { from?: string; to?: string };
    const viewerId = (request as { user?: { sub: string } }).user?.sub;

    const user = await prisma.user.findUnique({
      where: { handle: handle.toLowerCase() },
      select: { id: true },
    });
    if (!user) return reply.status(404).send({ error: "User not found" });

    const { from, to } = resolveRange(fromQ, toQ);

    // Repo-visibility predicate pushed into every query: a repo is readable when
    // it is PUBLIC, owned by the viewer, or the viewer is a collaborator. Guests
    // see PUBLIC only. Private activity the viewer can't read never leaves the DB.
    const readableRepo = {
      OR: [
        { visibility: "PUBLIC" as const },
        ...(viewerId
          ? [{ ownerId: viewerId }, { collaborators: { some: { userId: viewerId } } }]
          : []),
      ],
    };

    const range = { gte: from, lte: to };
    const [issues, pulls, issueComments, prComments, prReviews] = await Promise.all([
      prisma.issue.findMany({
        where: { authorId: user.id, createdAt: range, repo: readableRepo },
        select: { createdAt: true },
      }),
      prisma.pullRequest.findMany({
        where: { authorId: user.id, createdAt: range, repo: readableRepo },
        select: { createdAt: true },
      }),
      prisma.issueComment.findMany({
        where: { authorId: user.id, createdAt: range, issue: { repo: readableRepo } },
        select: { createdAt: true },
      }),
      prisma.pullRequestComment.findMany({
        where: { authorId: user.id, createdAt: range, pullRequest: { repo: readableRepo } },
        select: { createdAt: true },
      }),
      prisma.pullRequestReview.findMany({
        where: { authorId: user.id, submittedAt: range, pullRequest: { repo: readableRepo } },
        select: { submittedAt: true },
      }),
    ]);

    const timestamps: Date[] = [
      ...issues.map((r) => r.createdAt),
      ...pulls.map((r) => r.createdAt),
      ...issueComments.map((r) => r.createdAt),
      ...prComments.map((r) => r.createdAt),
      ...prReviews.map((r) => r.submittedAt).filter((d): d is Date => d != null),
    ];

    const { days, total } = bucketContributions(timestamps);
    return { days, total, from: from.toISOString(), to: to.toISOString() };
  });
}
