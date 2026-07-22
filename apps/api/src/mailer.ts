import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Pluggable email delivery. Two transports:
 *
 *   • SMTP (nodemailer) — used when `SMTP_URL` or `SMTP_HOST` is configured.
 *     nodemailer is imported lazily so dev/test never load it.
 *   • DEV file transport — the default. Appends each rendered email as one JSON
 *     line to a mailbox file under the git storage root, so a self-hosted
 *     instance without SMTP still "delivers" somewhere inspectable, and tests
 *     can assert on the file.
 *
 * The transport is resolved once (memoised) from the environment; `__setTransport`
 * is a test seam for forcing a specific (or throwing) transport.
 */

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
};

export interface MailTransport {
  readonly kind: "smtp" | "dev";
  send(email: OutgoingEmail): Promise<void>;
}

// Mirrors git-storage.ts's storage-root resolution without importing it (keeps
// the mailer free of the git module and its side effects).
function storageRoot(): string {
  return process.env["GIT_STORAGE_ROOT"]?.trim() || path.resolve(process.cwd(), "git-storage");
}

/** Absolute path of the dev mailbox (JSONL). Overridable with `MAIL_DEV_FILE`. */
export function devMailboxPath(): string {
  const override = process.env["MAIL_DEV_FILE"]?.trim();
  if (override) return path.resolve(override);
  return path.join(path.resolve(storageRoot()), "mail-outbox.jsonl");
}

/** The `From:` address for outgoing mail. */
export function mailFromAddress(): string {
  return process.env["MAIL_FROM"]?.trim() || "ForgeHub <no-reply@forgehub.local>";
}

/** True when SMTP delivery is configured via the environment. */
export function isSmtpConfigured(): boolean {
  return Boolean(process.env["SMTP_URL"]?.trim() || process.env["SMTP_HOST"]?.trim());
}

// ─── DEV transport ────────────────────────────────────────────────────────────

class DevFileTransport implements MailTransport {
  readonly kind = "dev" as const;

  async send(email: OutgoingEmail): Promise<void> {
    const file = devMailboxPath();
    await mkdir(path.dirname(file), { recursive: true });
    const record = { ...email, from: mailFromAddress(), sentAt: new Date().toISOString() };
    await appendFile(file, JSON.stringify(record) + "\n", "utf8");
  }
}

// ─── SMTP transport (nodemailer, lazily loaded) ───────────────────────────────

type NodemailerTransporter = { sendMail(opts: Record<string, unknown>): Promise<unknown> };

class SmtpTransport implements MailTransport {
  readonly kind = "smtp" as const;
  private transporter: NodemailerTransporter | null = null;

  private async getTransporter(): Promise<NodemailerTransporter> {
    if (this.transporter) return this.transporter;
    const nodemailer = (await import("nodemailer")).default;
    const url = process.env["SMTP_URL"]?.trim();
    if (url) {
      this.transporter = nodemailer.createTransport(url) as unknown as NodemailerTransporter;
    } else {
      const user = process.env["SMTP_USER"]?.trim();
      const pass = process.env["SMTP_PASS"]?.trim();
      this.transporter = nodemailer.createTransport({
        host: process.env["SMTP_HOST"]?.trim(),
        port: Number(process.env["SMTP_PORT"] ?? 587),
        secure: process.env["SMTP_SECURE"]?.trim() === "true",
        auth: user ? { user, pass } : undefined,
      }) as unknown as NodemailerTransporter;
    }
    return this.transporter;
  }

  async send(email: OutgoingEmail): Promise<void> {
    const transporter = await this.getTransporter();
    await transporter.sendMail({
      from: mailFromAddress(),
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: email.headers,
    });
  }
}

// ─── Transport resolution ─────────────────────────────────────────────────────

let overrideTransport: MailTransport | null = null;
let cachedTransport: MailTransport | null = null;

/** The active transport: a test override, else the env-derived (memoised) one. */
export function getTransport(): MailTransport {
  if (overrideTransport) return overrideTransport;
  if (!cachedTransport) {
    cachedTransport = isSmtpConfigured() ? new SmtpTransport() : new DevFileTransport();
  }
  return cachedTransport;
}

/**
 * Test seam. Pass a transport to force it; pass `null` to clear both the
 * override and the memoised env transport so the next `getTransport()`
 * re-resolves from the current environment.
 */
export function __setTransport(t: MailTransport | null): void {
  overrideTransport = t;
  cachedTransport = null;
}

/** Deliver one email through the active transport. */
export async function sendMail(email: OutgoingEmail): Promise<void> {
  await getTransport().send(email);
}
