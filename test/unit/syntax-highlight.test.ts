import hljs from 'highlight.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanguageId } from '../../src/lang';
import {
  applyEmphasis,
  clearSyntaxCache,
  highlightLine,
  hljsLanguageFor,
  monacoLangToHljs,
  type Seg,
  SYNTAX_CACHE_MAX,
  syntaxCacheSize,
} from '../../webview/syntax-highlight';

const concat = (segs: { text: string }[]) => segs.map((s) => s.text).join('');

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

  // A Record over LanguageId, so an id added to lang.ts fails typecheck here until it is listed.
  const LISTED: Record<LanguageId, true> = {
    bat: true,
    bicep: true,
    c: true,
    clojure: true,
    cmake: true,
    coffeescript: true,
    cpp: true,
    csharp: true,
    css: true,
    cypher: true,
    dart: true,
    diff: true,
    dockerfile: true,
    dotenv: true,
    elixir: true,
    fsharp: true,
    go: true,
    gomod: true,
    graphql: true,
    groovy: true,
    handlebars: true,
    hcl: true,
    html: true,
    ignore: true,
    ini: true,
    java: true,
    javascript: true,
    json: true,
    julia: true,
    kotlin: true,
    less: true,
    liquid: true,
    log: true,
    lua: true,
    makefile: true,
    markdown: true,
    mdx: true,
    'objective-c': true,
    ocaml: true,
    pascal: true,
    perl: true,
    php: true,
    plaintext: true,
    powerquery: true,
    powershell: true,
    proto: true,
    pug: true,
    python: true,
    qsharp: true,
    r: true,
    razor: true,
    restructuredtext: true,
    ruby: true,
    rust: true,
    scala: true,
    scheme: true,
    scss: true,
    shell: true,
    sol: true,
    sparql: true,
    sql: true,
    swift: true,
    systemverilog: true,
    tcl: true,
    toml: true,
    twig: true,
    typescript: true,
    typespec: true,
    vb: true,
    verilog: true,
    wgsl: true,
    xml: true,
    yaml: true,
  };
  const ALL_IDS = Object.keys(LISTED) as LanguageId[];

  it('every LanguageId has an hljs entry: a registered grammar, or null only where hljs has none', () => {
    for (const id of ALL_IDS) {
      if (id === 'plaintext') continue;
      const mapped = monacoLangToHljs(id);
      if (mapped !== null) {
        expect(hljs.getLanguage(mapped), `${id} → ${mapped} must be registered`).toBeTruthy();
      } else {
        expect(hljs.getLanguage(id), `${id} is in hljs, so it must not map to null`).toBeFalsy();
      }
    }
  });

  it('maps the language-coverage ids per spec §2.2', () => {
    const expected: Record<string, string | null> = {
      toml: 'ini',
      dotenv: 'ini',
      makefile: 'makefile',
      cmake: 'cmake',
      diff: 'diff',
      ignore: null,
      groovy: 'groovy',
      ocaml: 'ocaml',
      'objective-c': 'objectivec',
      coffeescript: 'coffeescript',
      handlebars: 'handlebars',
      twig: 'twig',
      scheme: 'scheme',
      systemverilog: 'verilog',
      verilog: 'verilog',
      razor: null,
      pug: null,
      liquid: null,
      bicep: null,
      wgsl: null,
      restructuredtext: null,
      typespec: null,
      cypher: null,
      powerquery: null,
      qsharp: null,
      sparql: null,
      gomod: null,
      log: null,
    };
    for (const [id, hl] of Object.entries(expected)) expect(monacoLangToHljs(id), id).toBe(hl);
  });
});

describe('hljsLanguageFor', () => {
  it('sniffs a shebang only when given a first line', () => {
    expect(hljsLanguageFor('bin/x', '#!/usr/bin/env python3')).toBe('python');
    expect(hljsLanguageFor('bin/x', null)).toBeNull();
  });

  it('resolves by path, and a path language wins over the first line', () => {
    expect(hljsLanguageFor('Makefile', null)).toBe('makefile');
    expect(hljsLanguageFor('Cargo.toml', null)).toBe('ini');
    expect(hljsLanguageFor('a.ts', '#!/usr/bin/env python3')).toBe('typescript');
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

describe('applyEmphasis', () => {
  it('is a no-op (all emph:false) when there are no spans', () => {
    const segs: Seg[] = [{ text: 'const x = 1', cls: 'hljs-keyword' }];
    expect(applyEmphasis(segs, undefined)).toEqual([
      { text: 'const x = 1', cls: 'hljs-keyword', emph: false },
    ]);
    expect(applyEmphasis(segs, [])).toEqual([
      { text: 'const x = 1', cls: 'hljs-keyword', emph: false },
    ]);
  });

  it('splits a single segment at a span boundary, tagging only the changed slice', () => {
    const segs: Seg[] = [{ text: 'value = 1;', cls: null }];
    const out = applyEmphasis(segs, [{ start: 8, end: 9 }]);
    expect(out).toEqual([
      { text: 'value = ', cls: null, emph: false },
      { text: '1', cls: null, emph: true },
      { text: ';', cls: null, emph: false },
    ]);
  });

  it('preserves the syntax class on the emphasized slice (composes with highlighting)', () => {
    // Real hljs segments for a TS line, emphasize the number token only.
    const segs = highlightLine('const x = 1', 'typescript');
    const numIdx = 'const x = '.length; // the "1"
    const out = applyEmphasis(segs, [{ start: numIdx, end: numIdx + 1 }]);
    const emphd = out.filter((s) => s.emph);
    expect(emphd).toHaveLength(1);
    expect(emphd[0].text).toBe('1');
    expect(emphd[0].cls).toContain('hljs-number');
    expect(concat(out)).toBe('const x = 1');
  });

  it('spans a boundary that crosses two segments, tagging both pieces', () => {
    const segs: Seg[] = [
      { text: 'foo', cls: 'a' },
      { text: 'bar', cls: 'b' },
    ];
    const out = applyEmphasis(segs, [{ start: 2, end: 4 }]);
    expect(out).toEqual([
      { text: 'fo', cls: 'a', emph: false },
      { text: 'o', cls: 'a', emph: true },
      { text: 'b', cls: 'b', emph: true },
      { text: 'ar', cls: 'b', emph: false },
    ]);
  });

  it('always preserves the concat invariant', () => {
    const segs = highlightLine('const answer = 42;', 'typescript');
    const out = applyEmphasis(segs, [{ start: 15, end: 17 }]);
    expect(concat(out)).toBe('const answer = 42;');
  });
});
