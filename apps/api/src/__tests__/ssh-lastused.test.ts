import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    sSHKey: { update: vi.fn().mockResolvedValue(undefined) },
    deployKey: { update: vi.fn().mockResolvedValue(undefined) },
  },
}));

import { prisma } from "../prisma.js";
import { touchSshKey, touchDeployKey } from "../ssh/store.js";

// ─── why this file exists ─────────────────────────────────────────────────────
//
// The lastUsedAt/lastUsedIp bump is best-effort fire-and-forget, which means a
// regression in it fails no request and trips no e2e test — the e2e suite only
// mocks update() so the call doesn't crash (issue #156 / PR #168). Nothing else
// asserts the write actually happens or what it contains. These tests are that
// assertion.

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.mocked(prisma.sSHKey.update).mockClear().mockResolvedValue(undefined as never);
  vi.mocked(prisma.deployKey.update).mockClear().mockResolvedValue(undefined as never);
});

describe("touchSshKey", () => {
  it("writes lastUsedAt and lastUsedIp for the right key", () => {
    touchSshKey("key-1", "203.0.113.9");

    expect(prisma.sSHKey.update).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.sSHKey.update).mock.calls[0]![0];
    expect(arg.where).toEqual({ id: "key-1" });
    expect(arg.data).toMatchObject({ lastUsedIp: "203.0.113.9" });
    expect((arg.data as { lastUsedAt: unknown }).lastUsedAt).toBeInstanceOf(Date);
  });

  it("omits lastUsedIp when no IP is known, rather than nulling it", () => {
    touchSshKey("key-1");

    const arg = vi.mocked(prisma.sSHKey.update).mock.calls[0]![0];
    expect(arg.data).not.toHaveProperty("lastUsedIp");
    expect((arg.data as { lastUsedAt: unknown }).lastUsedAt).toBeInstanceOf(Date);
  });

  it("swallows a failed update — the bump is best-effort by design", async () => {
    vi.mocked(prisma.sSHKey.update).mockRejectedValueOnce(new Error("db gone") as never);
    expect(() => touchSshKey("key-1", "203.0.113.9")).not.toThrow();
    await flush(); // an unhandled rejection here would fail the test run
  });
});

describe("touchDeployKey", () => {
  it("writes lastUsedAt and lastUsedIp for the right key", () => {
    touchDeployKey("dk-1", "198.51.100.4");

    expect(prisma.deployKey.update).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.deployKey.update).mock.calls[0]![0];
    expect(arg.where).toEqual({ id: "dk-1" });
    expect(arg.data).toMatchObject({ lastUsedIp: "198.51.100.4" });
    expect((arg.data as { lastUsedAt: unknown }).lastUsedAt).toBeInstanceOf(Date);
  });

  it("omits lastUsedIp when no IP is known", () => {
    touchDeployKey("dk-1");

    const arg = vi.mocked(prisma.deployKey.update).mock.calls[0]![0];
    expect(arg.data).not.toHaveProperty("lastUsedIp");
  });

  it("swallows a failed update", async () => {
    vi.mocked(prisma.deployKey.update).mockRejectedValueOnce(new Error("db gone") as never);
    expect(() => touchDeployKey("dk-1", "198.51.100.4")).not.toThrow();
    await flush();
  });
});
