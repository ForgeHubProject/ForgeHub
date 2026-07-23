import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { prisma } from "./prisma.js";

/**
 * Outbound webhook engine (issue #87).
 *
 * `emitRepoEvent` is the single entry point mutation sites call. It fans a
 * repo event out to every active hook subscribed to it, signs the body per hook,
 * POSTs it, and records EVERY attempt in `WebhookDelivery`. It is best-effort and
 * fire-and-forget by design — exactly like the notification/mailer side-channel:
 * a delivery failure (or a whole broken hook) can never fail the request that
 * emitted the event.
 *
 * Wire format (X-ForgeHub-Hook-Version: 1):
 *   POST <hook.url>
 *   Content-Type: application/json
 *   X-ForgeHub-Event: push | issues | issue_comment | pull_request | release | ping
 *   X-ForgeHub-Delivery: <uuid>                       (the WebhookDelivery row id)
 *   X-ForgeHub-Hook-Version: 1
 *   X-ForgeHub-Signature-256: sha256=<hex>            (HMAC-SHA256 of the raw body)
 *
 *   body = {
 *     event, action?, hookVersion, sentAt,
 *     repo:   { id, name, fullName, owner },
 *     sender: { handle } | null,
 *     <subjectKey>: { … }            // issue | pull_request | release | push
 *   }
 */

export const HOOK_VERSION = 1;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries

export type WebhookEventName = "push" | "issues" | "issue_comment" | "pull_request" | "release" | "ping";

const SUBJECT_KEY: Record<WebhookEventName, string> = {
  push: "push",
  issues: "issue",
  issue_comment: "issue_comment",
  pull_request: "pull_request",
  release: "release",
  ping: "hook",
};

export type EmitEventParams = {
  repoId: string;
  event: WebhookEventName;
  /** e.g. "opened" | "closed" | "merged" | "published". */
  action?: string;
  /** Actor id — its handle is resolved when `senderHandle` isn't supplied. */
  senderId?: string | null;
  senderHandle?: string | null;
  /** The event subject, nested under a per-event key. */
  subject?: Record<string, unknown>;
};

// ─── Signature ────────────────────────────────────────────────────────────────

/** `sha256=<hex>` HMAC-SHA256 of the raw body under the hook secret. */
export function signBody(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

// ─── SSRF guard ───────────────────────────────────────────────────────────────

/** Self-hosters can allow private targets (e.g. an in-cluster service). */
export function allowPrivateWebhooks(): boolean {
  const v = process.env["ALLOW_PRIVATE_WEBHOOKS"]?.trim();
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * Is this resolved IP literal in a loopback / private / link-local / reserved
 * range that a webhook must not reach? Pure (no DNS) — exposed for testing.
 */
export function ipIsBlocked(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4IsBlocked(ip);
  if (kind === 6) return ipv6IsBlocked(ip.toLowerCase());
  return true; // not a parseable IP → refuse
}

function ipv4IsBlocked(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6IsBlocked(ip: string): boolean {
  if (ip === "::1" || ip === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) → judge on the embedded v4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsBlocked(mapped[1]);
  if (ip.startsWith("fe80")) return true; // link-local
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // unique-local fc00::/7
  return false;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Resolve `url` and reject it if it targets a blocked address (unless
 * ALLOW_PRIVATE_WEBHOOKS is set). Literal-IP hosts are judged directly; named
 * hosts are DNS-resolved and every returned address must be public.
 */
export async function assertDeliverableUrl(url: string): Promise<GuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol}` };
  }
  if (allowPrivateWebhooks()) return { ok: true };

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    return ipIsBlocked(host) ? { ok: false, reason: `blocked address ${host}` } : { ok: true };
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: `dns resolution failed for ${host}` };
  }
  if (addrs.length === 0) return { ok: false, reason: `no address for ${host}` };
  const blocked = addrs.find((a) => ipIsBlocked(a.address));
  if (blocked) return { ok: false, reason: `blocked address ${blocked.address}` };
  return { ok: true };
}

// ─── Single attempt ───────────────────────────────────────────────────────────

type AttemptResult = {
  ok: boolean;
  statusCode: number | null;
  durationMs: number;
  error: string | null;
  /** Whether a retry could plausibly succeed (network error / 5xx). */
  retryable: boolean;
};

/** Perform ONE POST attempt (guard → fetch with timeout). Never throws. */
async function deliverOnce(
  hook: { url: string; secret: string },
  event: string,
  deliveryId: string,
  body: string,
): Promise<AttemptResult> {
  const guard = await assertDeliverableUrl(hook.url);
  if (!guard.ok) {
    return { ok: false, statusCode: null, durationMs: 0, error: `SSRF guard: ${guard.reason}`, retryable: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ForgeHub-Hookshot/1",
        "X-ForgeHub-Event": event,
        "X-ForgeHub-Delivery": deliveryId,
        "X-ForgeHub-Hook-Version": String(HOOK_VERSION),
        "X-ForgeHub-Signature-256": signBody(hook.secret, body),
      },
      body,
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      statusCode: res.status,
      durationMs,
      error: ok ? null : `HTTP ${res.status}`,
      retryable: res.status >= 500,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      statusCode: null,
      durationMs,
      error: aborted ? `timeout after ${DELIVERY_TIMEOUT_MS}ms` : (err instanceof Error ? err.message : "network error"),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function recordDelivery(params: {
  id: string;
  webhookId: string;
  event: string;
  body: string;
  result: AttemptResult;
  redeliveredFromId: string | null;
}) {
  return prisma.webhookDelivery.create({
    data: {
      id: params.id,
      webhookId: params.webhookId,
      event: params.event,
      payload: params.body,
      statusCode: params.result.statusCode,
      ok: params.result.ok,
      durationMs: params.result.durationMs,
      error: params.result.error,
      redeliveredFromId: params.redeliveredFromId,
    },
  });
}

// Retry backoff (ms) between attempts. Overridable so tests don't wait.
let retryDelaysMs = [500, 1500];
/** Test seam: shorten (or zero) the retry backoff. */
export function __setRetryDelaysMs(delays: number[]): void {
  retryDelaysMs = delays;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deliver to one hook with the v0 retry policy: up to 3 attempts, retrying only
 * network failures / 5xx (never 4xx or an SSRF block). EVERY attempt is recorded.
 */
async function deliverWithRetries(
  hook: { id: string; url: string; secret: string },
  event: string,
  body: string,
  opts: { redeliveredFromId?: string } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const deliveryId = randomUUID();
    const result = await deliverOnce(hook, event, deliveryId, body);
    await recordDelivery({
      id: deliveryId,
      webhookId: hook.id,
      event,
      body,
      result,
      redeliveredFromId: opts.redeliveredFromId ?? null,
    }).catch((err) => console.error("[webhook-service] failed to record delivery", err));
    if (result.ok || !result.retryable) return;
    if (attempt < MAX_ATTEMPTS) await sleep(retryDelaysMs[attempt - 1] ?? 0);
  }
}

// ─── Envelope ─────────────────────────────────────────────────────────────────

async function buildEnvelopeBody(p: EmitEventParams): Promise<string | null> {
  const repo = await prisma.repo.findUnique({
    where: { id: p.repoId },
    select: { name: true, owner: { select: { handle: true } } },
  });
  if (!repo) return null;

  let senderHandle = p.senderHandle ?? null;
  if (!senderHandle && p.senderId) {
    const user = await prisma.user.findUnique({ where: { id: p.senderId }, select: { handle: true } });
    senderHandle = user?.handle ?? null;
  }

  const owner = repo.owner.handle;
  const payload: Record<string, unknown> = {
    event: p.event,
    ...(p.action ? { action: p.action } : {}),
    hookVersion: HOOK_VERSION,
    sentAt: new Date().toISOString(),
    repo: { id: p.repoId, name: repo.name, fullName: `${owner}/${repo.name}`, owner },
    sender: senderHandle ? { handle: senderHandle } : null,
  };
  if (p.subject) payload[SUBJECT_KEY[p.event]] = p.subject;
  return JSON.stringify(payload);
}

/** Which subscribed events a hook's `events` column matches ("*" = all). */
export function hookSubscribesTo(events: string, event: string): boolean {
  const list = events.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes("*") || list.includes(event);
}

// ─── Public entry points ────────────────────────────────────────────────────────

/**
 * Emit one repo event to all active, subscribed hooks. Best-effort: resolves +
 * signs once, delivers in parallel, records every attempt, and swallows all
 * errors so the caller (a route mutation) is never affected.
 */
export async function emitRepoEvent(p: EmitEventParams): Promise<void> {
  try {
    const hooks = await prisma.webhook.findMany({ where: { repoId: p.repoId, active: true } });
    const targets = hooks.filter((h) => hookSubscribesTo(h.events, p.event));
    if (targets.length === 0) return;

    const body = await buildEnvelopeBody(p);
    if (body === null) return;

    await Promise.all(targets.map((h) => deliverWithRetries(h, p.event, body)));
  } catch (err) {
    console.error("[webhook-service] emitRepoEvent failed", err);
  }
}

/**
 * Manually replay a past delivery (the settings "Redeliver" button). Re-sends the
 * exact stored body as a SINGLE new attempt tagged `redeliveredFromId`, so the
 * response is immediate. Returns the new delivery row, or null if the source is
 * gone.
 */
export async function redeliverWebhookDelivery(deliveryId: string) {
  const src = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });
  if (!src) return null;

  const newId = randomUUID();
  const result = await deliverOnce(src.webhook, src.event, newId, src.payload);
  return recordDelivery({
    id: newId,
    webhookId: src.webhookId,
    event: src.event,
    body: src.payload,
    result,
    redeliveredFromId: src.id,
  });
}

/**
 * Deliver a one-off "ping" to a specific hook (used right after creation to prove
 * the endpoint is reachable). Best-effort; returns the recorded attempt or null.
 */
export async function pingWebhook(hookId: string) {
  const hook = await prisma.webhook.findUnique({ where: { id: hookId } });
  if (!hook) return null;
  const body = await buildEnvelopeBody({
    repoId: hook.repoId,
    event: "ping",
    subject: { message: "Webhook created — this is a test delivery." },
  });
  if (body === null) return null;
  const id = randomUUID();
  const result = await deliverOnce(hook, "ping", id, body);
  return recordDelivery({ id, webhookId: hook.id, event: "ping", body, result, redeliveredFromId: null });
}

// ─── Bridge: issue lifecycle via the shared timeline service ───────────────────

/**
 * Map an ISSUE timeline event kind → webhook `issues` action. Issue mutation
 * routes (`routes/issues.ts`) are owned by a sibling feature this round, so
 * rather than editing them we subscribe to the shared `recordEvent` choke point
 * they already call. (push / pull_request / release are wired at their own
 * routes directly.)
 */
const ISSUE_KIND_TO_ACTION: Record<string, string> = {
  closed: "closed",
  reopened: "reopened",
  assigned: "assigned",
  unassigned: "unassigned",
  labeled: "labeled",
  unlabeled: "unlabeled",
  title_changed: "edited",
};

export async function webhookBridgeForTimelineEvent(p: {
  repoId: string;
  subjectType: "ISSUE" | "PULL_REQUEST";
  subjectNumber: number;
  kind: string;
  actorId: string;
  actorHandle: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  if (p.subjectType !== "ISSUE") return; // PRs emit directly from routes/pulls.ts
  const action = ISSUE_KIND_TO_ACTION[p.kind];
  if (!action) return;
  await emitRepoEvent({
    repoId: p.repoId,
    event: "issues",
    action,
    senderId: p.actorId,
    senderHandle: p.actorHandle,
    subject: { number: p.subjectNumber, action, ...(p.data ?? {}) },
  });
}
