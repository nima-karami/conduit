import { describe, expect, it } from 'vitest';
import { groovy } from '../../webview/groovy-grammar';
import { tokenizeLines } from './grammar-runner';

/** Java's tokens carry a suffix (`keyword.def`, `number.float`); the test names the family. */
const lines = (...text: string[]) =>
  tokenizeLines(groovy, text).map((l) => l.map(([t, tok]) => [t, tok.split('.')[0]]));
const line = (text: string) => lines(text)[0];
const tokenOf = (text: string, part: string) => line(text).find(([t]) => t === part)?.[1];
const ref = (name: string) => `\${${name}}`;

describe('groovy grammar', () => {
  it("reads a single-quoted string whole, not as Java's invalid char literal", () => {
    expect(tokenOf("version = '3.2.0'", "'3.2.0'")).toBe('string');
    expect(tokenOf("def flag = 'true'", "'true'")).toBe('string');
    expect(tokenizeLines(groovy, ["x = 'a\\'b'"])[0].slice(2)).toEqual([
      ["'a", 'string'],
      ["\\'", 'string.escape'],
      ["b'", 'string'],
    ]);
  });

  it("doesn't leak an unterminated single-quoted string past its line", () => {
    expect(lines("x = 'abc", 'def y = 1')[1]).toEqual([
      ['def', 'keyword'],
      ['y', 'identifier'],
      ['=', 'delimiter'],
      ['1', 'number'],
    ]);
  });

  it('reads \'\'\' and """ strings across lines', () => {
    const sq = lines("x = '''one", 'def two', "three'''", 'def');
    expect(sq[1]).toEqual([['def two', 'string']]);
    expect(sq[3]).toEqual([['def', 'keyword']]);
    const dq = lines('x = """one', 'def two', 'three"""', 'def');
    expect(dq[1]).toEqual([['def two', 'string']]);
    expect(dq[3]).toEqual([['def', 'keyword']]);
  });

  it('reads GString interpolation, braced and $name, inside double quotes only', () => {
    expect(line(`"a ${ref('b.c')} d"`)).toEqual([
      ['"a ', 'string'],
      ['${', 'delimiter'],
      ['b', 'identifier'],
      ['.', 'delimiter'],
      ['c', 'identifier'],
      ['}', 'delimiter'],
      [' d"', 'string'],
    ]);
    expect(tokenOf('"hi $name!"', '$name')).toBe('identifier');
    expect(line(`'a ${ref('b')} $c'`)).toEqual([[`'a ${ref('b')} $c'`, 'string']]);
    expect(tokenOf(`"""x ${ref('y')}"""`, 'y')).toBe('identifier');
  });

  it('counts braces inside an interpolation, and a quote in it is a nested string', () => {
    const toks = line(`"${ref('m.collect { it }')} ${ref('m["k"]')}" + def`);
    expect(toks.filter(([, t]) => t === 'keyword').map(([t]) => t)).toEqual(['def']);
    expect(toks).toContainEqual(['"k"', 'string']);
  });

  it('reads Groovy keywords; DSL words stay plain identifiers', () => {
    for (const kw of ['def', 'in', 'as', 'trait', 'null', 'true']) {
      expect(tokenOf(`x ${kw} y`, kw), kw).toBe('keyword');
    }
    expect(tokenOf('pipeline {', 'pipeline')).toBe('identifier');
    expect(tokenOf("sh 'ls'", 'sh')).toBe('identifier');
  });

  it("keeps Java's comments and numbers", () => {
    expect(line('// c')).toEqual([['// c', 'comment']]);
    expect(tokenOf('x = 1.5', '1.5')).toBe('number');
  });

  it('survives interpolation nested deeper than Monaco allows a stack, and the next line recovers', () => {
    expect(lines(`"${'${'.repeat(200)}"`, 'def x')[1]).toEqual([
      ['def', 'keyword'],
      ['x', 'identifier'],
    ]);
  });

  it("doesn't leak an unterminated double-quoted string past its line, whatever it holds", () => {
    const next = [
      ['def', 'keyword'],
      ['y', 'identifier'],
    ];
    expect(lines(`def s = "abc ${ref('m["k"]')} def`, 'def y')[1]).toEqual(next);
    expect(lines(`def s = "abc ${ref('m')} 'q`, 'def y')[1]).toEqual(next);
    expect(lines(`def s = "abc ${ref('m(')}`, 'def y')[1]).toEqual(next);
    expect(lines(`def s = 'a\\'b`, 'def y')[1]).toEqual(next);
  });

  it('continues a one-line string over a trailing backslash', () => {
    expect(lines('x = "a \\', 'def"', 'def')).toEqual([
      [
        ['x', 'identifier'],
        ['=', 'delimiter'],
        ['"a \\', 'string'],
      ],
      [['def"', 'string']],
      [['def', 'keyword']],
    ]);
    expect(lines("x = 'a \\", "def'", 'def')[1]).toEqual([["def'", 'string']]);
  });

  it('keeps // comments, which a line ending must not break', () => {
    expect(lines('x = 1 // c', 'def')).toEqual([
      [
        ['x', 'identifier'],
        ['=', 'delimiter'],
        ['1', 'number'],
        ['// c', 'comment'],
      ],
      [['def', 'keyword']],
    ]);
  });

  it('lets a """ GString interpolation span lines', () => {
    expect(lines(`x = """a ${'${'}m.`, 'n} b', 'def"""')[1]).toEqual([
      ['n', 'identifier'],
      ['}', 'delimiter'],
      [' b', 'string'],
    ]);
  });
});
