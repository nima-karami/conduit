import hljs from 'highlight.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSyntaxCache,
  highlightLine,
  monacoLangToHljs,
  type Seg,
  SYNTAX_CACHE_MAX,
  syntaxCacheSize,
} from '../../webview/syntax-highlight';

const concat = (segs: Seg[]) => segs.map((s) => s.text).join('');

afterEach(() => {
  clearSyntaxCache();
  vi.restoreAllMocks();
});

describe('highlightLine', () => {
  it('tokenizes a TypeScript line into multiple segments preserving the text', () => {
    const segs = highlightLine('const x = 1', 'typescript');
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(concat(segs)).toBe('const x = 1');
    expect(segs.some((s) => s.cls?.includes('hljs-keyword'))).toBe(true);
    expect(segs.some((s) => s.cls?.includes('hljs-number'))).toBe(true);
  });

  it('distinguishes strings, comments and keywords', () => {
    const segs = highlightLine('const s = "hi"; // note', 'typescript');
    const classes = segs.map((s) => s.cls).filter(Boolean);
    expect(classes.some((c) => c?.includes('hljs-string'))).toBe(true);
    expect(classes.some((c) => c?.includes('hljs-comment'))).toBe(true);
    expect(concat(segs)).toBe('const s = "hi"; // note');
  });

  it('keeps the concat invariant across assorted inputs and languages', () => {
    const cases: Array<[string, string | null]> = [
      ['const x = 1', 'typescript'],
      ['\tif (a && b) return "x" > 0;', 'javascript'],
      ['def f(x):  # café ünïcode\n', 'python'],
      ['SELECT * FROM t WHERE id = 1', 'sql'],
      ['   ', 'typescript'],
      ['', 'typescript'],
      ['plain unmapped text', null],
      ['<div class="a">&amp;</div>', 'xml'],
    ];
    for (const [text, lang] of cases) {
      expect(concat(highlightLine(text, lang))).toBe(text);
    }
  });

  it('returns a single plain segment for an unknown/null language', () => {
    const segs = highlightLine('anything here', null);
    expect(segs).toEqual([{ text: 'anything here', cls: null }]);
  });

  it('returns a single plain segment for a line over the long-line cap without tokenizing', () => {
    const spy = vi.spyOn(hljs, 'highlight');
    const long = 'x'.repeat(2001);
    const segs = highlightLine(long, 'typescript');
    expect(segs).toEqual([{ text: long, cls: null }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns exactly one segment for a whitespace-only non-empty line', () => {
    const segs = highlightLine('    ', 'typescript');
    expect(segs).toHaveLength(1);
    expect(concat(segs)).toBe('    ');
  });

  it('falls back to a plain segment when hljs throws', () => {
    vi.spyOn(hljs, 'highlight').mockImplementation(() => {
      throw new Error('boom');
    });
    const segs = highlightLine('const x = 1', 'typescript');
    expect(segs).toEqual([{ text: 'const x = 1', cls: null }]);
  });
});

describe('monacoLangToHljs', () => {
  it('maps the notable non-1:1 ids and returns null for plain/unknown', () => {
    expect(monacoLangToHljs('typescript')).toBe('typescript');
    expect(monacoLangToHljs('shell')).toBe('bash');
    expect(monacoLangToHljs('bat')).toBe('dos');
    expect(monacoLangToHljs('html')).toBe('xml');
    expect(monacoLangToHljs('vb')).toBe('vbnet');
    expect(monacoLangToHljs('mdx')).toBe('markdown');
    expect(monacoLangToHljs('plaintext')).toBeNull();
    expect(monacoLangToHljs('totally-unknown')).toBeNull();
  });

  // Every Monaco id `src/lang.ts` `langFromPath` can emit. Kept in sync with lang.ts by hand
  // (it doesn't export the set). The contract: each maps to null OR an id hljs has registered —
  // never a dangling id (spec §"Per-file language" completeness check).
  const MONACO_IDS = [
    'typescript',
    'javascript',
    'json',
    'markdown',
    'mdx',
    'css',
    'scss',
    'less',
    'html',
    'python',
    'rust',
    'go',
    'shell',
    'powershell',
    'bat',
    'yaml',
    'ini',
    'java',
    'kotlin',
    'scala',
    'c',
    'cpp',
    'csharp',
    'fsharp',
    'vb',
    'ruby',
    'php',
    'swift',
    'dart',
    'lua',
    'perl',
    'r',
    'julia',
    'clojure',
    'elixir',
    'sol',
    'tcl',
    'pascal',
    'sql',
    'graphql',
    'proto',
    'hcl',
    'dockerfile',
    'xml',
    'plaintext',
  ];

  it('never points at an unregistered hljs grammar', () => {
    for (const id of MONACO_IDS) {
      const mapped = monacoLangToHljs(id);
      if (mapped !== null) {
        expect(hljs.getLanguage(mapped), `${id} → ${mapped} must be registered`).toBeTruthy();
      }
    }
  });
});

describe('cache', () => {
  it('returns the same (cached) result for identical inputs', () => {
    const a = highlightLine('const x = 1', 'typescript');
    const b = highlightLine('const x = 1', 'typescript');
    expect(b).toBe(a);
  });

  it('holds the size at SYNTAX_CACHE_MAX under FIFO eviction', () => {
    clearSyntaxCache();
    for (let i = 0; i <= SYNTAX_CACHE_MAX; i++) {
      highlightLine(`const v${i} = ${i}`, 'typescript');
    }
    expect(syntaxCacheSize()).toBe(SYNTAX_CACHE_MAX);
  });
});
