// The Commits tab's list as a URL (#224): `?ref=` (default: the repo page's
// branch), `?path=` for one file's or folder's history, `?page=`, and the
// filters (#256): `?author=` and `?since=` / `?until=` (YYYY-MM-DD).

/** Commits per page of the list, as before paging existed. */
export const COMMITS_PER_PAGE = 50;

export type CommitListQuery = {
  ref: string;
  path: string | null;
  page: number;
  author?: string;
  since?: string;
  until?: string;
};

export function commitListQuery(search: URLSearchParams, defaultRef: string): CommitListQuery {
  const ref = search.get("ref") || defaultRef;
  const path = (search.get("path") ?? "").replace(/^\/+|\/+$/g, "") || null;
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  const day = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(search.get(k) ?? "") ? search.get(k)! : undefined);
  return { ref, path, page, author: search.get("author") || undefined, since: day("since"), until: day("until") };
}

/** The list's URL for a query, leaving out what is already the default. */
export function commitListUrl(base: string, q: CommitListQuery, defaultRef: string): string {
  const qs = new URLSearchParams();
  if (q.ref !== defaultRef) qs.set("ref", q.ref);
  if (q.path) qs.set("path", q.path);
  if (q.author) qs.set("author", q.author);
  if (q.since) qs.set("since", q.since);
  if (q.until) qs.set("until", q.until);
  if (q.page > 1) qs.set("page", String(q.page));
  const s = qs.toString();
  return s ? `${base}/commits?${s}` : `${base}/commits`;
}
