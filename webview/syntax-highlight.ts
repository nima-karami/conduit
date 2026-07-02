import hljs from 'highlight.js';
import type { WordSpan } from '../src/review-hunks';

/**
 * Per-line syntax highlighting for the Review diff surface (spec 2026-07-01-review-diff-syntax).
 *
 * Diffs are line-oriented, so tokenization is per line (Decision D1): no cross-line state, which
 * means a continuation of a multi-line construct (block comment, template literal) may colour
 * imperfectly — an accepted, documented tradeoff the windowing/perf mandate forces.
 *
 * Colours live in CSS (`webview/hljs-theme.css` → `--syn-*` vars), so a theme change is a pure
 * CSS recolour with no re-tokenize and no cache invalidation. This module only produces the
 * class-tagged text segments; it never chooses a colour.
 */

/** An ordered slice of a line: `cls` is an hljs class string (e.g. "hljs-keyword") or null for
 *  plain, uncoloured text. Concatenating every `text` reproduces the input line exactly. */
export type Seg = { text: string; cls: string | null };

/** A syntax segment further split by word-diff emphasis: `emph` marks a span that changed in a
 *  replacement pair. Keeps the syntax `cls` (token colour) so emphasis composes UNDER the colour —
 *  the changed word keeps its keyword/string/number colour and only gains a background accent. */
export type EmphSeg = Seg & { emph: boolean };

/**
 * Overlay word-diff emphasis onto syntax segments: split each `Seg` at the `spans` char boundaries
 * (offsets into the line, which the concatenated segments reproduce) and tag the pieces inside a
 * span `emph: true`. Spans must be ascending + non-overlapping (as `wordDiff` returns). With no
 * spans, returns the segments unchanged (all `emph: false`), so this is a no-op on context rows and
 * unpaired add/del lines.
 */
export function applyEmphasis(segs: Seg[], spans: WordSpan[] | undefined): EmphSeg[] {
  if (!spans || spans.length === 0) return segs.map((s) => ({ ...s, emph: false }));
  const out: EmphSeg[] = [];
  let pos = 0;
  for (const seg of segs) {
    const segStart = pos;
    const segEnd = pos + seg.text.length;
    pos = segEnd;
    let cursor = segStart;
    for (const span of spans) {
      if (span.end <= segStart || span.start >= segEnd) continue;
      const from = Math.max(span.start, segStart);
      const to = Math.min(span.end, segEnd);
      if (from > cursor)
        out.push({
          text: seg.text.slice(cursor - segStart, from - segStart),
          cls: seg.cls,
          emph: false,
        });
      out.push({ text: seg.text.slice(from - segStart, to - segStart), cls: seg.cls, emph: true });
      cursor = to;
    }
    if (cursor < segEnd)
      out.push({ text: seg.text.slice(cursor - segStart), cls: seg.cls, emph: false });
  }
  return out;
}

/** hljs regex cost is superlinear on pathological lines; skip tokenizing past this length. */
const LONG_LINE_MAX = 2000;

/** FIFO cache bound — a `Map` preserves insertion order, so eviction is `delete(firstKey)` on
 *  overflow. Access-order LRU isn't worth the bookkeeping for a presentational cache. */
export const SYNTAX_CACHE_MAX = 5000;

const cache = new Map<string, Seg[]>();

/** Test-only: the live cache size, for asserting the FIFO bound. */
export function syntaxCacheSize(): number {
  return cache.size;
}

/** Test-only: drop all cached results so cache-behaviour assertions start clean. */
export function clearSyntaxCache(): void {
  cache.clear();
}

/**
 * Map a Monaco language id (from `src/lang.ts` `langFromPath`) to the highlight.js id, or null
 * when there is no usable grammar (plain fallback). Most Monaco ids are valid hljs ids 1:1; the
 * exceptions are spelled out. Ids whose grammar isn't in the shipped build map to null (`sol`,
 * `hcl`) — see the completeness unit test.
 */
export function monacoLangToHljs(monacoId: string): string | null {
  return MONACO_TO_HLJS[monacoId] ?? null;
}

const MONACO_TO_HLJS: Record<string, string | null> = {
  typescript: 'typescript',
  javascript: 'javascript',
  json: 'json',
  markdown: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  python: 'python',
  rust: 'rust',
  go: 'go',
  shell: 'bash',
  powershell: 'powershell',
  bat: 'dos',
  yaml: 'yaml',
  ini: 'ini',
  java: 'java',
  kotlin: 'kotlin',
  scala: 'scala',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  fsharp: 'fsharp',
  vb: 'vbnet',
  ruby: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  perl: 'perl',
  r: 'r',
  julia: 'julia',
  clojure: 'clojure',
  elixir: 'elixir',
  sql: 'sql',
  graphql: 'graphql',
  proto: 'protobuf',
  dockerfile: 'dockerfile',
  xml: 'xml',
  tcl: 'tcl',
  pascal: 'pascal',
  // No grammar in the shipped default build → plain fallback.
  sol: null,
  hcl: null,
  plaintext: null,
};

/**
 * Tokenize one diff line into class-tagged segments. Returns a single plain segment (never an
 * empty array) when the language is unknown/unregistered, the line is too long, or hljs throws —
 * so the concat invariant (segments reproduce the input) always holds and a highlight failure can
 * never break a row.
 */
export function highlightLine(text: string, hljsLang: string | null): Seg[] {
  if (!hljsLang || text.length > LONG_LINE_MAX || !hljs.getLanguage(hljsLang)) {
    return [{ text, cls: null }];
  }
  // A space separates lang from text; lang ids are [a-z0-9]+ (never a space), so the
  // first space always splits the two and keys can't collide ("ts"+"x" vs "t"+"sx").
  const key = `${hljsLang} ${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let segs: Seg[];
  try {
    const html = hljs.highlight(text, { language: hljsLang, ignoreIllegals: true }).value;
    segs = parseHljsHtml(html);
  } catch {
    segs = [{ text, cls: null }];
  }
  if (segs.length === 0) segs = [{ text, cls: null }];

  cache.set(key, segs);
  if (cache.size > SYNTAX_CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  return segs;
}

const ENTITY: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#x27': "'",
};

/** Reverse hljs's `escapeHTML` (the only 5 entities it emits). */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(amp|lt|gt|quot|#x27);/g, (_, e: string) => ENTITY[e] ?? _);
}

/**
 * Flatten hljs's HTML into a segment list. hljs output is a simple tree of `<span class="hljs-…">`
 * wrappers around entity-escaped text; nested spans use the innermost class. We never render this
 * HTML (segments become React text children), so there is no XSS surface even on hostile content.
 */
function parseHljsHtml(html: string): Seg[] {
  const segs: Seg[] = [];
  const stack: string[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const gt = html.indexOf('>', i);
      if (gt === -1) break;
      const tag = html.slice(i, gt + 1);
      if (tag[1] === '/') {
        stack.pop();
      } else {
        const m = /class="([^"]*)"/.exec(tag);
        stack.push(m ? m[1] : '');
      }
      i = gt + 1;
    } else {
      const lt = html.indexOf('<', i);
      const end = lt === -1 ? html.length : lt;
      const raw = decodeEntities(html.slice(i, end));
      if (raw !== '') {
        const cls = stack.length > 0 ? stack[stack.length - 1] || null : null;
        const last = segs[segs.length - 1];
        if (last && last.cls === cls) last.text += raw;
        else segs.push({ text: raw, cls });
      }
      i = end;
    }
  }
  return segs;
}
