import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import { canRead, repoAccessInclude, resolveRepo } from "../repo-access.js";
import { openAttachment, writeAttachment } from "../git-storage.js";
import { detectImageType } from "./profile.js";
import { detectSocialPreviewType } from "./social-preview.js";
import { contentDisposition, sanitizeAssetName } from "./releases.js";

// ─── Comment attachments (#253) ─────────────────────────────────────────────────
//
// Images and files pasted, dropped or picked into a comment box, stored per
// repository and linked from the Markdown. The rules:
//   - Uploading takes what commenting takes: signed in, able to read the
//     repository, `repo:write` for a token; the archived and block guards apply.
//   - Reading takes what reading the repository takes; anyone else gets a 404.
//   - The type comes from the bytes, never the name or the client's MIME type:
//     PNG, JPEG, GIF and WebP images, shown inline; PDF, ZIP, GLB and UTF-8 text,
//     downloaded. Nothing a browser would run (HTML, SVG, scripts).
//   - Served with that stored type, nosniff, a sandboxing CSP, and cached for good
//     under a random id that never changes.

/** Images up to 10 MB, other files up to 25 MB, as on GitHub. */
export const ATTACHMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** The types taken, each with the extensions a download may keep; any other gets the first added. */
const EXTENSIONS: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "application/zip": ["zip"],
  "model/gltf-binary": ["glb"],
  "text/plain; charset=utf-8": ["txt", "log", "md", "csv"],
};

/** What the bytes are, when they're something attachments take; null otherwise. */
export function detectAttachmentType(buf: Buffer): string | null {
  const image = detectImageType(buf) ?? detectSocialPreviewType(buf);
  if (image) return image;
  const head = buf.toString("latin1", 0, 5);
  if (head === "%PDF-") return "application/pdf";
  if (head.startsWith("PK\x03\x04") || head.startsWith("PK\x05\x06")) return "application/zip";
  if (head.startsWith("glTF")) return "model/gltf-binary";
  return isPlainText(buf) ? "text/plain; charset=utf-8" : null;
}

/** UTF-8 without binary control characters (ESC stays, for coloured logs), and not markup. */
function isPlainText(buf: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  if (!text.trim() || /[\x00-\x08\x0e-\x1a\x1c-\x1f]/.test(text)) return false;
  // HTML, SVG and XML start with a tag; a syslog line's `<34>` doesn't.
  return !/^<[a-z!?/]/i.test(text.trimStart());
}

/** The file's name, ending in an extension that matches what it is, so a download opens as that. */
export function attachmentName(raw: string | undefined, contentType: string): string {
  const name = sanitizeAssetName(raw) ?? "file";
  const allowed = EXTENSIONS[contentType] ?? [];
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return allowed.includes(ext) ? name : `${name}.${allowed[0]}`;
}

export async function attachmentRoutes(app: FastifyInstance) {
  // POST /repos/:handle/:name/attachments — multipart, one file
  app.post(
    "/repos/:handle/:name/attachments",
    { preHandler: [app.authenticate, app.requireScope("repo:write")] },
    async (request, reply) => {
      const { handle, name } = request.params as { handle: string; name: string };
      const userId = request.user.sub;
      const repo = await resolveRepo(handle, name);
      if (!repo || !canRead(repo, userId)) return reply.status(404).send({ error: "Repository not found" });

      let data;
      try {
        data = await request.file({ limits: { fileSize: ATTACHMENT_FILE_MAX_BYTES }, throwFileSizeLimit: false });
      } catch {
        return reply.status(400).send({ error: "Invalid multipart upload" });
      }
      if (!data) return reply.status(400).send({ error: "A file is required" });
      const buf = await data.toBuffer();
      if (data.file.truncated) return reply.status(413).send({ error: "Files must be under 25 MB" });
      const contentType = detectAttachmentType(buf);
      if (!contentType) {
        return reply.status(400).send({ error: "Attach a PNG, JPG, GIF or WebP image, or a PDF, ZIP, GLB or text file" });
      }
      if (contentType.startsWith("image/") && buf.length > ATTACHMENT_IMAGE_MAX_BYTES) {
        return reply.status(413).send({ error: "Images must be under 10 MB" });
      }

      const id = randomBytes(16).toString("hex");
      const fileName = attachmentName(data.filename, contentType);
      await writeAttachment(repo.id, id, buf);
      await prisma.attachment.create({
        data: { id, repoId: repo.id, name: fileName, contentType, size: buf.length, uploadedById: userId },
      });
      return reply.status(201).send({ id, name: fileName, contentType, size: buf.length, url: `/attachments/${id}` });
    },
  );

  // GET /attachments/:id — the file, to anyone who can read its repository
  app.get("/attachments/:id", { preHandler: [app.optionalAuthenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const viewerId = (request as { user?: { sub: string } }).user?.sub;
    const attachment = /^[0-9a-f]{32}$/.test(id)
      ? await prisma.attachment.findUnique({ where: { id }, include: { repo: { include: repoAccessInclude } } })
      : null;
    if (!attachment || !canRead(attachment.repo, viewerId)) return reply.status(404).send({ error: "Not found" });

    let stream;
    try {
      stream = await openAttachment(attachment.repoId, attachment.id);
    } catch {
      return reply.status(404).send({ error: "Not found" });
    }
    const inline = attachment.contentType.startsWith("image/");
    return reply
      .header("Content-Type", attachment.contentType)
      .header("Content-Length", String(attachment.size))
      .header("Content-Disposition", contentDisposition(attachment.name, inline ? "inline" : "attachment"))
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      // The id names these bytes for good. Private: no shared cache keeps a repository's files after it goes private.
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("Vary", "Authorization")
      .send(stream);
  });
}
