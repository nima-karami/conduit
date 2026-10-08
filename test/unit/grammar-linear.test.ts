/**
 * AC-A8: every custom grammar tokenizes in linear time (spec 2026-10-08-language-coverage §2.3).
 * Monarch runs on the UI thread line by line, so one catastrophic regex freezes the editor.
 */

import { describe, expect, it } from 'vitest';
import { cmake } from '../../webview/cmake-grammar';
import { diff } from '../../webview/diff-grammar';
import { type Grammar, gomod } from '../../webview/gomod-grammar';
import { ignore } from '../../webview/ignore-grammar';
import { log } from '../../webview/log-grammar';
import { makefile } from '../../webview/makefile-grammar';
import { toml } from '../../webview/toml-grammar';
import { grammarRegExps, grammarTokens, tokenizeLines } from './grammar-runner';

const NEW: Record<string, Grammar> = { toml, diff, makefile, cmake, ignore };
const ALL: Record<string, Grammar> = { ...NEW, gomod, log };

const ADVERSARIAL = ['['.repeat(20000), `"${'a'.repeat(19999)}`, '$('.repeat(10000)];

/**
 * Walks one state's rules the way Monarch does (first anchored match wins, else one character),
 * ignoring actions — gomod's `cases` and `@brackets` are outside the runner's subset, and a
 * state is only reachable through the runner when an earlier rule pushes it.
 */
function scanState(rules: readonly RegExp[], line: string): void {
  const compiled = rules.map((re) => {
    const atStart = re.source.startsWith('^');
    return { re: new RegExp(atStart ? re.source.slice(1) : re.source, 'y'), atStart };
  });
  let pos = 0;
  while (pos < line.length) {
    let step = 1;
    for (const r of compiled) {
      if (r.atStart && pos > 0) continue;
      r.re.lastIndex = pos;
      const m = r.re.exec(line);
      if (m && m[0] !== '') {
        step = m[0].length;
        break;
      }
    }
    pos += step;
  }
}

/** Best of three after a warm-up: a quadratic rule is slow every run, a GC pause only once. */
function elapsed(fn: () => void): number {
  fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe('grammar runner', () => {
  it('pushes a state and pops back to root across lines', () => {
    const toy: Grammar = {
      conf: {},
      language: {
        tokenizer: {
          root: [
            [/\/\*/, { token: 'comment', next: '@block' }],
            [/\w+/, 'keyword'],
          ],
          block: [
            [/\*\//, { token: 'comment', next: '@pop' }],
            [/[^*]+/, 'comment'],
            [/\*/, 'comment'],
          ],
        },
      },
    };
    expect(tokenizeLines(toy, ['a /* b', 'c */ d', 'e'])).toEqual([
      [
        ['a', 'keyword'],
        ['/* b', 'comment'],
      ],
      [
        ['c */', 'comment'],
        ['d', 'keyword'],
      ],
      [['e', 'keyword']],
    ]);
  });

  it('throws on a rule shape outside its subset', () => {
    const bad: Grammar = {
      conf: {},
      language: { tokenizer: { root: [[/x/, { cases: { '@default': 'keyword' } }]] } },
    };
    expect(() => tokenizeLines(bad, ['x'])).toThrow(/unsupported rule/);
  });
});

describe('grammar linearity', () => {
  for (const [name, grammar] of Object.entries(ALL)) {
    it(`${name} scans adversarial 20 000-char lines in < 50 ms per state`, () => {
      for (const rules of grammarRegExps(grammar)) {
        for (const line of ADVERSARIAL) {
          const ms = elapsed(() => scanState(rules, line));
          expect(ms, `${name} on ${JSON.stringify(line.slice(0, 6))}…`).toBeLessThan(50);
        }
      }
    });
  }

  for (const [name, grammar] of Object.entries(NEW)) {
    it(`${name} tokenizes adversarial 20 000-char lines in < 50 ms`, () => {
      for (const line of ADVERSARIAL) {
        const ms = elapsed(() => tokenizeLines(grammar, [line]));
        expect(ms, `${name} on ${JSON.stringify(line.slice(0, 6))}…`).toBeLessThan(50);
      }
    });

    it(`${name} has no nested quantifier in any rule`, () => {
      for (const re of grammarRegExps(grammar).flat()) {
        expect(re.source, name).not.toMatch(/\((?:[^()\\]|\\.)*[+*}]\)[+*{]/);
      }
    });

    it(`${name} emits only already-themed tokens`, () => {
      const allowed = new Set([
        'comment',
        'keyword',
        'string',
        'number',
        'type',
        'log-error',
        '',
        'white',
      ]);
      for (const t of grammarTokens(grammar)) expect(allowed.has(t), `${name}: ${t}`).toBe(true);
    });
  }
});
