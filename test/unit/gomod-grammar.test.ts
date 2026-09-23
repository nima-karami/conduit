/**
 * The go.mod Monarch rules, run the way Monarch runs them: first rule whose regex matches
 * anchored at the cursor wins. Monaco can't load in the node env, so this is a minimal
 * interpreter over the exported definition; the real tokenizer is covered by go-files.e2e.
 */

import { describe, expect, it } from 'vitest';
import { gomod } from '../../webview/gomod-grammar';

type Action = string | { cases: Record<string, string> };
type Rule = [RegExp, Action];

const lang = gomod.language as unknown as {
  keywords: string[];
  tokenizer: { root: Rule[] };
};

function tokenize(line: string): [string, string][] {
  const rules = lang.tokenizer.root.map(
    ([re, action]) => [new RegExp(`^(?:${re.source})`), action] as const,
  );
  const out: [string, string][] = [];
  let pos = 0;
  while (pos < line.length) {
    const rest = line.slice(pos);
    let hit: [string, string] | null = null;
    for (const [re, action] of rules) {
      const m = re.exec(rest);
      if (!m || m[0] === '') continue;
      const text = m[0];
      let type: string;
      if (typeof action === 'string') type = action === '@brackets' ? 'bracket' : action;
      else
        type = lang.keywords.includes(text) ? action.cases['@keywords'] : action.cases['@default'];
      hit = [text, type];
      break;
    }
    if (!hit) hit = [line[pos], 'default'];
    pos += hit[0].length;
    if (hit[1] !== 'white') out.push(hit);
  }
  return out;
}

describe('gomod grammar', () => {
  it('reads a module line as keyword + identifier', () => {
    expect(tokenize('module example.com/hello')).toEqual([
      ['module', 'keyword'],
      ['example.com/hello', 'identifier'],
    ]);
  });

  it('colours line comments, including a trailing // indirect', () => {
    expect(tokenize('// top comment')).toEqual([['// top comment', 'comment']]);
    expect(tokenize('\tgolang.org/x/net v0.0.0-20210101000000-abcdef123456 // indirect')).toEqual([
      ['golang.org/x/net', 'identifier'],
      ['v0.0.0-20210101000000-abcdef123456', 'number'],
      ['// indirect', 'comment'],
    ]);
  });

  it('reads versions, +incompatible and a go directive (release and pre-release) as numbers', () => {
    expect(tokenize('github.com/pkg/errors v0.9.1+incompatible')[1]).toEqual([
      'v0.9.1+incompatible',
      'number',
    ]);
    expect(tokenize('go 1.22')).toEqual([
      ['go', 'keyword'],
      ['1.22', 'number'],
    ]);
    expect(tokenize('go 1.22rc1')[1]).toEqual(['1.22rc1', 'number']);
    expect(tokenize('go 1.23beta2')[1]).toEqual(['1.23beta2', 'number']);
    expect(tokenize('toolchain go1.23beta2')[1]).toEqual(['go1.23beta2', 'identifier']);
  });

  it('reads replace arrows and relative / absolute targets', () => {
    expect(tokenize('replace example.com/old => ./local')).toEqual([
      ['replace', 'keyword'],
      ['example.com/old', 'identifier'],
      ['=>', 'operator'],
      ['./local', 'identifier'],
    ]);
    expect(tokenize('replace a.com/x => ../fork')[3]).toEqual(['../fork', 'identifier']);
    expect(tokenize('replace a.com/x => /abs/fork')[3]).toEqual(['/abs/fork', 'identifier']);
    expect(tokenize('replace a.com/x => C:\\fork')[3]).toEqual(['C:\\fork', 'identifier']);
  });

  it('reads retract ranges as brackets around versions', () => {
    expect(tokenize('retract [v1.0.0, v1.9.9]')).toEqual([
      ['retract', 'keyword'],
      ['[', 'bracket'],
      ['v1.0.0', 'number'],
      [',', 'delimiter'],
      ['v1.9.9', 'number'],
      [']', 'bracket'],
    ]);
  });

  it('keeps major-version and digit-leading module paths whole identifiers', () => {
    expect(tokenize('require example.com/v2 v2.0.1')).toEqual([
      ['require', 'keyword'],
      ['example.com/v2', 'identifier'],
      ['v2.0.1', 'number'],
    ]);
    expect(tokenize('require 9fans.net/go v0.0.7')[1]).toEqual(['9fans.net/go', 'identifier']);
    expect(tokenize('require 4d63.com/x v1.0.0')[1]).toEqual(['4d63.com/x', 'identifier']);
  });

  it('runs an unterminated string to the end of the line instead of stalling', () => {
    expect(tokenize('module "unterminated x')).toEqual([
      ['module', 'keyword'],
      ['"unterminated x', 'string'],
    ]);
    expect(tokenize('use `raw')).toEqual([
      ['use', 'keyword'],
      ['`raw', 'string'],
    ]);
  });
});
