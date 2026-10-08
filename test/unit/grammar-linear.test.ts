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
const ALL: Record<string, Grammar> = { ...NEW, gomod, log };

const ADVERSARIAL = [
  '['.repeat(20000),
  `"${'a'.repeat(19999)}`,
  '$('.repeat(10000),
  '${'.repeat(10000),
  `${'1'.repeat(19999)}a`,
  'a.'.repeat(10000),
  ' '.repeat(20000),
];

/** Best of five after a warm-up: a quadratic rule is slow every run, a GC pause only once. */
function elapsed(fn: () => void): number {
  fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
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
    // Retried because the gate runs every suite in parallel; each attempt must meet the budget.
    it(`${name} tokenizes adversarial 20 000-char lines in < 50 ms from every state`, {
      retry: 2,
    }, () => {
      for (const state of grammarStates(grammar)) {
        const tokenizer = monarchTokenizer(grammar, state);
        for (const line of ADVERSARIAL) {
          // Followed by a second line, so a grammar that reads the EOL sees it.
          const ms = elapsed(() => rawTokens(tokenizer, [line, '']));
          expect(ms, `${name}@${state} on ${JSON.stringify(line.slice(0, 6))}…`).toBeLessThan(50);
        }
      }
    });
  }

  for (const [name, grammar] of Object.entries(ALL)) {
    // Independent of machine speed: quadrupling a linear rule's input quadruples its time, a
    // quadratic one's sixteen-fold. 8× sits far enough from both that load noise can't cross it.
    it(`${name} scales linearly on adversarial lines from every state`, { retry: 2 }, () => {
      for (const state of grammarStates(grammar)) {
        const tokenizer = monarchTokenizer(grammar, state);
        for (const line of ADVERSARIAL) {
          const quarter = elapsed(() => rawTokens(tokenizer, [line.slice(0, line.length / 4), '']));
          const full = elapsed(() => rawTokens(tokenizer, [line, '']));
          // Below a few ms the ratio is timer noise, not growth.
          if (full < 5) continue;
          expect(
            full / quarter,
            `${name}@${state} on ${JSON.stringify(line.slice(0, 6))}…`,
          ).toBeLessThan(8);
        }
      }
    });
  }

  for (const [name, grammar] of Object.entries(NEW)) {
    it(`${name} has no nested quantifier in any rule`, () => {
      for (const re of grammarRegExps(grammar)) {
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
