import { vi, describe, it, expect, afterEach } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

import { registrationMode } from "../registration.js";
import { buildServer } from "../server.js";

describe("registrationMode", () => {
  afterEach(() => { delete process.env["FORGEHUB_REGISTRATION"]; });

  it("defaults to open when unset or blank", () => {
    expect(registrationMode()).toBe("open");
    process.env["FORGEHUB_REGISTRATION"] = "  ";
    expect(registrationMode()).toBe("open");
  });

  it("accepts open/closed case-insensitively", () => {
    process.env["FORGEHUB_REGISTRATION"] = "CLOSED";
    expect(registrationMode()).toBe("closed");
  });

  it("throws on an unknown value", () => {
    process.env["FORGEHUB_REGISTRATION"] = "invite";
    expect(() => registrationMode()).toThrow(/FORGEHUB_REGISTRATION/);
  });

  it("buildServer fails fast on an invalid value", async () => {
    process.env["JWT_SECRET"] = "test-secret-at-least-16-chars";
    process.env["FORGEHUB_REGISTRATION"] = "clsoed";
    await expect(buildServer()).rejects.toThrow(/FORGEHUB_REGISTRATION/);
  });
});
