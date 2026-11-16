/**
 * A signed-out visitor reads a conversation and is invited to sign up or sign
 * in where the comment box would be, coming back to the same page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SignInToComment } from "../components/SignInToComment";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SignInToComment", () => {
  it("links to sign up and to sign in, both coming back to the conversation", () => {
    vi.stubGlobal("window", { location: { pathname: "/gamedev/lanternfall/issues/5", search: "", hash: "" } });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SignInToComment />
      </MemoryRouter>,
    ).replace(/&amp;/g, "&");
    expect(html).toContain('href="/login?next=%2Fgamedev%2Flanternfall%2Fissues%2F5&mode=register"');
    expect(html).toContain('href="/login?next=%2Fgamedev%2Flanternfall%2Fissues%2F5"');
    expect(html).toContain("Sign in to comment");
  });
});
