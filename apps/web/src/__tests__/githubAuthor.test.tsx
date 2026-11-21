/**
 * Issues and comments brought over from GitHub (#289) show their GitHub author,
 * linking to GitHub, never to a profile here that may belong to someone else.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AuthorLink } from "../pages/repo/issues/parts";
import { importedSoFar } from "../pages/repo/issues/IssueImportBanner";

const render = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe("AuthorLink", () => {
  it("an imported author: their GitHub profile, marked as on GitHub", () => {
    const html = render(<AuthorLink author="ghost" importedAuthor="mona" />);
    expect(html).toContain('href="https://github.com/mona"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">mona</a>");
    expect(html).toContain(" on GitHub");
    expect(html).not.toContain('href="/mona"');
    expect(html).not.toContain("ghost");
  });

  it("anyone else: their profile here", () => {
    const html = render(<AuthorLink author="ada" importedAuthor={null} />);
    expect(html).toContain('href="/ada"');
    expect(html).not.toContain("GitHub");
  });
});

describe("importedSoFar", () => {
  it("counts issues and comments", () => {
    expect(importedSoFar({ issues: 1, comments: 0 })).toBe("1 issue and 0 comments");
    expect(importedSoFar({ issues: 1240, comments: 1 })).toBe("1,240 issues and 1 comment");
    expect(importedSoFar({ issues: 3, comments: 7, releases: 2 })).toBe("3 issues, 7 comments and 2 releases");
  });
});
