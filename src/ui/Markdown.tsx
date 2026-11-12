// Renders GitHub-flavoured Markdown from agents, PR descriptions and review comments.
// react-markdown builds React elements and ignores raw HTML, so untrusted text can't inject markup.
// Links open in the system browser instead of navigating the app window.

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "../lib/platform";

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:\/\//.test(href)) void openUrl(href);
      }}
      title={href}
    >
      {children}
    </a>
  ),
  pre: ({ children }) => <pre className="md-pre">{children}</pre>,
  table: ({ children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
  img: ({ alt }) => <span className="muted">[image{alt ? `: ${alt}` : ""}]</span>,
};

export const Markdown = memo(function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div className={compact ? "md md-compact" : "md"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
