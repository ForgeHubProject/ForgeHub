import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import { escapeHtml, highlightCode } from "../lib/highlight";
import { linkifyElement, type RepoRef } from "../lib/autolink";

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
  const ref = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    const raw = marked.parse(content) as string;
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ["class"],
      FORBID_TAGS: ["script", "style"],
    });
  }, [content]);

  // Autolink references after the sanitized HTML is in the DOM (skips code/links).
  useEffect(() => {
    if (repo && ref.current) linkifyElement(ref.current, repo);
  }, [html, repo?.owner, repo?.name]);

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
      ref={ref}
      onClick={onClick}
      className={`gh-prose ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
