import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

// We mock node:fs/promises so we can control whether the host public-key file
// "exists" without touching the filesystem.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, readFile: vi.fn(real.readFile) };
});

import { readFile } from "node:fs/promises";
import { createTestServer } from "./helpers/server.js";
import type { FastifyInstance } from "fastify";

// A stable ed25519 pub-key line + its known fingerprint (same fixture as ssh-fingerprint.test.ts).
const ED_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINF3319jjgEjhpwtrz3oEC7Q5v9ny/ubnpRxPF3Xt/1F";
const ED_FP = "SHA256:VCLjt8aUSHPMAP7Q67RG8wteqLWaiuYHoU5DqJUxXd8";

describe("GET /server/info", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["FORGEHUB_SSH_PORT"];
    delete process.env["FORGEHUB_SSH_HOST"];
  });

  afterEach(() => {
    delete process.env["FORGEHUB_SSH_PORT"];
    delete process.env["FORGEHUB_SSH_HOST"];
  });

  it("returns sshEnabled=false and null fields when FORGEHUB_SSH_PORT is unset", async () => {
    const res = await app.inject({ method: "GET", url: "/server/info" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sshEnabled: boolean; sshPort: null; sshHost: null; sshFingerprint: null }>();
    expect(body.sshEnabled).toBe(false);
    expect(body.sshPort).toBeNull();
    expect(body.sshHost).toBeNull();
    expect(body.sshFingerprint).toBeNull();
  });

  it("returns sshEnabled=true and the port when FORGEHUB_SSH_PORT is set and host key exists", async () => {
    process.env["FORGEHUB_SSH_PORT"] = "2222";
    vi.mocked(readFile).mockResolvedValue(ED_PUB as never);

    const res = await app.inject({ method: "GET", url: "/server/info" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sshEnabled: boolean; sshPort: number; sshHost: null; sshFingerprint: string }>();
    expect(body.sshEnabled).toBe(true);
    expect(body.sshPort).toBe(2222);
    expect(body.sshHost).toBeNull();
    expect(body.sshFingerprint).toBe(ED_FP);
  });

  it("includes sshHost when FORGEHUB_SSH_HOST is set", async () => {
    process.env["FORGEHUB_SSH_PORT"] = "22";
    process.env["FORGEHUB_SSH_HOST"] = "git.example.com";
    vi.mocked(readFile).mockResolvedValue(ED_PUB as never);

    const res = await app.inject({ method: "GET", url: "/server/info" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sshEnabled: boolean; sshPort: number; sshHost: string; sshFingerprint: string }>();
    expect(body.sshHost).toBe("git.example.com");
    expect(body.sshFingerprint).toBe(ED_FP);
  });

  it("returns null fingerprint when the host-key file doesn't exist yet (SSH not yet started)", async () => {
    process.env["FORGEHUB_SSH_PORT"] = "2222";
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const res = await app.inject({ method: "GET", url: "/server/info" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sshEnabled: boolean; sshFingerprint: null }>();
    expect(body.sshEnabled).toBe(true);
    expect(body.sshFingerprint).toBeNull();
  });

  it("returns sshEnabled=false for an invalid port value", async () => {
    process.env["FORGEHUB_SSH_PORT"] = "not-a-port";
    const res = await app.inject({ method: "GET", url: "/server/info" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sshEnabled: boolean }>();
    expect(body.sshEnabled).toBe(false);
  });

  it("requires no authentication", async () => {
    // No auth header — should still 200 (public endpoint).
    const res = await app.inject({ method: "GET", url: "/server/info" });
    expect(res.statusCode).toBe(200);
  });
});
