/**
 * AC-A8: every custom grammar tokenizes in linear time (spec 2026-10-08-language-coverage §2.3).
 * Monarch runs on the UI thread line by line, so one catastrophic regex freezes the editor. Timed
 * on Monaco's own tokenizer, starting in every state, since a state's rules only run once an
 * earlier rule has pushed it.
 */

import { describe, expect, it } from 'vitest';
import { cmake } from '../../webview/cmake-grammar';
import { diff } from '../../webview/diff-grammar';
import { type Grammar, gomod } from '../../webview/gomod-grammar';
import { groovy } from '../../webview/groovy-grammar';
import { ignore } from '../../webview/ignore-grammar';
import { log } from '../../webview/log-grammar';
import { makefile } from '../../webview/makefile-grammar';
import { toml } from '../../webview/toml-grammar';
import {
  grammarRegExps,
  grammarStates,
  grammarTokens,
  monarchTokenizer,
  rawTokens,
  tokenizeLines,
} from './grammar-runner';

const NEW: Record<string, Grammar> = { toml, diff, makefile, cmake, ignore };
const ALL: Record<string, Grammar> = { ...NEW, groovy, gomod, log };

/** Adversarial lines of `n` chars. Generators, so a longer line is one longer run — a rule that is
 *  quadratic in a single run's length shows it, which repeating a short line would hide. */
const ADVERSARIAL: ((n: number) => string)[] = [
  (n) => '['.repeat(n),
  (n) => `"${'a'.repeat(n - 1)}`,
  (n) => `'${'a'.repeat(n - 1)}`,
  (n) => '\\'.repeat(n),
  (n) => '$('.repeat(n / 2),
  (n) => '${'.repeat(n / 2),
  (n) => `${'1'.repeat(n - 1)}a`,
  (n) => 'a.'.repeat(n / 2),
  (n) => ' '.repeat(n),
];

/** States with each numbered family (`interp1`…`interp8`) cut to its first member: the depth
 *  states share every rule but the `next` target, so timing all of them repeats one measurement. */
function representativeStates(grammar: Grammar): string[] {
  return grammarStates(grammar).filter((state) => !/^\D+(?:[2-9]|\d{2,})$/.test(state));
}

/** Grouped wall samples can put scheduler stalls on one size; interleaved minima limit that bias. */
function elapsedPair(
  short: () => void,
  full: () => void,
): { quarter: number; full: number; fullMedian: number } {
  short();
  full();
  let quarter = Infinity;
  const fullSamples: number[] = [];
  const measure = (fn: () => void): number => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };
  for (let i = 0; i < 5; i++) {
    if (i % 2 === 0) {
      quarter = Math.min(quarter, measure(short));
      fullSamples.push(measure(full));
    } else {
      fullSamples.push(measure(full));
      quarter = Math.min(quarter, measure(short));
    }
  }
  fullSamples.sort((a, b) => a - b);
  return { quarter, full: fullSamples[0] ?? 0, fullMedian: fullSamples[2] ?? 0 };
}

describe('grammar runner', () => {
  it("is Monaco's Monarch: `@@` in a rule is a literal single `@`", () => {
    const toy: Grammar = {
      conf: {},
      language: { tokenPostfix: '.t', tokenizer: { root: [[/@@x/, 'keyword']] } },
    };
    expect(tokenizeLines(toy, ['@x'])).toEqual([[['@x', 'keyword']]]);
  });
});

describe('grammar linearity', () => {
  for (const [name, grammar] of Object.entries(ALL)) {
    // A hang guard only: linearity is checked separately by the 20k→80k ratio.
    // One run per cell, no warm-up or median: a hang is slow on its first run, and a grammar with
    // many states (groovy's interpolation depths) otherwise pays six runs for each of them.
    it(`${name} tokenizes adversarial 20 000-char lines from every state without hanging`, () => {
      for (const state of grammarStates(grammar)) {
        const tokenizer = monarchTokenizer(grammar, state);
        for (const make of ADVERSARIAL) {
          const line = make(20000);
          const start = performance.now();
          rawTokens(tokenizer, [line, '']);
          const t20k = performance.now() - start;
          expect(
            t20k,
            `${name}@${state} hang guard on ${JSON.stringify(line.slice(0, 6))}…`,
          ).toBeLessThan(2000);
        }
      }
    });
  }

  for (const [name, grammar] of Object.entries(ALL)) {
    // Independent of machine speed: quadrupling a linear rule's input quadruples its time, a
    // quadratic one's sixteen-fold. Monarch allocates a token per step, so GC lifts a linear
    // rule to ~6× at these sizes; 10× still sits well below quadratic.
    // The timeout leaves room for a quadratic rule to finish and fail the ratio, not time out.
    it(`${name} scales linearly on adversarial lines from every state`, {
      timeout: 120_000,
    }, () => {
      for (const state of representativeStates(grammar)) {
        const tokenizer = monarchTokenizer(grammar, state);
        for (const make of ADVERSARIAL) {
          // 20 000 vs 80 000 chars: the shorter run must itself take long enough that timer and
          // GC jitter can't move the ratio (CI measured 8.0–8.1 for a linear rule at 5 000).
          const short = make(20000);
          const line = make(80000);
          const { quarter, full, fullMedian } = elapsedPair(
            () => rawTokens(tokenizer, [short, '']),
            () => rawTokens(tokenizer, [line, '']),
          );
          if (fullMedian < 10) continue;
          expect(
            full / quarter,
            `${name}@${state} on ${JSON.stringify(line.slice(0, 6))}…`,
          ).toBeLessThan(10);
        }
      }
    });
  }

  for (const [name, grammar] of Object.entries({ ...NEW, groovy })) {
    it(`${name} has no nested quantifier in any rule`, () => {
      for (const re of grammarRegExps(grammar)) {
        expect(re.source, name).not.toMatch(/\((?:[^()\\]|\\.)*[+*}]\)[+*{]/);
      }
    });
  }

  // Groovy reuses Java's token names, which Monaco's base theme colours.
  for (const [name, grammar] of Object.entries(NEW)) {
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
