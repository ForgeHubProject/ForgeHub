/**
 * Password and authentication (#258), on the wire: the second sign-in step and
 * the settings calls send the fields the API reads. fetch is stubbed; the
 * server side is covered in apps/api.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { changePassword, disableTwoFactor, enableTwoFactor, login, loginTwoFactor } from "../api";

function stubFetch(status = 200, body: unknown = {}) {
  const mock = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("two-step sign-in", () => {
  it("hands back the challenge, then trades it and a code for a session", async () => {
    stubFetch(200, { twoFactorRequired: true, challenge: "ch" });
    expect(await login("ada", "pw")).toEqual({ twoFactorRequired: true, challenge: "ch" });

    const mock = stubFetch(200, { token: "t", user: { handle: "ada" } });
    await loginTwoFactor("ch", "123456");
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/auth\/login\/2fa$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ challenge: "ch", code: "123456" });
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe("settings", () => {
  it("sends the current and new password", async () => {
    const mock = stubFetch(204);
    await changePassword("tok", "old", "new-password");
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/users\/me\/password$/);
    expect(JSON.parse(init.body)).toEqual({ currentPassword: "old", newPassword: "new-password" });
  });

  it("enables with the password and a code, and disables with the password", async () => {
    let mock = stubFetch(200, { recoveryCodes: [] });
    await enableTwoFactor("tok", "pw", "123456");
    expect(JSON.parse(mock.mock.calls[0]![1].body)).toEqual({ password: "pw", code: "123456" });

    mock = stubFetch(204);
    await disableTwoFactor("tok", "pw");
    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/users\/me\/two-factor$/);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({ password: "pw" });
  });
});
