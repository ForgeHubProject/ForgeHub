/**
 * Signed-out visitors: public pages open for them, and changing anything sends
 * them to sign in, then back to the page they were on — never to another site.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCommits, starRepo } from "../api";
import { GUEST, isGuest, safeNext, signInPath } from "../lib/guest";

function stubBrowser(path = "/acme/poster/pulls/3/files") {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { pathname: path, search: "", hash: "", assign } });
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ commits: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  return { assign, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safeNext", () => {
  it("keeps a path on this site and refuses anything else", () => {
    expect(safeNext("/acme/poster?tab=stars")).toBe("/acme/poster?tab=stars");
    expect(safeNext("//evil.example/x")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/login?next=/x")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});

describe("signInPath", () => {
  it("comes back to where the visitor is, or opens the sign-up form", () => {
    stubBrowser();
    expect(signInPath()).toBe("/login?next=%2Facme%2Fposter%2Fpulls%2F3%2Ffiles");
    expect(signInPath("/explore", "register")).toBe("/login?next=%2Fexplore&mode=register");
  });
});

describe("a signed-out visitor", () => {
  it("is nobody: no id or handle", () => {
    expect(isGuest(GUEST)).toBe(true);
    expect(isGuest({ ...GUEST, id: "u1", handle: "ada" })).toBe(false);
  });

  it("reads without a token, and is sent to sign in instead of writing", async () => {
    const { assign, fetchMock } = stubBrowser();
    await listCommits("", "acme", "poster", "main");
    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty("Authorization");

    await expect(starRepo("", "acme", "poster")).rejects.toThrow("Sign in to continue");
    expect(assign).toHaveBeenCalledWith("/login?next=%2Facme%2Fposter%2Fpulls%2F3%2Ffiles");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
