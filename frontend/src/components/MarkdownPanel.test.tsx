import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MarkdownPanel } from './MarkdownPanel';

describe('MarkdownPanel sanitization', () => {
  afterEach(() => cleanup());

  it('renders markdown to HTML', () => {
    const { container } = render(<MarkdownPanel markdown={'# Title\n\nsome **bold** text'} />);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });

  it('strips a script tag', () => {
    const { container } = render(<MarkdownPanel markdown={'hi <script>window.__pwned = 1</script> there'} />);
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('renders an <img onerror> XSS probe inert (no onerror attribute)', () => {
    const { container } = render(<MarkdownPanel markdown={'<img src=x onerror="window.__xss=1">'} />);
    const img = container.querySelector('img');
    // DOMPurify keeps the img but strips the event handler.
    expect(img?.getAttribute('onerror')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('strips a javascript: link href', () => {
    const { container } = render(<MarkdownPanel markdown={'[click](javascript:alert(1))'} />);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href') ?? '').not.toContain('javascript:');
  });
});
