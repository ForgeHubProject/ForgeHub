import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    notification: { findUnique: vi.fn(), upsert: vi.fn().mockResolvedValue(undefined) },
    user: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
    repo: { findUnique: vi.fn() },
    issue: { findUnique: vi.fn() },
    pullRequest: { findUnique: vi.fn() },
    release: { findUnique: vi.fn() },
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import { notifyUser, type EventParams } from "../notifications-service.js";
import { renderNotificationEmail, sendNotificationEmail } from "../email-notify.js";
import { __setTransport, type MailTransport, type OutgoingEmail } from "../mailer.js";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../unsubscribe.js";
import { notificationRoutes } from "../routes/notifications.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ISSUE_EVENT: EventParams = {
  actorId: "actor-2",
  repoId: "repo-1",
  subjectType: "ISSUE",
  subjectId: "issue-1",
  subjectTitle: "Fix the bug",
  reason: "MENTIONED",
};

/** Give fire-and-forget email sends (void'd in notify()) a chance to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
}

/** Wire prisma so a recipient with `emailNotifications` resolves an issue email. */
function wireRecipient(emailNotifications: boolean): void {
  vi.mocked(prisma.user.findUnique).mockImplementation(((args: { where: { id: string } }) => {
    if (args.where.id === "user-1") {
      return Promise.resolve({ email: "user1@example.com", emailNotifications });
    }
    if (args.where.id === "actor-2") return Promise.resolve({ handle: "actor2" });
    return Promise.resolve(null);
  }) as never);
  vi.mocked(prisma.repo.findUnique).mockResolvedValue({ name: "widget", owner: { handle: "alice" } } as never);
  vi.mocked(prisma.issue.findUnique).mockResolvedValue({ number: 12 } as never);
}

/** A transport that records everything it is asked to send. */
function capturingTransport(): { transport: MailTransport; sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    transport: {
      kind: "dev",
      send: (email) => {
        sent.push(email);
        return Promise.resolve();
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.notification.upsert).mockResolvedValue(undefined as never);
  vi.mocked(prisma.user.update).mockResolvedValue(undefined as never);
  delete process.env["SMTP_URL"];
  delete process.env["SMTP_HOST"];
  delete process.env["PUBLIC_URL"];
});

afterEach(() => {
  __setTransport(null);
  delete process.env["MAIL_DEV_FILE"];
  vi.restoreAllMocks();
});

// ─── Rendering (subject/body snapshot-ish) ────────────────────────────────────

describe("renderNotificationEmail", () => {
  const ctx = {
    to: "user1@example.com",
    repoFullName: "alice/widget",
    subjectTitle: "Fix the bug",
    numberLabel: "#12",
    reason: "MENTIONED" as const,
    actorHandle: "actor2",
    link: "https://forge.example/alice/widget/issues/12",
    unsubscribeUrl: "https://forge.example/notifications/unsubscribe?token=abc.def",
  };

  it("builds the '[owner/repo] <title> (#N)' subject", () => {
    expect(renderNotificationEmail(ctx).subject).toBe("[alice/widget] Fix the bug (#12)");
  });

  it("includes the deep link and unsubscribe URL in the plain-text body", () => {
    const { text } = renderNotificationEmail(ctx);
    expect(text).toContain("https://forge.example/alice/widget/issues/12");
    expect(text).toContain("Unsubscribe: https://forge.example/notifications/unsubscribe?token=abc.def");
    expect(text).toContain("You were mentioned");
  });

  it("renders HTML with the link and a reason-specific lead", () => {
    expect(renderNotificationEmail({ ...ctx, reason: "COMMENT" }).html).toContain("There's a new comment");
    const html = renderNotificationEmail(ctx).html;
    expect(html).toContain(`href="https://forge.example/alice/widget/issues/12"`);
    expect(html).toContain("actor2");
  });

  it("sets List-Unsubscribe + one-click headers", () => {
    const { headers } = renderNotificationEmail(ctx);
    expect(headers?.["List-Unsubscribe"]).toBe("<https://forge.example/notifications/unsubscribe?token=abc.def>");
    expect(headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("recipient is carried onto the message", () => {
    expect(renderNotificationEmail(ctx).to).toBe("user1@example.com");
  });
});

// ─── Dev-transport delivery + preference gating ───────────────────────────────

describe("sendNotificationEmail (dev file transport)", () => {
  let dir: string;
  let mailbox: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fh-mail-"));
    mailbox = path.join(dir, "outbox.jsonl");
    process.env["MAIL_DEV_FILE"] = mailbox;
    process.env["PUBLIC_URL"] = "https://forge.example";
    __setTransport(null); // re-resolve → DevFileTransport (no SMTP env)
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a rendered email to the dev file when the preference is ON", async () => {
    wireRecipient(true);
    await sendNotificationEmail("user-1", ISSUE_EVENT);

    const contents = await readFile(mailbox, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(1);
    const email = JSON.parse(lines[0]);
    expect(email.to).toBe("user1@example.com");
    expect(email.subject).toBe("[alice/widget] Fix the bug (#12)");
    expect(email.text).toContain("https://forge.example/alice/widget/issues/12");
    expect(email.text).toContain("/notifications/unsubscribe?token=");
    expect(email.headers["List-Unsubscribe"]).toContain("/notifications/unsubscribe?token=");
  });

  it("writes NOTHING to the dev file when the preference is OFF", async () => {
    wireRecipient(false);
    await sendNotificationEmail("user-1", ISSUE_EVENT);

    await expect(readFile(mailbox, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // repo/issue are never even queried once the pref gate rejects
    expect(prisma.repo.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Mail failure must never fail the originating request ──────────────────────

describe("mail failure isolation", () => {
  beforeEach(() => {
    wireRecipient(true);
    __setTransport({
      kind: "dev",
      send: () => Promise.reject(new Error("smtp exploded")),
    });
  });

  it("sendNotificationEmail swallows a throwing transport", async () => {
    await expect(sendNotificationEmail("user-1", ISSUE_EVENT)).resolves.toBeUndefined();
  });

  it("notify() (via notifyUser) still resolves when delivery throws", async () => {
    vi.mocked(prisma.notification.findUnique).mockResolvedValue(null as never);
    await expect(notifyUser("user-1", ISSUE_EVENT)).resolves.toBeUndefined();
    await flush();
    // Upsert (the in-app notification) still happened despite the mail failure.
    expect(prisma.notification.upsert).toHaveBeenCalledTimes(1);
  });
});

// ─── Transition-to-unread gating (no spam on micro-updates) ───────────────────

describe("notify() emails only on transition into unread", () => {
  beforeEach(() => {
    wireRecipient(true);
    process.env["PUBLIC_URL"] = "https://forge.example";
  });

  it("sends when the notification is brand new", async () => {
    const { transport, sent } = capturingTransport();
    __setTransport(transport);
    vi.mocked(prisma.notification.findUnique).mockResolvedValue(null as never);

    await notifyUser("user-1", ISSUE_EVENT);
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("sends when a previously-read notification goes unread again", async () => {
    const { transport, sent } = capturingTransport();
    __setTransport(transport);
    vi.mocked(prisma.notification.findUnique).mockResolvedValue({ read: true } as never);

    await notifyUser("user-1", ISSUE_EVENT);
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("does NOT send when the notification is already unread", async () => {
    const { transport, sent } = capturingTransport();
    __setTransport(transport);
    vi.mocked(prisma.notification.findUnique).mockResolvedValue({ read: false } as never);

    await notifyUser("user-1", ISSUE_EVENT);
    await flush();
    expect(sent).toHaveLength(0);
  });
});

// ─── Unsubscribe token roundtrip ──────────────────────────────────────────────

describe("unsubscribe token", () => {
  it("verifies a token it signed", () => {
    const token = signUnsubscribeToken("user-42");
    expect(verifyUnsubscribeToken(token)).toBe("user-42");
  });

  it("rejects a tampered signature", () => {
    const token = signUnsubscribeToken("user-42");
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("rejects a swapped user id (signature no longer matches)", () => {
    const [, sig] = signUnsubscribeToken("user-42").split(".");
    const forgedId = Buffer.from("user-99", "utf8").toString("base64url");
    expect(verifyUnsubscribeToken(`${forgedId}.${sig}`)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyUnsubscribeToken("garbage")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
  });
});

// ─── Unsubscribe endpoint ─────────────────────────────────────────────────────

describe("GET/POST /notifications/unsubscribe", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    app.decorate("authenticate", async () => {});
    await app.register(notificationRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("flips the preference off for a valid token (GET → 200 HTML)", async () => {
    const token = signUnsubscribeToken("user-1");
    const res = await app.inject({ method: "GET", url: `/notifications/unsubscribe?token=${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { emailNotifications: false },
    });
  });

  it("returns 400 and touches no user for a tampered token", async () => {
    const token = signUnsubscribeToken("user-1");
    const tampered = token.slice(0, -2) + "zz";
    const res = await app.inject({ method: "GET", url: `/notifications/unsubscribe?token=${encodeURIComponent(tampered)}` });
    expect(res.statusCode).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("supports RFC 8058 one-click POST", async () => {
    const token = signUnsubscribeToken("user-1");
    const res = await app.inject({
      method: "POST",
      url: "/notifications/unsubscribe",
      payload: { token },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { emailNotifications: false },
    });
  });

  it("POST with a bad token → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/notifications/unsubscribe",
      payload: { token: "nope" },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
