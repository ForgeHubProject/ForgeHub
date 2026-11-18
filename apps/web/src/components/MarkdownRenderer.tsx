import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import { escapeHtml, highlightCode } from "../lib/highlight";
import { linkifyHtml, type RepoRef } from "../lib/autolink";
import { createHeadingIds } from "../lib/headings";
import { attachmentImageUrls, attachmentObjectUrl, downloadAttachment, holdAttachmentImages, isAttachmentUrl, storedToken } from "../lib/attachments";

const renderer = new Renderer();

renderer.code = function ({ text, lang }) {
  const language = lang || "plaintext";
  const highlighted = highlightCode(text, language);
  return `<pre class="hljs"><code class="language-${language}">${highlighted}</code></pre>`;
};

renderer.codespan = function ({ text }) {
  return `<code>${text}</code>`;
};

// Headings get GitHub's anchors (#256), which the README outline links to.
// One id sequence per document: `parse` below resets it before each render.
let headingId = createHeadingIds();
renderer.heading = function ({ tokens, depth, text }) {
  return `<h${depth} id="${headingId(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
};

marked.use({ renderer, gfm: true, breaks: false });

type Props = {
  content: string;
  className?: string;
  /**
   * When set, `#N` / `!N` / `@handle` in the rendered markdown are autolinked
   * (issue / pull request / profile). Left off for contexts without a repo scope
   * (e.g. READMEs) so behaviour there is unchanged.
   */
  repo?: RepoRef;
};

export function MarkdownRenderer({ content, className = "", repo }: Props) {
  const navigate = useNavigate();
  const token = storedToken();

  const linked = useMemo(() => {
    headingId = createHeadingIds();
    const raw = marked.parse(content) as string;
    const clean = DOMPurify.sanitize(raw, {
      ADD_ATTR: ["class"],
      FORBID_TAGS: ["script", "style"],
    });
    // Bake reference autolinks into the markup (skips code and existing links) so
    // they survive re-renders instead of being reapplied imperatively.
    return repo ? linkifyHtml(clean, repo) : clean;
  }, [content, repo?.owner, repo?.name]);

  // Signed in, attachment images (#253) load with the token: a private repository's are a 404
  // without it. What each loads to is kept in state and written into the markup, so a re-render
  // that resets the HTML keeps the image (setting `img.src` on the element lost it when React
  // replaced the element right after a comment was posted).
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const html = useMemo(() => (token ? holdAttachmentImages(linked, undefined, loaded) : linked), [linked, token, loaded]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    const show = (url: string, src: string) => {
      if (live) setLoaded((m) => (m[url] === src ? m : { ...m, [url]: src }));
    };
    // Only URLs found in the Markdown's own images: never one a comment put in data-fh-attachment.
    for (const url of attachmentImageUrls(linked)) {
      attachmentObjectUrl(url, token).then((src) => show(url, src), () => show(url, url));
    }
    return () => {
      live = false;
    };
  }, [linked, token]);

  // Keep autolink clicks inside the SPA rather than triggering a full navigation.
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
    if (token && link && isAttachmentUrl(link.href)) {
      e.preventDefault();
      const url = link.href;
      downloadAttachment(url, token).catch(() => window.open(url, "_blank", "noopener"));
      return;
    }
    const anchor = (e.target as HTMLElement).closest("a[data-fh-autolink]") as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || !href.startsWith("/")) return;
    e.preventDefault();
    navigate(href);
  }

  return (
    <div
      onClick={onClick}
      className={`gh-prose ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
