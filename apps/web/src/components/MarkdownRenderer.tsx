import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import { escapeHtml, highlightCode } from "../lib/highlight";
import { linkifyHtml, type RepoRef } from "../lib/autolink";

const renderer = new Renderer();

renderer.code = function ({ text, lang }) {
  const language = lang || "plaintext";
  const highlighted = highlightCode(text, language);
  return `<pre class="hljs"><code class="language-${language}">${highlighted}</code></pre>`;
};

renderer.codespan = function ({ text }) {
  return `<code>${text}</code>`;
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

  const html = useMemo(() => {
    const raw = marked.parse(content) as string;
    const clean = DOMPurify.sanitize(raw, {
      ADD_ATTR: ["class"],
      FORBID_TAGS: ["script", "style"],
    });
    // Bake reference autolinks into the markup (skips code and existing links) so
    // they survive re-renders instead of being reapplied imperatively.
    return repo ? linkifyHtml(clean, repo) : clean;
  }, [content, repo?.owner, repo?.name]);

  // Keep autolink clicks inside the SPA rather than triggering a full navigation.
  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
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
