/**
 * The navigation-outcome classifier and its copy — docs/specs/2026-08-21-goto-definition-flows.md
 * contract 3 (rows 12, 13, 37, 38, 39, 40, 45).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyNavOutcome,
  declarationLineFor,
  lineOfOffset,
  NAV_HOP_CAP,
  type NavClassifyInput,
  type NavMessageContext,
  navCommandKind,
  navOutcomeMessage,
  resolvingMessage,
  type SpecifierSpan,
  sourceSpecifierSpans,
  specifierForAlias,
  specifierSpanAt,
  UNRESOLVED_MODULE_CODES,
  unresolvedSpecifierSpans,
} from '../../webview/nav-outcome';

const base: NavClassifyInput = {
  kind: 'definition',
  resultCount: 0,
  soleResultIsUnresolvedAlias: false,
  unresolved: null,
  indexReady: true,
  supported: true,
  timedOut: false,
};
const at = (o: Partial<NavClassifyInput>) => classifyNavOutcome({ ...base, ...o });

describe('navCommandKind', () => {
  it('maps every command the editor menu can dispatch', () => {
    expect(navCommandKind('editor.action.revealDefinition')).toBe('definition');
    expect(navCommandKind('editor.action.goToTypeDefinition')).toBe('typeDefinition');
    expect(navCommandKind('editor.action.goToImplementation')).toBe('implementation');
    expect(navCommandKind('editor.action.goToReferences')).toBe('references');
    expect(navCommandKind('editor.action.referenceSearch.trigger')).toBe('references');
    expect(navCommandKind('editor.action.peekDefinition')).toBe('peek');
    expect(navCommandKind('editor.action.somethingElse')).toBeNull();
  });
});

describe('classifyNavOutcome', () => {
  it('a non-TS model is unsupported before anything else is considered', () => {
    expect(at({ supported: false, resultCount: 3 })).toEqual({ kind: 'unsupported' });
  });

  it('a blown deadline beats every result-shaped verdict', () => {
    expect(at({ timedOut: true, resultCount: 1 })).toEqual({ kind: 'timed-out' });
  });

  it('exactly one definition result navigates', () => {
    expect(at({ resultCount: 1 })).toEqual({ kind: 'navigated' });
    expect(at({ kind: 'typeDefinition', resultCount: 1 })).toEqual({ kind: 'navigated' });
    expect(at({ kind: 'implementation', resultCount: 1 })).toEqual({ kind: 'navigated' });
  });

  it('two or more results peek — row 12, and NO toast', () => {
    expect(at({ resultCount: 2 })).toEqual({ kind: 'peeked' });
    expect(at({ resultCount: 9 })).toEqual({ kind: 'peeked' });
  });

  it('references and peek commands peek even with a single result — row 13', () => {
    expect(at({ kind: 'references', resultCount: 1 })).toEqual({ kind: 'peeked' });
    expect(at({ kind: 'peek', resultCount: 1 })).toEqual({ kind: 'peeked' });
  });

  it('references with nothing found is none, not peeked', () => {
    expect(at({ kind: 'references', resultCount: 0 })).toEqual({ kind: 'none' });
  });

  it('zero results with an unresolved specifier is resolving — row 37', () => {
    expect(at({ unresolved: { specifier: 'zod', fromFile: 'file:///g:/p/src/a.ts' } })).toEqual({
      kind: 'resolving',
      specifier: 'zod',
      fromFile: 'file:///g:/p/src/a.ts',
    });
  });

  it('a lone import alias for an unresolved module is resolving, not navigated', () => {
    expect(
      at({
        resultCount: 1,
        soleResultIsUnresolvedAlias: true,
        unresolved: { specifier: 'zod', fromFile: 'file:///g:/p/src/a.ts' },
      }),
    ).toEqual({ kind: 'resolving', specifier: 'zod', fromFile: 'file:///g:/p/src/a.ts' });
  });

  it('a lone alias whose module DID resolve is a plain navigation', () => {
    expect(at({ resultCount: 1, soleResultIsUnresolvedAlias: false })).toEqual({
      kind: 'navigated',
    });
  });

  it('zero results with nothing unresolved is none — rows 37/40', () => {
    expect(at({ resultCount: 0 })).toEqual({ kind: 'none' });
    expect(at({ resultCount: 0, indexReady: false })).toEqual({ kind: 'none' });
  });

  it('an unresolved specifier still says resolving while the index streams — row 45', () => {
    expect(at({ indexReady: false, unresolved: { specifier: 'zod', fromFile: 'f' } }).kind).toBe(
      'resolving',
    );
  });
});

describe('navOutcomeMessage', () => {
  const ready = { loaded: 900, total: 900, done: true, skipped: 0, capped: 0 };
  const ctx = (over: Partial<Parameters<typeof navOutcomeMessage>[1]> = {}) => ({
    kind: 'definition' as const,
    word: 'foo',
    index: ready,
    ...over,
  });

  it('says nothing for a successful navigation or peek — row 12/13 have no toast', () => {
    expect(navOutcomeMessage({ kind: 'navigated' }, ctx())).toBeNull();
    expect(navOutcomeMessage({ kind: 'peeked' }, ctx())).toBeNull();
  });

  it('names the symbol inline when nothing exists — row 37', () => {
    const m = navOutcomeMessage({ kind: 'none' }, ctx());
    expect(m).toEqual({ text: "No definition for 'foo' here", channel: 'inline', variant: 'info' });
  });

  it('is honest about whitespace / a keyword — row 40', () => {
    expect(navOutcomeMessage({ kind: 'none' }, ctx({ word: null }))?.text).toBe(
      'Nothing to navigate to here',
    );
  });

  it('adapts the noun to the command', () => {
    expect(navOutcomeMessage({ kind: 'none' }, ctx({ kind: 'references' }))?.text).toBe(
      "No references for 'foo' here",
    );
    expect(navOutcomeMessage({ kind: 'none' }, ctx({ kind: 'typeDefinition' }))?.text).toBe(
      "No type definition for 'foo' here",
    );
    expect(navOutcomeMessage({ kind: 'none' }, ctx({ kind: 'implementation' }))?.text).toBe(
      "No implementation for 'foo' here",
    );
  });

  it('reports index progress instead of a false negative — row 45', () => {
    const m = navOutcomeMessage(
      { kind: 'none' },
      ctx({ index: { loaded: 120, total: 900, done: false, skipped: 0, capped: 0 } }),
    );
    expect(m?.text).toBe('Still indexing this project (120 of 900 files). Try again in a moment.');
    expect(m?.channel).toBe('inline');
  });

  it('says warming up when the stream has not reported a total yet', () => {
    expect(
      navOutcomeMessage(
        { kind: 'none' },
        ctx({ index: { loaded: 0, total: 0, done: false, skipped: 0, capped: 0 } }),
      )?.text,
    ).toBe('This project hasn’t been indexed yet — cross-file navigation is still warming up.');
  });

  it('prefers index progress over "not indexed" while the stream is running — row 45', () => {
    // The specifier the cap fixture misses on IS unresolved mid-stream, so `resolving` is the
    // verdict; claiming it "isn't indexed" would be a lie about a file still on its way.
    const m = navOutcomeMessage(
      { kind: 'resolving', specifier: './zzz-cap-target', fromFile: 'f' },
      ctx({ index: { loaded: 3000, total: 5000, done: false, skipped: 0, capped: 0 } }),
    );
    expect(m?.text).toBe(
      'Still indexing this project (3000 of 5000 files). Try again in a moment.',
    );
  });

  it('never claims a package has no definition — it says it is not indexed', () => {
    const m = navOutcomeMessage({ kind: 'resolving', specifier: 'zod', fromFile: 'f' }, ctx());
    expect(m).toEqual({
      text: "Can’t navigate into 'zod' — it isn’t indexed",
      channel: 'inline',
      variant: 'info',
    });
    expect(m?.text).not.toMatch(/no definition/i);
  });

  it('admits the files the cap left out — row 34', () => {
    const m = navOutcomeMessage(
      { kind: 'resolving', specifier: './zzz-cap-target', fromFile: 'f' },
      ctx({ index: { loaded: 5000, total: 5000, done: true, skipped: 0, capped: 710 } }),
    );
    expect(m?.text).toBe(
      "Can’t navigate into './zzz-cap-target' — it isn’t indexed (710 files beyond the index cap)",
    );
  });

  it('admits the oversized files it refused to read — row 17', () => {
    const m = navOutcomeMessage(
      { kind: 'resolving', specifier: './huge', fromFile: 'f' },
      ctx({ index: { loaded: 608, total: 608, done: true, skipped: 1, capped: 0 } }),
    );
    expect(m?.text).toBe(
      "Can’t navigate into './huge' — it isn’t indexed (1 file over 2 MB skipped)",
    );
  });

  it('reports both gaps, and pluralises each', () => {
    const m = navOutcomeMessage(
      { kind: 'none' },
      ctx({ index: { loaded: 5000, total: 5000, done: true, skipped: 3, capped: 1 } }),
    );
    expect(m?.text).toBe(
      "No definition for 'foo' here (1 file beyond the index cap, 3 files over 2 MB skipped)",
    );
  });

  it('stays silent about gaps while the index is still streaming', () => {
    // Mid-stream the honest advice is "try again", and a cap the stream hasn't reached yet is
    // not why THIS lookup missed.
    const m = navOutcomeMessage(
      { kind: 'none' },
      ctx({ index: { loaded: 10, total: 5000, done: false, skipped: 2, capped: 700 } }),
    );
    expect(m?.text).toBe('Still indexing this project (10 of 5000 files). Try again in a moment.');
  });

  it('keeps the existing unsupported / timed-out copy on the toast channel', () => {
    expect(navOutcomeMessage({ kind: 'unsupported' }, ctx())).toEqual({
      text: 'Code navigation is only available for JS/TS files.',
      channel: 'toast',
      variant: 'info',
    });
    expect(navOutcomeMessage({ kind: 'timed-out' }, ctx())).toEqual({
      text: 'Couldn’t resolve in time. Try again.',
      channel: 'toast',
      variant: 'error',
    });
  });

  it('the in-flight notice names what is being fetched', () => {
    expect(resolvingMessage('date-fns/format')).toEqual({
      text: "Resolving 'date-fns/format'…",
      channel: 'inline',
      variant: 'info',
    });
  });
});

describe('unresolved specifier extraction', () => {
  const text = `import { z } from 'zod';\nimport { a } from './a';\nimport L from "lodash";\n`;
  const spanOf = (needle: string) => ({ start: text.indexOf(needle), length: needle.length });

  it('reads the specifier out of the diagnostic SPAN, not the message text', () => {
    const spans = unresolvedSpecifierSpans(
      [
        { code: 2307, ...spanOf(`'zod'`), messageText: "Cannot find module 'zod'." },
        { code: 7016, ...spanOf(`"lodash"`), messageText: 'Could not find a declaration file' },
      ],
      text,
    );
    expect(spans.map((s) => s.specifier)).toEqual(['zod', 'lodash']);
  });

  it('drops diagnostics that are not module-resolution failures', () => {
    expect(unresolvedSpecifierSpans([{ code: 2322, start: 0, length: 3 }], text)).toEqual([]);
    expect([...UNRESOLVED_MODULE_CODES].sort()).toEqual([2307, 2792, 7016]);
  });

  it('drops a span that is not a quoted literal (defensive against a shifted model)', () => {
    expect(unresolvedSpecifierSpans([{ code: 2307, start: 0, length: 6 }], text)).toEqual([]);
  });

  it('finds the span under the cursor — cursor parked on the specifier itself', () => {
    const spans = unresolvedSpecifierSpans([{ code: 2307, ...spanOf(`'zod'`) }], text);
    expect(specifierSpanAt(spans, text.indexOf('zod') + 1)?.specifier).toBe('zod');
    expect(specifierSpanAt(spans, 0)).toBeNull();
  });

  it('walks an alias forward to its own import specifier', () => {
    const spans = unresolvedSpecifierSpans(
      [
        { code: 2307, ...spanOf(`'zod'`) },
        { code: 7016, ...spanOf(`"lodash"`) },
      ],
      text,
    );
    const zAlias = { start: text.indexOf('z }'), length: 1 };
    expect(specifierForAlias(zAlias, spans, text)?.specifier).toBe('zod');
    const lAlias = { start: text.indexOf('L from'), length: 1 };
    expect(specifierForAlias(lAlias, spans, text)?.specifier).toBe('lodash');
  });

  it('does not jump across a statement boundary to a LATER unresolved import', () => {
    const aAlias = { start: text.indexOf('a }'), length: 1 };
    const spans = unresolvedSpecifierSpans([{ code: 7016, ...spanOf(`"lodash"`) }], text);
    expect(specifierForAlias(aAlias, spans, text)).toBeNull();
  });

  it('handles a multi-line import', () => {
    const t = `import {\n  first,\n  second,\n} from '@scope/pkg';\n`;
    const spans = unresolvedSpecifierSpans(
      [{ code: 2307, start: t.indexOf(`'@scope/pkg'`), length: `'@scope/pkg'`.length }],
      t,
    );
    expect(specifierForAlias({ start: t.indexOf('first'), length: 5 }, spans, t)?.specifier).toBe(
      '@scope/pkg',
    );
  });
});

describe('hop budget', () => {
  it('is the documented cap', () => {
    expect(NAV_HOP_CAP).toBe(4);
  });
});

describe('specifierForAlias is anchored to the enclosing statement (review D2)', () => {
  const spansIn = (text: string, needle: string) =>
    unresolvedSpecifierSpans(
      [{ code: 2307, start: text.indexOf(needle), length: needle.length }],
      text,
    );

  it('does not walk a comment into the import below it', () => {
    // The regression: `helper` produces zero results, the wordSpan fallback walks forward, and
    // a punctuation-based guard finds no `;` and no `}` in the gap — so it claimed the file
    // could not navigate into 'zod' when the honest answer is "nothing here".
    const t = `// helper stuff\nimport { z } from 'zod';\n`;
    const spans = spansIn(t, `'zod'`);
    expect(specifierForAlias({ start: t.indexOf('helper'), length: 6 }, spans, t)).toBeNull();
  });

  it('does not walk plain code into the import below it', () => {
    const t = `const helper = 1;\nimport { z } from 'zod';\n`;
    const spans = spansIn(t, `'zod'`);
    expect(specifierForAlias({ start: t.indexOf('helper'), length: 6 }, spans, t)).toBeNull();
  });

  it('holds the boundary in a file with no semicolons at all', () => {
    const t = `import { a } from './a'\nimport { z } from 'zod'\n`;
    const spans = spansIn(t, `'zod'`);
    // `a` belongs to the FIRST import; the unresolved specifier belongs to the second.
    expect(specifierForAlias({ start: t.indexOf('a }'), length: 1 }, spans, t)).toBeNull();
    // …and the alias that really does come through 'zod' still resolves to it.
    expect(specifierForAlias({ start: t.indexOf('z }'), length: 1 }, spans, t)?.specifier).toBe(
      'zod',
    );
  });

  it('holds the boundary across a `}` + newline + import', () => {
    const t = `import {\n  a,\n} from './a';\nimport {\n  z,\n} from 'zod';\n`;
    const spans = spansIn(t, `'zod'`);
    expect(specifierForAlias({ start: t.indexOf('  a,') + 2, length: 1 }, spans, t)).toBeNull();
    expect(
      specifierForAlias({ start: t.indexOf('  z,') + 2, length: 1 }, spans, t)?.specifier,
    ).toBe('zod');
  });

  it('returns null when nothing statement-shaped precedes the span', () => {
    const t = `zod\n`;
    expect(
      specifierForAlias({ start: 0, length: 1 }, [{ specifier: 'zod', start: 1, length: 2 }], t),
    ).toBeNull();
  });
});

describe('extraction covers the template-literal specifier form (review 4)', () => {
  it('reads a no-substitution template specifier', () => {
    const t = 'const m = await import(`zod`);\n';
    const spans = unresolvedSpecifierSpans(
      [{ code: 2307, start: t.indexOf('`zod`'), length: 5 }],
      t,
    );
    expect(spans.map((s) => s.specifier)).toEqual(['zod']);
    expect(specifierSpanAt(spans, t.indexOf('zod'))?.specifier).toBe('zod');
  });
});

describe('a failed probe never degrades into a navigation (review D1/1)', () => {
  it('a timed-out diagnostics probe on a lone alias reports, it does not navigate', () => {
    // The old bug in one line: if the miss-probe cannot tell "nothing unresolved" from "the
    // question timed out", a lone import alias classifies as `navigated` and the caret lands
    // on the import clause — which is exactly what this spec exists to remove.
    expect(
      at({ resultCount: 1, soleResultIsUnresolvedAlias: true, unresolved: null, timedOut: true }),
    ).toEqual({ kind: 'timed-out' });
  });

  it('the timed-out outcome always carries a visible message', () => {
    const m = navOutcomeMessage(
      { kind: 'timed-out' },
      {
        kind: 'definition',
        word: null,
        index: { loaded: 0, total: 0, done: false, skipped: 0, capped: 0 },
      },
    );
    expect(m?.text).toBe('Couldn’t resolve in time. Try again.');
  });
});

describe('sourceSpecifierSpans — the JS path with no diagnostics (row 19b)', () => {
  it('finds an import specifier and its span in plain source text', () => {
    const text = "import { thing } from '~js/target';\nexport const use = thing;\n";
    const spans = sourceSpecifierSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0].specifier).toBe('~js/target');
    expect(text.slice(spans[0].start, spans[0].start + spans[0].length)).toBe("'~js/target'");
  });

  it('covers the require, dynamic-import and `export *` forms', () => {
    const text = [
      "const a = require('pkg-a');",
      "const b = await import('pkg-b');",
      "export * from 'pkg-c';",
      "import 'pkg-d';",
    ].join('\n');
    expect(sourceSpecifierSpans(text).map((s) => s.specifier)).toEqual([
      'pkg-a',
      'pkg-b',
      'pkg-c',
      'pkg-d',
    ]);
  });

  it('feeds specifierForAlias the same way diagnostic spans do', () => {
    const text = "import { markerAlias } from '~js/target';\n";
    const alias = { start: text.indexOf('markerAlias'), length: 'markerAlias'.length };
    expect(specifierForAlias(alias, sourceSpecifierSpans(text), text)?.specifier).toBe(
      '~js/target',
    );
  });

  it('reports nothing for a file with no imports', () => {
    expect(sourceSpecifierSpans('export const x = 1;\n')).toEqual([]);
  });
});

describe('specifierForAlias rejects a specifier the cursor never pointed at (review D3)', () => {
  const spanFor = (text: string, spans: SpecifierSpan[], token: string) =>
    specifierForAlias({ start: text.indexOf(token), length: token.length }, spans, text);

  it('does not adopt a dynamic import from a function body the cursor sits in — JS', () => {
    const text = [
      "import { a } from './x';",
      'export function f() {',
      '  const y = something;',
      "  return import('./lazy.js');",
      '}',
      '',
    ].join('\n');
    expect(spanFor(text, sourceSpecifierSpans(text), 'something')).toBeNull();
  });

  it('does not adopt a later import from an exported arrow body — TS', () => {
    const text = [
      "import type { T } from './t';",
      'export const load = async () => {',
      '  const unrelatedIdentifier = 1;',
      "  return import('./missing-module');",
      '};',
      '',
    ].join('\n');
    expect(spanFor(text, sourceSpecifierSpans(text), 'unrelatedIdentifier')).toBeNull();
  });

  it('does not let a cursor between two imports adopt the second one', () => {
    const text = [
      "import { first } from './one';",
      'const between = 1;',
      "import { second } from './two';",
      '',
    ].join('\n');
    expect(spanFor(text, sourceSpecifierSpans(text), 'between')).toBeNull();
  });

  it('still resolves an alias in a multi-line import clause', () => {
    const text = ['import {', '  markerAlias,', '  other,', "} from './target';", ''].join('\n');
    expect(spanFor(text, sourceSpecifierSpans(text), 'markerAlias')?.specifier).toBe('./target');
  });

  it('still resolves a plain single-line import and a re-export', () => {
    const plain = "import { markerAlias } from './target';\n";
    expect(spanFor(plain, sourceSpecifierSpans(plain), 'markerAlias')?.specifier).toBe('./target');
    const barrel = "export { markerAlias } from './leaf';\n";
    expect(spanFor(barrel, sourceSpecifierSpans(barrel), 'markerAlias')?.specifier).toBe('./leaf');
  });
});

describe('declarationLineFor — locating a symbol in a landed entry (review D2)', () => {
  it('finds the common declaration heads, 1-based', () => {
    const cases = {
      'export const marker = 1;': 'marker',
      'export declare const marker: number;': 'marker',
      'export default function marker() {}': 'marker',
      'export abstract class marker {}': 'marker',
      'export interface marker { a: number }': 'marker',
      'export type marker = string;': 'marker',
      'export enum marker { A }': 'marker',
      'declare namespace marker {}': 'marker',
      'export function* marker() {}': 'marker',
      'let marker = 1;': 'marker',
    };
    for (const [line, name] of Object.entries(cases)) {
      expect(declarationLineFor(`// head\n${line}\n`, name), line).toBe(2);
    }
  });

  it('finds a re-export, plain and renamed', () => {
    expect(declarationLineFor("// a\n// b\nexport { marker } from './x';\n", 'marker')).toBe(3);
    expect(declarationLineFor("export { inner as marker } from './x';\n", 'marker')).toBe(1);
    expect(declarationLineFor("export type { marker } from './x';\n", 'marker')).toBe(1);
    expect(declarationLineFor("export {\n  marker,\n} from './x';\n", 'marker')).toBe(2);
  });

  it('reports null rather than guessing when the symbol is absent', () => {
    expect(declarationLineFor('export const other = 1;\n', 'marker')).toBeNull();
    // A mention is not a declaration: landing on a usage would be the wrong-but-plausible jump.
    expect(declarationLineFor('const x = marker + 1;\n', 'marker')).toBeNull();
    expect(declarationLineFor("export { markerOther } from './x';\n", 'marker')).toBeNull();
  });

  it('refuses a name that is not an identifier, rather than splicing it into a pattern', () => {
    expect(declarationLineFor('export const a = 1;\n', 'a|b')).toBeNull();
    expect(declarationLineFor('export const a = 1;\n', '.*')).toBeNull();
  });
});

describe('lineOfOffset', () => {
  it('maps an offset to its 1-based line', () => {
    const text = 'one\ntwo\nthree';
    expect(lineOfOffset(text, 0)).toBe(1);
    expect(lineOfOffset(text, text.indexOf('two'))).toBe(2);
    expect(lineOfOffset(text, text.indexOf('three'))).toBe(3);
    expect(lineOfOffset(text, 9999)).toBe(3);
  });
});

describe('the opened-entry outcome (review D2)', () => {
  const ctx: NavMessageContext = {
    kind: 'definition',
    word: 'markerX',
    index: { loaded: 9, total: 9, done: true, skipped: 0, capped: 0 },
  };

  it('says what happened instead of passing for a navigation', () => {
    const msg = navOutcomeMessage({ kind: 'opened-entry', specifier: 'zod', name: 'markerX' }, ctx);
    expect(msg?.text).toBe("Opened 'zod' — couldn’t find 'markerX' inside it");
    expect(msg?.channel).toBe('inline');
  });

  it('drops the name when there was none', () => {
    expect(
      navOutcomeMessage({ kind: 'opened-entry', specifier: 'zod', name: null }, ctx)?.text,
    ).toBe("Opened 'zod' — couldn’t find the definition inside it");
  });

  it('reports itself even while the project index is still streaming', () => {
    const streaming = { ...ctx, index: { ...ctx.index, done: false, loaded: 2 } };
    expect(
      navOutcomeMessage({ kind: 'opened-entry', specifier: 'zod', name: 'markerX' }, streaming)
        ?.text,
    ).toContain("Opened 'zod'");
  });

  it('a real navigation still says nothing', () => {
    expect(navOutcomeMessage({ kind: 'navigated' }, ctx)).toBeNull();
  });
});
