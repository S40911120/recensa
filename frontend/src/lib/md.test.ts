/**
 * @vitest-environment jsdom
 *
 * Runs under jsdom instead of the project-default happy-dom. DOMPurify 3.4.x relies on DOM behaviors
 * that happy-dom 20.x implements incompletely: under happy-dom it silently drops a plain <img>, leaves
 * <script> intact, and skips the afterSanitizeAttributes hook — none of which reflect a real browser.
 * jsdom (the DOM DOMPurify is itself tested against) faithfully exercises the sanitization boundary,
 * so these pins assert the same behavior the app produces in the browser it ships to.
 */
import { describe, expect, it } from 'vitest';

import { highlightCode, renderMarkdown } from './md';

// Session content is untrusted markdown rendered into the DOM; md.ts is the XSS / tracking-beacon
// boundary. These tests pin the exact sanitized output so a future refactor of the DOMPurify profile
// or the afterSanitizeAttributes hook can't silently reopen the hole. BEACON is a single sentinel host:
// if it survives sanitization the browser would fetch it on render and leak the viewer's IP/UA.
const BEACON = 'http://beacon.evil.example';

describe('renderMarkdown — XSS / beacon sanitization boundary', () => {
  it('strips <script> elements and their payload', () => {
    const html = renderMarkdown('before\n\n<script>window.__pwned = 1;</script>\n\nafter');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('__pwned');
    // surrounding markdown still renders → the input was really parsed, not rejected wholesale
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('strips <style> elements', () => {
    const html = renderMarkdown('<style>body { color: red }</style>\n\nvisible text');
    expect(html).not.toContain('<style');
    expect(html).toContain('visible text');
  });

  it('strips an external <img src> beacon', () => {
    const html = renderMarkdown(`![pixel](${BEACON}/pixel.gif)`);
    expect(html).not.toContain(BEACON);
    expect(html).toContain('pixel'); // the <img alt> survives, only the remote src is dropped
  });

  it('strips the srcset external-resource beacon', () => {
    const html = renderMarkdown(`<img srcset="${BEACON}/2x.gif 2x">`);
    expect(html).not.toContain(BEACON);
    expect(html).not.toContain('srcset');
  });

  it('strips the <video poster> beacon', () => {
    const html = renderMarkdown(`<video poster="${BEACON}/poster.jpg"></video>`);
    expect(html).not.toContain(BEACON);
    expect(html).not.toContain('poster');
  });

  it('strips the legacy background-attribute beacon', () => {
    const html = renderMarkdown(`<table><tr><td background="${BEACON}/bg.png">cell</td></tr></table>`);
    expect(html).not.toContain(BEACON);
    expect(html).not.toContain('background=');
    expect(html).toContain('cell'); // the cell content survives, only the beacon attr is dropped
  });

  it('strips the SVG xlink:href beacon', () => {
    const html = renderMarkdown(`<svg><image xlink:href="${BEACON}/x.svg" /></svg>`);
    expect(html).not.toContain(BEACON);
  });

  it('strips an inline style that pulls a remote url()', () => {
    const html = renderMarkdown(`<div style="background: url(${BEACON}/u.png)">boxed</div>`);
    expect(html).not.toContain(BEACON);
    expect(html).not.toContain('style=');
    expect(html).toContain('boxed'); // the element survives, only the beacon-carrying style is dropped
  });

  it('keeps inline data: URIs (no network fetch)', () => {
    const dataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const html = renderMarkdown(`![dot](${dataUri})`);
    expect(html).toContain('data:image/png;base64');
  });

  it('hardens external links with rel=noopener and target=_blank', () => {
    const html = renderMarkdown('[docs](https://example.com/docs)');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});

describe('highlightCode — syntax highlighting stays sanitized', () => {
  it('highlights known languages by file extension', () => {
    const html = highlightCode('const answer = 42;', 'answer.ts');
    expect(html).toContain('answer');
    expect(html).toContain('hljs'); // highlight.js token spans are present
  });

  it('renders script-looking source as escaped text, never a live element', () => {
    const html = highlightCode('<script>alert(1)</script>', 'evil.html');
    expect(html).not.toContain('<script>'); // never emitted as a live tag
    expect(html).toContain('&lt;'); // the angle brackets are HTML-escaped
    expect(html).toContain('alert(1)'); // the payload is shown as inert source text
  });
});
