import { describe, expect, it } from 'vitest';
import { cmake } from '../../webview/cmake-grammar';
import { tokenizeLines } from './grammar-runner';

const line = (text: string) => tokenizeLines(cmake, [text])[0];
const tokenOf = (text: string, part: string) => line(text).find(([t]) => t === part)?.[1];
/** `${name}` without a literal that reads as a mistyped template placeholder. */
const ref = (name: string) => `\${${name}}`;

describe('cmake grammar', () => {
  it('reads a command name before ( as keyword, in any case', () => {
    expect(line('add_executable(app main.cpp)')).toEqual([['add_executable', 'keyword']]);
    expect(tokenOf('ADD_EXECUTABLE (app)', 'ADD_EXECUTABLE')).toBe('keyword');
    expect(tokenOf('  if(WIN32)', 'if')).toBe('keyword');
  });

  it('reads variable references as number, nested too', () => {
    expect(tokenOf(`set(A ${ref('VAR')})`, ref('VAR'))).toBe('number');
    expect(tokenOf('set(A $ENV{X})', '$ENV{X}')).toBe('number');
    const nested = ref(`X_${ref('Y')}`);
    expect(tokenOf(`set(A ${nested})`, nested)).toBe('number');
  });

  it('reads quoted arguments as string, with references inside coloured', () => {
    expect(line('message("q")')).toEqual([
      ['message', 'keyword'],
      ['"q"', 'string'],
    ]);
    expect(line(`message("a ${ref('B')} c")`)).toEqual([
      ['message', 'keyword'],
      ['"a ', 'string'],
      [ref('B'), 'number'],
      [' c"', 'string'],
    ]);
  });

  it('carries a bracket argument across lines', () => {
    expect(tokenizeLines(cmake, ['set(X [=[ a', 'b ]] still', 'c ]=])'])).toEqual([
      [
        ['set', 'keyword'],
        ['[=[ a', 'string'],
      ],
      [['b ]] still', 'string']],
      [['c ]=]', 'string']],
    ]);
  });

  it('carries a bracket comment across lines and reads # comments', () => {
    expect(tokenizeLines(cmake, ['#[[ a', 'b ]] set(x)'])).toEqual([
      [['#[[ a', 'comment']],
      [
        ['b ]]', 'comment'],
        ['set', 'keyword'],
      ],
    ]);
    expect(line('set(x) # c')).toEqual([
      ['set', 'keyword'],
      ['# c', 'comment'],
    ]);
  });

  it('reads ON OFF TRUE FALSE as number, but not as part of a word', () => {
    for (const b of ['ON', 'OFF', 'TRUE', 'FALSE'])
      expect(tokenOf(`option(X "d" ${b})`, b), b).toBe('number');
    expect(tokenOf('set(ONLY 1)', 'ON')).toBeUndefined();
  });

  it('reads booleans in any case', () => {
    for (const b of ['on', 'Off', 'True', 'false', 'yes', 'No']) {
      expect(tokenOf(`option(X "d" ${b})`, b), b).toBe('number');
    }
  });

  it("doesn't leak an unterminated variable reference past its line", () => {
    for (const open of [`\${`, `\${VAR`, `\${a\${b`, '$ENV{X']) {
      expect(tokenizeLines(cmake, [`set(A ${open}`, 'set(B 1)'])[1], open).toEqual([
        ['set', 'keyword'],
        ['1', 'number'],
      ]);
    }
  });

  it('keeps a quoted argument open across lines after an unterminated reference in it', () => {
    expect(tokenizeLines(cmake, [`set(A "x \${B`, 'y" C)'])[1]).toEqual([['y"', 'string']]);
  });

  it('survives nesting deeper than Monaco allows a stack', () => {
    expect(() => tokenizeLines(cmake, [`\${`.repeat(200), 'set(x)'])).not.toThrow();
  });

  it('declares # comments, bracket comments and folds by indentation', () => {
    expect(cmake.conf.comments?.lineComment).toBe('#');
    expect(cmake.conf.folding?.offSide).toBe(true);
  });
});
