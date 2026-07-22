import { prisma } from "./prisma.js";
import { sendMail, type OutgoingEmail } from "./mailer.js";
import { signUnsubscribeToken } from "./unsubscribe.js";
import type { EventParams, NotificationReason } from "./notifications-service.js";

/**
 * Email sink for the notification fan-out. `sendNotificationEmail` is the
 * orchestrator called (fire-and-forget) from `notify()`: it gates on the
 * recipient's preference, resolves the subject's public URL + an unsubscribe
 * token, renders the message and hands it to the mailer. It NEVER throws — a
 * delivery failure is logged and swallowed so it can't fail the request that
 * created the notification. `renderNotificationEmail` is the pure renderer,
 * exposed for unit testing.
 */

/** Public origin used to build deep links + the unsubscribe URL. */
function publicBase(): string {
  return (process.env["PUBLIC_URL"]?.trim() || "http://localhost:5173").replace(/\/+$/, "");
}

const REASON_LEAD: Record<NotificationReason, string> = {
  ASSIGNED: "You were assigned",
  COMMENT: "There's a new comment",
  REVIEW_REQUESTED: "Your review was requested",
  SUBSCRIBED: "There's new activity",
  MENTIONED: "You were mentioned",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type RenderContext = {
  to: string;
  /** "owner/repo" */
  repoFullName: string;
  subjectTitle: string;
  /** "#12" for issues/PRs, the tag name for releases. */
  numberLabel: string;
  reason: NotificationReason;
  actorHandle: string | null;
  /** Absolute link to the subject. */
  link: string;
  /** Absolute one-click unsubscribe URL. */
  unsubscribeUrl: string;
};

/** Render a plain-text + minimal-HTML notification email. Pure. */
export function renderNotificationEmail(ctx: RenderContext): OutgoingEmail {
  const subject = `[${ctx.repoFullName}] ${ctx.subjectTitle} (${ctx.numberLabel})`;
  const actor = ctx.actorHandle ? `@${ctx.actorHandle}` : "Someone";
  const lead = REASON_LEAD[ctx.reason];

  const text = [
    `${lead} in ${ctx.repoFullName}.`,
    "",
    `${ctx.numberLabel} ${ctx.subjectTitle}`,
    `${actor} triggered this notification (${ctx.reason.toLowerCase().replace(/_/g, " ")}).`,
    "",
    `View it on ForgeHub: ${ctx.link}`,
    "",
    "—",
    "You are receiving this because email notifications are enabled for your ForgeHub account.",
    `Unsubscribe: ${ctx.unsubscribeUrl}`,
  ].join("\n");

  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;max-width:560px">`,
    `<p style="margin:0 0 12px">${escapeHtml(lead)} in <strong>${escapeHtml(ctx.repoFullName)}</strong>.</p>`,
    `<p style="margin:0 0 4px"><span style="color:#59636e">${escapeHtml(ctx.numberLabel)}</span> `,
    `<a href="${escapeHtml(ctx.link)}" style="color:#0969da;text-decoration:none;font-weight:600">${escapeHtml(ctx.subjectTitle)}</a></p>`,
    `<p style="margin:0 0 16px;color:#59636e">${escapeHtml(actor)} triggered this notification (${escapeHtml(ctx.reason.toLowerCase().replace(/_/g, " "))}).</p>`,
    `<p style="margin:0 0 20px"><a href="${escapeHtml(ctx.link)}" style="display:inline-block;padding:8px 16px;background:#1f883d;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">View on ForgeHub</a></p>`,
    `<hr style="border:none;border-top:1px solid #d1d9e0;margin:20px 0" />`,
    `<p style="margin:0;color:#59636e;font-size:12px">You are receiving this because email notifications are enabled for your ForgeHub account. `,
    `<a href="${escapeHtml(ctx.unsubscribeUrl)}" style="color:#59636e">Unsubscribe</a>.</p>`,
    `</div>`,
  ].join("");

  return {
    to: ctx.to,
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${ctx.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** Resolve the subject's display number/tag and its URL path segment. */
async function resolveSubjectLocator(p: EventParams): Promise<{ numberLabel: string; urlPath: string }> {
  if (p.subjectType === "ISSUE") {
    const issue = await prisma.issue.findUnique({ where: { id: p.subjectId }, select: { number: true } });
    const n = issue?.number;
    return n != null ? { numberLabel: `#${n}`, urlPath: `issues/${n}` } : { numberLabel: "#?", urlPath: "issues" };
  }
  if (p.subjectType === "PULL_REQUEST") {
    const pr = await prisma.pullRequest.findUnique({ where: { id: p.subjectId }, select: { number: true } });
    const n = pr?.number;
    return n != null ? { numberLabel: `#${n}`, urlPath: `pulls/${n}` } : { numberLabel: "#?", urlPath: "pulls" };
  }
  // RELEASE — no numeric id; deep-link to the releases tab, label with the tag.
  const rel = await prisma.release.findUnique({ where: { id: p.subjectId }, select: { tagName: true } });
  return { numberLabel: rel?.tagName ?? "release", urlPath: "releases" };
}

async function resolveActorHandle(actorId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: actorId }, select: { handle: true } });
  return user?.handle ?? null;
}

/**
 * Deliver a notification email to `userId` for the given event, if that user has
 * email notifications enabled. Fire-and-forget: all failures are swallowed so a
 * mail problem never fails the originating request.
 */
export async function sendNotificationEmail(userId: string, p: EventParams): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailNotifications: true },
    });
    if (!user || !user.emailNotifications || !user.email) return;

    const repo = await prisma.repo.findUnique({
      where: { id: p.repoId },
      select: { name: true, owner: { select: { handle: true } } },
    });
    if (!repo) return;
    const repoFullName = `${repo.owner.handle}/${repo.name}`;

    const { numberLabel, urlPath } = await resolveSubjectLocator(p);
    const link = `${publicBase()}/${repoFullName}/${urlPath}`;
    const actorHandle = await resolveActorHandle(p.actorId);
    const token = signUnsubscribeToken(userId);
    const unsubscribeUrl = `${publicBase()}/notifications/unsubscribe?token=${encodeURIComponent(token)}`;

    const email = renderNotificationEmail({
      to: user.email,
      repoFullName,
      subjectTitle: p.subjectTitle,
      numberLabel,
      reason: p.reason,
      actorHandle,
      link,
      unsubscribeUrl,
    });
    await sendMail(email);
  } catch (err) {
    // Never propagate: notification email is best-effort.
    console.error("[email-notify] failed to deliver notification email", err);
  }
}
