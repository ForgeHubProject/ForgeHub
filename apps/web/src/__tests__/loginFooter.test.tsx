/**
 * The sign-in page's footer links somewhere real: Terms, Privacy and Docs all
 * used to be href="#".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "../pages/LoginPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LoginPage footer", () => {
  it("has no link that goes nowhere, and Docs and Source point at the project", () => {
    vi.stubGlobal("window", { location: { pathname: "/login", search: "", hash: "" } });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage onAuth={() => {}} />
      </MemoryRouter>,
    );
    expect(html).not.toContain('href="#"');
    expect(html).toMatch(/<a href="https:\/\/github\.com\/ForgeHubProject\/ForgeHub#readme"[^>]*>Docs<\/a>/);
    expect(html).toMatch(/<a href="https:\/\/github\.com\/ForgeHubProject\/ForgeHub"[^>]*>Source<\/a>/);
    expect(html).not.toMatch(/>(Terms|Privacy)</);
    expect(html).toContain(`© ${new Date().getFullYear()} ForgeHub`);
  });
});
