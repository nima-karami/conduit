import { describe, expect, it } from 'vitest';
import { toml } from '../../webview/toml-grammar';
import { tokenizeLines } from './grammar-runner';

const line = (text: string) => tokenizeLines(toml, [text])[0];
const tokenOf = (text: string, part: string) => line(text).find(([t]) => t === part)?.[1];

describe('toml grammar', () => {
  it('reads table and array-of-tables headers whole, incl. dotted and quoted parts', () => {
    expect(line('[[bin]]')).toEqual([['[[bin]]', 'type']]);
    expect(line('[package]')).toEqual([['[package]', 'type']]);
    expect(line('[a."b c".d] # x')).toEqual([
      ['[a."b c".d]', 'type'],
      ['# x', 'comment'],
    ]);
  });

  it('reads a dotted, hyphenated key, a number and a trailing comment', () => {
    expect(line('a.b-c = 1 # x')).toEqual([
      ['a.b-c', 'keyword'],
      ['1', 'number'],
      ['# x', 'comment'],
    ]);
  });

  it('reads indented and quoted keys', () => {
    expect(line('  indented.key = "v"')).toEqual([
      ['indented.key', 'keyword'],
      ['"v"', 'string'],
    ]);
    expect(tokenOf('"quoted key" = 1', '"quoted key"')).toBe('keyword');
    expect(tokenOf("'lit' = 'x'", "'lit'")).toBe('keyword');
    expect(tokenOf('x = { y = 1 }', 'y')).toBe('keyword');
  });

  it('carries a """ basic multi-line string across lines', () => {
    expect(tokenizeLines(toml, ['s = """', 'body "q" \\"', 'end"""', 'n = 2'])).toEqual([
      [
        ['s', 'keyword'],
        ['"""', 'string'],
      ],
      [['body "q" \\"', 'string']],
      [['end"""', 'string']],
      [
        ['n', 'keyword'],
        ['2', 'number'],
      ],
    ]);
  });

  it("carries a ''' literal multi-line string across lines", () => {
    expect(tokenizeLines(toml, ["s = '''", 'a \\ b', "'''"]).slice(1)).toEqual([
      [['a \\ b', 'string']],
      [["'''", 'string']],
    ]);
  });

  it('reads integers, floats, specials, booleans and date-times as numbers', () => {
    for (const v of [
      '0x1F',
      '0o17',
      '0b101',
      '1_000',
      '-42',
      '+1.5e3',
      '3.14',
      'inf',
      '-inf',
      'nan',
      'true',
      'false',
      '1979-05-27T07:32:00Z',
      '1979-05-27 07:32:00.5-07:00',
      '1979-05-27',
      '07:32:00',
    ]) {
      expect(line(`k = ${v}`), v).toEqual([
        ['k', 'keyword'],
        [v, 'number'],
      ]);
    }
  });

  it('reads strings with escapes and leaves an unterminated one running to the line end', () => {
    expect(tokenOf('a = "x\\"y" # c', '"x\\"y"')).toBe('string');
    expect(tokenOf('a = "open', '"open')).toBe('string');
    expect(line('a = [1, "x"]')).toEqual([
      ['a', 'keyword'],
      ['1', 'number'],
      ['"x"', 'string'],
    ]);
  });

  it('does not read an array of arrays inside a value as a table header', () => {
    const lines = tokenizeLines(toml, ['a = [', '  [1, 2],', '  [3, 4]', ']', '[next]']);
    expect(lines[1]).toEqual([
      ['1', 'number'],
      ['2', 'number'],
    ]);
    expect(lines[2]).toEqual([
      ['3', 'number'],
      ['4', 'number'],
    ]);
    expect(lines[4]).toEqual([['[next]', 'type']]);
  });

  it('closes an unfinished array at a column-0 table header', () => {
    expect(tokenizeLines(toml, ['a = [1,', '[tool]', 'x = 1']).slice(1)).toEqual([
      [['[tool]', 'type']],
      [
        ['x', 'keyword'],
        ['1', 'number'],
      ],
    ]);
  });

  it('survives arrays nested deeper than Monaco allows a stack', () => {
    expect(() => tokenizeLines(toml, [`a = ${'['.repeat(200)}`, 'x = 1'])).not.toThrow();
  });

  it('reads keys and strings inside a multi-line array', () => {
    expect(tokenizeLines(toml, ['a = [', '  "x", # c', '  { y = 1 },', ']']).slice(1, 3)).toEqual([
      [
        ['"x"', 'string'],
        ['# c', 'comment'],
      ],
      [
        ['y', 'keyword'],
        ['1', 'number'],
      ],
    ]);
  });

  it('declares # comments and folds by indentation', () => {
    expect(toml.conf.comments?.lineComment).toBe('#');
    expect(toml.conf.folding?.offSide).toBe(true);
  });
});
