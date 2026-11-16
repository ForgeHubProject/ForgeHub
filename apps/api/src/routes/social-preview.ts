import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../prisma.js";
import { canAdmin, canRead, repoByOwningHandleWhere, resolveRepo } from "../repo-access.js";
import { readSocialPreview, removeSocialPreview, writeSocialPreview } from "../git-storage.js";
import { detectImageType } from "./profile.js";

// ─── Social preview (#256) ──────────────────────────────────────────────────────
//
// GitHub's Settings → General → Social preview: an image a repository's admins
// upload, shown wherever a link to the repository is shared. Those link
// previews come from services that fetch the page without running the app, so
// nginx sends their requests here (`/_preview/<page path>`, an internal
// location): a page with only the title, description and image tags.

/** GitHub's limit: under 1 MB. */
export const SOCIAL_PREVIEW_MAX_BYTES = 1024 * 1024;

/** PNG, JPEG or GIF, by magic bytes: the formats GitHub takes, and every link preview shows. */
export function detectSocialPreviewType(buf: Buffer): "image/png" | "image/jpeg" | "image/gif" | null {
  const kind = detectImageType(buf);
  if (kind === "image/png" || kind === "image/jpeg") return kind;
  const head = buf.toString("ascii", 0, 6);
  return head === "GIF87a" || head === "GIF89a" ? "image/gif" : null;
}

/** The site's own address, for the absolute URLs link previews need. */
function siteOrigin(request: FastifyRequest): string {
  const configured = process.env["PUBLIC_URL"]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const forwarded = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  return `${forwarded || request.protocol}://${request.headers.host ?? "localhost"}`;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A description fit for a card: one line, at most ~200 characters. */
function summary(text: string | null | undefined): string | null {
  const flat = (text ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > 200 ? `${flat.slice(0, 197).trimEnd()}…` : flat;
}

/** `site` marks the site's own card: the path named nothing anyone may see. */
type Card = { title: string; description: string; image: string | null; largeImage: boolean; site?: boolean };

/** What a shared link to `segments` shows; the site's own card for anything else. */
async function cardFor(segments: string[], origin: string): Promise<Card> {
  const site: Card = {
    title: "ForgeHub",
    description: "Version control for code, 3D models, designs and the rest of a project's files.",
    image: null,
    largeImage: false,
    site: true,
  };
  const [owner, name, section, number] = segments;
  if (!owner) return site;

  if (!name) {
    const user = await prisma.user.findUnique({
      where: { handle: owner.toLowerCase() },
      select: { handle: true, displayName: true, bio: true, avatarKey: true },
    });
    if (user) {
      return {
        title: user.displayName ? `${user.displayName} (${user.handle})` : user.handle,
        description: summary(user.bio) ?? `${user.handle} has repositories on ForgeHub.`,
        image: user.avatarKey ? `${origin}/users/${user.handle}/avatar?v=${user.avatarKey}` : null,
        largeImage: false,
      };
    }
    const org = await prisma.organization.findUnique({ where: { handle: owner.toLowerCase() }, select: { handle: true, description: true } });
    if (org) return { ...site, site: false, title: org.handle, description: summary(org.description) ?? `${org.handle} on ForgeHub.` };
    return site;
  }

  const repo = await prisma.repo.findFirst({
    where: repoByOwningHandleWhere(owner, name),
    include: {
      owner: { select: { handle: true, avatarKey: true } },
      org: { select: { handle: true } },
    },
  });
  // Signed out, as the link preview is: a private repository is nobody's business.
  if (!repo || repo.visibility !== "PUBLIC") return site;

  const fullName = `${repo.org?.handle ?? repo.owner.handle}/${repo.name}`;
  const image = repo.socialPreviewKey
    ? `${origin}/repos/${fullName}/social-preview?v=${repo.socialPreviewKey}`
    : !repo.orgId && repo.owner.avatarKey
      ? `${origin}/users/${repo.owner.handle}/avatar?v=${repo.owner.avatarKey}`
      : null;
  const card: Card = {
    title: fullName,
    description: summary(repo.description) ?? `Contribute to ${fullName} on ForgeHub.`,
    image,
    largeImage: Boolean(repo.socialPreviewKey),
  };

  const n = Number(number);
  if (Number.isInteger(n) && n > 0 && (section === "pulls" || section === "issues")) {
    const item =
      section === "pulls"
        ? await prisma.pullRequest.findFirst({ where: { repoId: repo.id, number: n }, select: { title: true, description: true } })
            .then((p) => p && { title: p.title, body: p.description })
        : await prisma.issue.findFirst({ where: { repoId: repo.id, number: n }, select: { title: true, body: true } });
    if (item) {
      return {
        ...card,
        title: `${item.title} · ${section === "pulls" ? "Pull request" : "Issue"} #${n} · ${fullName}`,
        description: summary(item.body) ?? card.description,
      };
    }
  }
  return card;
}

function cardPage(card: Card, url: string): string {
  const meta = (attr: "property" | "name", key: string, value: string) =>
    `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(card.title)}</title>`,
    meta("name", "description", card.description),
    meta("property", "og:site_name", "ForgeHub"),
    meta("property", "og:type", "website"),
    meta("property", "og:title", card.title),
    meta("property", "og:description", card.description),
    meta("property", "og:url", url),
    ...(card.image ? [meta("property", "og:image", card.image), meta("name", "twitter:image", card.image)] : []),
    meta("name", "twitter:card", card.largeImage ? "summary_large_image" : "summary"),
    meta("name", "twitter:title", card.title),
    meta("name", "twitter:description", card.description),
    "</head><body>",
    `<p><a href="${escapeHtml(url)}">${escapeHtml(card.title)}</a></p>`,
    "</body></html>",
  ].join("\n");
}

export async function socialPreviewRoutes(app: FastifyInstance) {
  const adminScope = app.requireScope("admin");

  /** The repository, when the caller administers it; the reply is sent otherwise. */
  async function adminRepo(request: FastifyRequest, reply: FastifyReply) {
    const { handle, name } = request.params as { handle: string; name: string };
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, request.user.sub)) {
      reply.status(404).send({ error: "Repository not found" });
      return null;
    }
    if (!canAdmin(repo, request.user.sub)) {
      reply.status(403).send({ error: "Only the repository's admins can change its social preview" });
      return null;
    }
    return repo;
  }

  // POST /repos/:handle/:name/social-preview — multipart image upload
  app.post("/repos/:handle/:name/social-preview", { preHandler: [app.authenticate, adminScope] }, async (request, reply) => {
    const repo = await adminRepo(request, reply);
    if (!repo) return reply;

    let data;
    try {
      data = await request.file({ limits: { fileSize: SOCIAL_PREVIEW_MAX_BYTES }, throwFileSizeLimit: false });
    } catch {
      return reply.status(400).send({ error: "Invalid multipart upload" });
    }
    if (!data) return reply.status(400).send({ error: "An image file is required" });
    const buf = await data.toBuffer();
    if (data.file.truncated) return reply.status(413).send({ error: "The image must be under 1 MB" });
    const kind = detectSocialPreviewType(buf);
    if (!kind) return reply.status(400).send({ error: "The image must be a PNG, JPG or GIF" });

    await writeSocialPreview(repo.id, buf);
    // A new key per upload, so link previews and browsers pick up the new image.
    const socialPreviewKey = randomBytes(8).toString("hex");
    await prisma.repo.update({ where: { id: repo.id }, data: { socialPreviewKey } });
    return reply.status(201).send({ socialPreviewKey, contentType: kind, size: buf.length });
  });

  // DELETE /repos/:handle/:name/social-preview
  app.delete("/repos/:handle/:name/social-preview", { preHandler: [app.authenticate, adminScope] }, async (request, reply) => {
    const repo = await adminRepo(request, reply);
    if (!repo) return reply;
    await prisma.repo.update({ where: { id: repo.id }, data: { socialPreviewKey: null } });
    await removeSocialPreview(repo.id).catch(() => {});
    return reply.status(204).send();
  });

  // GET /repos/:handle/:name/social-preview — the image, to anyone who can read the repository
  app.get("/repos/:handle/:name/social-preview", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { handle, name } = request.params as { handle: string; name: string };
    const { v } = request.query as { v?: string };
    const viewerId = (request as { user?: { sub: string } }).user?.sub;
    const repo = await resolveRepo(handle, name);
    if (!repo || !canRead(repo, viewerId)) return reply.status(404).send({ error: "Repository not found" });
    if (!repo.socialPreviewKey) return reply.status(404).send({ error: "No social preview" });

    let buf: Buffer;
    try {
      buf = await readSocialPreview(repo.id);
    } catch {
      return reply.status(404).send({ error: "No social preview" });
    }
    // The ?v= URL is unique to this upload, so it never changes; without it, recheck soon.
    const scope = repo.visibility === "PUBLIC" ? "public" : "private";
    const cache = v === repo.socialPreviewKey ? `${scope}, max-age=31536000, immutable` : `${scope}, max-age=300`;
    return reply
      .header("Content-Type", detectSocialPreviewType(buf) ?? "application/octet-stream")
      .header("Content-Length", String(buf.length))
      .header("Cache-Control", cache)
      .header("ETag", `"${repo.socialPreviewKey}"`)
      .send(buf);
  });

  // GET /_preview/<page path> — what a link preview reads (nginx: internal only)
  app.get("/_preview/*", async (request, reply) => {
    const { "*": rest = "" } = request.params as { "*"?: string };
    // Fastify hands the path over decoded.
    const segments = rest.split("/").filter(Boolean);
    const origin = siteOrigin(request);
    const card = await cardFor(segments, origin);
    // The site's card links home, not back to a path it has nothing to say about.
    const url = card.site ? `${origin}/` : `${origin}/${segments.map(encodeURIComponent).join("/")}`;
    return reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .send(cardPage(card, url));
  });
}
