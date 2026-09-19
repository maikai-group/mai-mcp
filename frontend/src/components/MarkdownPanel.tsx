// Renders server markdown safely: marked → DOMPurify.sanitize → styled prose.
// This is THE sanitization gate for all markdown surfaces (report, staleness,
// search, timeline, sessions, topics). DOMPurify default config strips scripts,
// event handlers, and javascript: URIs. Shared across Tasks 4–5.
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './markdown.css';

marked.setOptions({ gfm: true, breaks: false });

export function MarkdownPanel({ markdown, className }: { markdown: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(markdown ?? '', { async: false });
    return DOMPurify.sanitize(raw);
  }, [markdown]);
  return (
    <div
      className={'mai-prose ' + (className ?? '')}
      // Sanitized above — this is the single trusted sink.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
