import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../prisma.js", () => ({
  prisma: {
    webhook: { findMany: vi.fn(), findUnique: vi.fn() },
    webhookDelivery: { create: vi.fn(), findUnique: vi.fn() },
    repo: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from "../prisma.js";
import {
  signBody, ipIsBlocked, assertDeliverableUrl, hookSubscribesTo,
  emitRepoEvent, redeliverWebhookDelivery, __setRetryDelaysMs,
} from "../webhook-service.js";

type Hook = { id: string; repoId: string; url: string; secret: string; events: string; active: boolean };

function hook(overrides: Partial<Hook> = {}): Hook {
  return { id: "h1", repoId: "r1", url: "http://hook.internal/x", secret: "s3cr3t", events: "*", active: true, ...overrides };
}

/** Capture the recorded delivery rows' `data` payloads. */
function recordedRows() {
  return vi.mocked(prisma.webhookDelivery.create).mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
}

beforeEach(() => {
  vi.clearAllMocks();
  __setRetryDelaysMs([0, 0]); // no waiting in tests
  process.env["ALLOW_PRIVATE_WEBHOOKS"] = "1"; // let emit tests use internal URLs (guard is tested separately)
  vi.mocked(prisma.webhookDelivery.create).mockImplementation(((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ createdAt: new Date(), ...args.data })) as never);
  vi.mocked(prisma.repo.findUnique).mockResolvedValue({ name: "widget", owner: { handle: "alice" } } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ handle: "bob" } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env["ALLOW_PRIVATE_WEBHOOKS"];
});

// ─── Signature (known vector) ─────────────────────────────────────────────────

describe("signBody", () => {
  it("matches the documented HMAC-SHA256 known vector", () => {
    // GitHub's published example: secret + "Hello, World!"
    expect(signBody("It's a Secret to Everybody", "Hello, World!")).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
  });

  it("changes with the secret and with the body", () => {
    expect(signBody("a", "body")).not.toBe(signBody("b", "body"));
    expect(signBody("a", "body1")).not.toBe(signBody("a", "body2"));
  });
});

// ─── SSRF guard ───────────────────────────────────────────────────────────────

describe("ipIsBlocked", () => {
  it("blocks loopback / private / link-local / reserved", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.1.1", "0.0.0.0", "100.64.0.1", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(ipIsBlocked(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(ipIsBlocked(ip), ip).toBe(false);
    }
  });

  it("refuses non-IP strings", () => {
    expect(ipIsBlocked("not-an-ip")).toBe(true);
  });
});

describe("assertDeliverableUrl", () => {
  beforeEach(() => { delete process.env["ALLOW_PRIVATE_WEBHOOKS"]; });

  it("rejects loopback / private / link-local literals", async () => {
    for (const url of ["http://127.0.0.1:3000/x", "http://10.1.2.3/hook", "https://192.168.0.5/h", "http://169.254.169.254/latest"]) {
      expect((await assertDeliverableUrl(url)).ok, url).toBe(false);
    }
  });

  it("allows a public literal address", async () => {
    expect((await assertDeliverableUrl("https://8.8.8.8/hook")).ok).toBe(true);
  });

  it("rejects non-http(s) protocols", async () => {
    expect((await assertDeliverableUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await assertDeliverableUrl("ftp://8.8.8.8/x")).ok).toBe(false);
  });

  it("rejects a malformed URL", async () => {
    expect((await assertDeliverableUrl("::::")).ok).toBe(false);
  });

  it("ALLOW_PRIVATE_WEBHOOKS=1 overrides the guard", async () => {
    process.env["ALLOW_PRIVATE_WEBHOOKS"] = "1";
    expect((await assertDeliverableUrl("http://127.0.0.1:3000/x")).ok).toBe(true);
  });
});

// ─── Subscription matching ────────────────────────────────────────────────────

describe("hookSubscribesTo", () => {
  it("'*' matches every event", () => {
    expect(hookSubscribesTo("*", "push")).toBe(true);
    expect(hookSubscribesTo("*", "release")).toBe(true);
  });
  it("a list matches only its members", () => {
    expect(hookSubscribesTo("push,issues", "push")).toBe(true);
    expect(hookSubscribesTo("push,issues", "release")).toBe(false);
  });
});

// ─── emitRepoEvent: delivery, signing, recording, retry ───────────────────────

describe("emitRepoEvent", () => {
  it("delivers a signed envelope to a subscribed hook and records success", async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([hook({ events: "issues" })] as never);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await emitRepoEvent({ repoId: "r1", event: "issues", action: "closed", senderId: "u1", subject: { number: 5 } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("http://hook.internal/x");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-ForgeHub-Event"]).toBe("issues");
    expect(opts.headers["X-ForgeHub-Hook-Version"]).toBe("1");
    expect(typeof opts.headers["X-ForgeHub-Delivery"]).toBe("string");
    // Signature is HMAC of the exact raw body under the hook secret.
    expect(opts.headers["X-ForgeHub-Signature-256"]).toBe(signBody("s3cr3t", opts.body as string));

    const body = JSON.parse(opts.body as string);
    expect(body.event).toBe("issues");
    expect(body.action).toBe("closed");
    expect(body.repo.fullName).toBe("alice/widget");
    expect(body.sender).toEqual({ handle: "bob" });
    expect(body.issue).toEqual({ number: 5 });

    const rows = recordedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ webhookId: "h1", event: "issues", ok: true, statusCode: 200 });
    expect(rows[0].error).toBeNull();
  });

  it("retries a 5xx up to 3 attempts, recording each", async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([hook({ events: "push" })] as never);
    const fetchMock = vi.fn().mockResolvedValue({ status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    await emitRepoEvent({ repoId: "r1", event: "push", senderId: "u1", subject: { ref: "refs/heads/main" } });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const rows = recordedRows();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ ok: false, statusCode: 503 });
  });

  it("stops after a 2xx (no wasted retries)", async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([hook()] as never);
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    await emitRepoEvent({ repoId: "r1", event: "push", senderId: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordedRows()).toHaveLength(1);
  });

  it("does NOT retry a 4xx (client error), recorded once", async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([hook()] as never);
    const fetchMock = vi.fn().mockResolvedValue({ status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    await emitRepoEvent({ repoId: "r1", event: "push", senderId: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = recordedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, statusCode: 404, error: "HTTP 404" });
  });

  it("records a network failure across all retries", async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([hook()] as never);
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await emitRepoEvent({ repoId: "r1", event: "push", senderId: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const rows = recordedRows();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ ok: false, statusCode: null, error: "ECONNREFUSED" });
  });

  it("skips hooks not subscribed to the event (no delivery, no record)", async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([hook({ events: "issues" })] as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await emitRepoEvent({ repoId: "r1", event: "push", senderId: "u1" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });

  it("SSRF-blocks a private target: records the block, never fetches, no retry", async () => {
    delete process.env["ALLOW_PRIVATE_WEBHOOKS"]; // enforce the guard
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([hook({ url: "http://127.0.0.1:9999/x" })] as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await emitRepoEvent({ repoId: "r1", event: "push", senderId: "u1" });
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = recordedRows();
    expect(rows).toHaveLength(1); // blocked = non-retryable
    expect(rows[0].ok).toBe(false);
    expect(String(rows[0].error)).toContain("SSRF guard");
  });

  it("never throws even when delivery blows up (side-channel isolation)", async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([hook()] as never);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(emitRepoEvent({ repoId: "r1", event: "push", senderId: "u1" })).resolves.toBeUndefined();
  });

  it("fans out to multiple subscribed hooks", async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      hook({ id: "h1", secret: "a" }),
      hook({ id: "h2", secret: "b", url: "http://hook2.internal/y" }),
    ] as never);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await emitRepoEvent({ repoId: "r1", event: "push", senderId: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordedRows()).toHaveLength(2);
  });
});

// ─── Redelivery ───────────────────────────────────────────────────────────────

describe("redeliverWebhookDelivery", () => {
  it("replays the exact stored body as one new attempt tagged redeliveredFromId", async () => {
    const storedBody = JSON.stringify({ event: "push", repo: { fullName: "alice/widget" } });
    vi.mocked(prisma.webhookDelivery.findUnique).mockResolvedValue({
      id: "d0", webhookId: "h1", event: "push", payload: storedBody,
      webhook: { id: "h1", url: "http://hook.internal/x", secret: "s3cr3t" },
    } as never);
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const row = await redeliverWebhookDelivery("d0");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const opts = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(opts.body).toBe(storedBody); // byte-for-byte replay
    expect(opts.headers["X-ForgeHub-Signature-256"]).toBe(signBody("s3cr3t", storedBody));
    const rows = recordedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ redeliveredFromId: "d0", ok: true, statusCode: 200 });
    expect(row).not.toBeNull();
  });

  it("returns null for an unknown delivery id", async () => {
    vi.mocked(prisma.webhookDelivery.findUnique).mockResolvedValue(null as never);
    expect(await redeliverWebhookDelivery("nope")).toBeNull();
  });
});
