import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

const marked = new Marked(
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {
          // invalid language tag → fall back to auto-detection
        }
      }
      return hljs.highlightAuto(code).value;
    },
  })
);
marked.setOptions({ gfm: true, breaks: true });

// Neutralize the other beacon vectors that also fetch a remote resource on render, beyond src/srcset:
// <video poster>, the legacy `background` attribute, SVG xlink:href, and CSS url() inside an inline style.
// Inline data: URIs (no network) are kept; any external reference is stripped so it can't phone home.
function stripBeaconAttrs(node: Element): void {
  for (const attr of ['poster', 'background', 'xlink:href']) {
    const v = node.getAttribute(attr);
    if (v && !v.trim().toLowerCase().startsWith('data:')) node.removeAttribute(attr);
  }
  // An inline style can pull a remote resource via url() (background-image, etc.). Drop the whole style
  // attribute when it references any url() that isn't a data: URI (single char-class star → no ReDoS).
  const style = node.getAttribute('style');
  if (style && /url\(["'\s]*(?!data:)/i.test(style)) node.removeAttribute('style');
}

// Harden external links: add noopener + open in a new tab for <a> in untrusted markdown
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('target', '_blank');
  }
  // Block external resource loads embedded in session content — a tracking-pixel <img> would otherwise
  // beacon the viewer's IP/UA to a remote host on render. Inline data: URIs (no network) are kept.
  if (node.hasAttribute('src') && !node.getAttribute('src')?.startsWith('data:')) {
    node.removeAttribute('src');
  }
  if (node.hasAttribute('srcset')) node.removeAttribute('srcset');
  stripBeaconAttrs(node);
});

// Parse cache: react-virtual unmounts rows scrolled out of the window and remounts them on scroll
// back → memoization is lost and the content is re-parsed (highlightAuto is especially costly).
// Message text is immutable → keying the cache on the raw text is safe; Map iteration order =
// insertion order, so the oldest entry is evicted when full (an approximate LRU, good enough).
const CACHE_MAX = 2500; // for a 10k-message session, a 500-entry window + overscan thrashes and re-parses; 2500 is a few MB
const htmlCache = new Map<string, string>();

// Copy-button icons: inline SVGs of lucide Copy/Check (injected HTML can't use React components; consistent with the site's icon language, no emoji)
const COPY_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const COPY_FEEDBACK_MS = 1200; // kept in sync with useCopyFeedback

/** marked custom renderer: wraps each code block in a container that carries a copy button.
 *  The button behaves via the event delegation below — no inline onclick is injected into the
 *  sanitized HTML (CSP-safe, and it doesn't weaken the sanitize boundary). */
function wrapCode(html: string): string {
  // rewrite <pre><code>...</code></pre> → <div class="code-block-wrapper"><pre>...</pre><button>Copy</button></div>
  return html.replaceAll(
    '<pre><code',
    '<div class="code-block-wrapper"><pre><code'
  ).replaceAll(
    '</code></pre>',
    `</code></pre><button type="button" class="code-copy-btn" title="Copy code" aria-label="Copy code">${COPY_SVG} Copy</button></div>`
  );
}

/** Wrap tables in a scroll container: scroll horizontally on narrow screens instead of overflowing the layout (as ChatGPT's web UI does). marked emits a bare <table> by default */
function wrapTables(html: string): string {
  return html.replaceAll('<table>', '<div class="md-table-wrap"><table>').replaceAll('</table>', '</table></div>');
}

// Copy-button event delegation: attach a single document listener at module load, matched by class
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest?.('.code-copy-btn');
    if (!btn) return;
    const code = btn.parentElement?.querySelector('code')?.textContent ?? '';
    navigator.clipboard.writeText(code).then(() => {
      const original = btn.innerHTML;
      btn.innerHTML = `${CHECK_SVG} Copied`;
      setTimeout(() => { btn.innerHTML = original; }, COPY_FEEDBACK_MS);
    }).catch(() => {
      // clipboard permission denied → fail silently (the content can still be selected manually)
    });
  });
}

/** Markdown → sanitized HTML (DOMPurify with a narrowed profile: closes the SVG/MathML attack surface); includes copy buttons */
/** Infer a highlight.js language id from a file extension; returns null on failure */
function langFromPath(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  // direct mapping to highlight.js known languages
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    css: 'css', scss: 'scss', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
    json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', sh: 'bash', bash: 'bash',
    ps1: 'powershell', sql: 'sql', md: 'markdown', mjs: 'javascript',
    cjs: 'javascript', vue: 'xml', svelte: 'xml', astro: 'xml',
  };
  return map[ext] ?? null;
}

/** Syntax-highlight by file extension (for rendering full file contents from Write/Edit, etc.) */
export function highlightCode(code: string, filePath: string): string {
  const lang = langFromPath(filePath);
  const raw = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] }); // defense-in-depth (symmetric with renderMarkdown)
}

export function renderMarkdown(text: string): string {
  const hit = htmlCache.get(text);
  if (hit !== undefined) return hit;
  const raw = marked.parse(text, { async: false });
  const safe = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] });
  const html = wrapTables(wrapCode(safe));
  if (htmlCache.size >= CACHE_MAX) {
    const oldest = htmlCache.keys().next().value;
    if (oldest !== undefined) htmlCache.delete(oldest);
  }
  htmlCache.set(text, html);
  return html;
}
