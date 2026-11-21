/** The email a person gets when someone wants to transfer a repository to them (#256). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderRepoTransferEmail } from "../repo-transfer-mail.js";

afterEach(() => vi.unstubAllEnvs());

describe("renderRepoTransferEmail", () => {
  it("names who, which repository, and where to answer, until when", () => {
    vi.stubEnv("PUBLIC_URL", "https://forge.example/");
    const m = renderRepoTransferEmail({ to: "bob@example.test", fromHandle: "ada", repoFullName: "ada/poster", expiresAt: new Date("2026-11-22T10:00:00Z") });
    expect(m.to).toBe("bob@example.test");
    expect(m.subject).toBe("@ada wants to transfer ada/poster to you");
    expect(m.text).toContain("Accept or decline it here: https://forge.example/notifications");
    expect(m.text).toContain("Sun, 22 Nov 2026 10:00:00 GMT");
    expect(m.html).toContain('<a href="https://forge.example/notifications">');
  });

  it("escapes what it puts in the HTML", () => {
    const m = renderRepoTransferEmail({ to: "x@example.test", fromHandle: "a<b", repoFullName: "a/<script>", expiresAt: new Date() });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});
