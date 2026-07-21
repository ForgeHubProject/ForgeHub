/**
 * Client-side autolinking for conversation markdown: `#N` → issue, `!N` → pull
 * request (GitLab-style, matching the server parser), `@handle` → profile.
 *
 * `tokenizeRefs` is the pure, boundary-aware core (unit-tested). `linkifyElement`
 * applies it to a rendered DOM subtree, skipping text inside `<code>`, `<pre>` and
 * existing `<a>` so code and real links are never touched.
 */

export type RefToken =
  | { type: "text"; value: string }
  | { type: "issue"; number: number; raw: string }
  | { type: "pull"; number: number; raw: string }
  | { type: "mention"; handle: string; raw: string };

export type RepoRef = { owner: string; name: string };

// Capture the preceding boundary (start, or a char that isn't a word char or `/`)
// so `abc#5`, `C#7`, `foo@bar.com` and `path/@x` don't false-positive. The trailing
// lookahead stops partial matches like `#5x`.
const REF_RE = /(^|[^0-9A-Za-z_/])(?:#(\d+)|!(\d+)|@([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}))(?![0-9A-Za-z_])/g;

/** Split a plain-text string into text/issue/pull/mention tokens. */
export function tokenizeRefs(text: string): RefToken[] {
  const out: RefToken[] = [];
  let last = 0;
  for (const m of text.matchAll(REF_RE)) {
    const idx = m.index ?? 0;
    const boundary = m[1] ?? "";
    const pre = text.slice(last, idx) + boundary;
    if (pre) out.push({ type: "text", value: pre });
    if (m[2]) out.push({ type: "issue", number: Number(m[2]), raw: `#${m[2]}` });
    else if (m[3]) out.push({ type: "pull", number: Number(m[3]), raw: `!${m[3]}` });
    else if (m[4]) out.push({ type: "mention", handle: m[4], raw: `@${m[4]}` });
    last = idx + m[0].length;
  }
  const tail = text.slice(last);
  if (tail) out.push({ type: "text", value: tail });
  return out;
}

function hrefFor(token: RefToken, repo: RepoRef): string | null {
  switch (token.type) {
    case "issue": return `/${repo.owner}/${repo.name}/issues/${token.number}`;
    case "pull": return `/${repo.owner}/${repo.name}/pulls/${token.number}`;
    case "mention": return `/${token.handle}`;
    default: return null;
  }
}

/**
 * Autolink references in an HTML string (parse → linkify → serialize). Baking the
 * links into the markup — rather than mutating the DOM after React renders it —
 * keeps them from being wiped by re-renders. Browser-only (uses DOMParser); a
 * no-op if DOMParser is unavailable.
 */
export function linkifyHtml(html: string, repo: RepoRef): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div id="__fh_autolink_root">${html}</div>`, "text/html");
  const root = doc.getElementById("__fh_autolink_root");
  if (!root) return html;
  linkifyElement(root, repo);
  return root.innerHTML;
}

const SKIP_TAGS = new Set(["A", "CODE", "PRE"]);

/** Rewrite reference text inside `root` into internal `<a data-fh-autolink>` links. */
export function linkifyElement(root: HTMLElement, repo: RepoRef): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let p = node.parentElement; p && p !== root; p = p.parentElement) {
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

  for (const node of textNodes) {
    const tokens = tokenizeRefs(node.data);
    if (tokens.length <= 1) continue; // nothing but text (or empty)
    const frag = doc.createDocumentFragment();
    for (const token of tokens) {
      const href = token.type === "text" ? null : hrefFor(token, repo);
      if (!href || token.type === "text") {
        frag.appendChild(doc.createTextNode(token.type === "text" ? token.value : token.raw));
        continue;
      }
      const a = doc.createElement("a");
      a.className = "fh-autolink";
      a.dataset.fhAutolink = "true";
      a.href = href;
      a.textContent = token.raw;
      frag.appendChild(a);
    }
    node.replaceWith(frag);
  }
}
