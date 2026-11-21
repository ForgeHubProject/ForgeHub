import { publicBase } from "./email-notify.js";
import { sendMail, type OutgoingEmail } from "./mailer.js";

/**
 * The email a person gets when someone wants to transfer a repository to them
 * (#256). Sent whatever their notification settings, as GitHub does: it's a
 * request only they can answer. The link opens their notifications, where it
 * waits with Accept and Decline.
 */
export type RepoTransferEmail = { to: string; fromHandle: string; repoFullName: string; expiresAt: Date };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Pure, for tests. */
export function renderRepoTransferEmail(m: RepoTransferEmail): OutgoingEmail {
  const link = `${publicBase()}/notifications`;
  const until = m.expiresAt.toUTCString();
  const subject = `@${m.fromHandle} wants to transfer ${m.repoFullName} to you`;
  const text = [
    `@${m.fromHandle} wants to transfer the repository ${m.repoFullName} to your account.`,
    "",
    `Accept or decline it here: ${link}`,
    "",
    `The request expires ${until}. Until you accept, the repository stays where it is.`,
  ].join("\n");
  const html = [
    `<p>@${escapeHtml(m.fromHandle)} wants to transfer the repository <strong>${escapeHtml(m.repoFullName)}</strong> to your account.</p>`,
    `<p><a href="${escapeHtml(link)}">Accept or decline it on ForgeHub</a></p>`,
    `<p style="color:#57606a">The request expires ${escapeHtml(until)}. Until you accept, the repository stays where it is.</p>`,
  ].join("\n");
  return { to: m.to, subject, text, html };
}

/** Best-effort: a mail problem never fails the transfer request. */
export async function sendRepoTransferEmail(m: RepoTransferEmail): Promise<void> {
  try {
    if (!m.to) return;
    await sendMail(renderRepoTransferEmail(m));
  } catch (err) {
    console.error("[repo-transfer-mail] failed to send the transfer request email", err);
  }
}
