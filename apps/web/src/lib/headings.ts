/**
 * Anchors for rendered Markdown headings (#256), as GitHub makes them: the
 * heading's text, lower-cased, punctuation dropped, spaces to hyphens, with
 * -1, -2… for repeats. Ids carry GitHub's `user-content-` prefix so a heading
 * can't clobber a page global like `document.forms`.
 */

export const HEADING_PREFIX = "user-content-";

/** GitHub's heading slug. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Ids for one document's headings, in order: repeats get -1, -2… */
export function createHeadingIds(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const slug = headingSlug(text) || "section";
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return `${HEADING_PREFIX}${n ? `${slug}-${n}` : slug}`;
  };
}
