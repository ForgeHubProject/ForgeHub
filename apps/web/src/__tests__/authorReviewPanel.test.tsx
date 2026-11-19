/**
 * A pull request's author reviews their own PR the GitHub way: they may comment
 * on their lines and submit those comments as a "Comment" review, but Approve
 * and Request changes are shown disabled, each saying why.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewSubmitPanel, reviewVerdictOptions } from "../pages/repo/pulls/reviewShared";

function panel(isAuthor: boolean) {
  return renderToStaticMarkup(
    <ReviewSubmitPanel
      currentUser="bob"
      isAuthor={isAuthor}
      pendingCount={2}
      hasPendingReview
      busy={false}
      onSubmit={() => {}}
      onDiscard={() => {}}
    />,
  ).replace(/&#x27;/g, "'");
}

/** The radio inputs in render order, with whether each is disabled / checked. */
function radios(html: string) {
  return [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => ({
    disabled: /\sdisabled=""/.test(m[0]),
    checked: /\schecked=""/.test(m[0]),
  }));
}

describe("reviewVerdictOptions", () => {
  it("offers every verdict to a reviewer", () => {
    expect(reviewVerdictOptions(false).map((o) => [o.value, o.disabled])).toEqual([
      ["commented", false],
      ["approved", false],
      ["changes_requested", false],
    ]);
  });

  it("leaves the PR author only Comment, with Approve / Request changes disabled and explained", () => {
    const opts = reviewVerdictOptions(true);
    expect(opts.map((o) => [o.value, o.disabled])).toEqual([
      ["commented", false],
      ["approved", true],
      ["changes_requested", true],
    ]);
    expect(opts[1].hint).toBe("Pull request authors can't approve their own pull request");
    expect(opts[2].hint).toBe("Pull request authors can't request changes on their own pull request");
  });
});

describe("ReviewSubmitPanel", () => {
  it("lets the PR author finish a review as a comment (pending line comments included)", () => {
    const html = panel(true);
    expect(html).toContain("Finish your review");
    expect(html).toContain("2 pending comments");
    expect(html).toContain("Submit comment");
    expect(html).toContain("Pull request authors can't approve their own pull request");
    expect(radios(html)).toEqual([
      { disabled: false, checked: true },
      { disabled: true, checked: false },
      { disabled: true, checked: false },
    ]);
  });

  it("gives a reviewer all three verdicts enabled", () => {
    const html = panel(false);
    expect(html).not.toContain("Pull request authors can't");
    expect(radios(html).map((r) => r.disabled)).toEqual([false, false, false]);
  });
});
