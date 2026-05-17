import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import { escapeHtml, highlightCode } from "../lib/highlight";

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
};

export function MarkdownRenderer({ content, className = "" }: Props) {
  const html = useMemo(() => {
    const raw = marked.parse(content) as string;
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ["class"],
      FORBID_TAGS: ["script", "style"],
    });
  }, [content]);

  return (
    <div
      className={`gh-prose ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
