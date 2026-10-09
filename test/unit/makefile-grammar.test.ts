import { describe, expect, it } from 'vitest';
import { makefile } from '../../webview/makefile-grammar';
import { tokenizeLines } from './grammar-runner';

const line = (text: string) => tokenizeLines(makefile, [text])[0];
const tokenOf = (text: string, part: string) => line(text).find(([t]) => t === part)?.[1];

describe('makefile grammar', () => {
  it('reads comments, and a trailing backslash continues the comment', () => {
    expect(tokenizeLines(makefile, ['# c \\', 'next line', 'all: x'])).toEqual([
      [['# c \\', 'comment']],
      [['next line', 'comment']],
      [['all:', 'type']],
    ]);
    expect(tokenizeLines(makefile, ['# c', 'all: x'])[1]).toEqual([['all:', 'type']]);
  });

  it('reads targets, double-colon targets and pattern targets', () => {
    expect(line('all: dep')).toEqual([['all:', 'type']]);
    expect(line('clean::')).toEqual([['clean::', 'type']]);
    expect(tokenOf('%.o: %.c', '%.o:')).toBe('type');
  });

  it('reads every assignment operator as keyword', () => {
    expect(line('CC := gcc')).toEqual([['CC :=', 'keyword']]);
    for (const op of ['=', ':=', '::=', ':::=', '?=', '+=', '!=']) {
      expect(line(`X ${op} y`)[0], op).toEqual([`X ${op}`, 'keyword']);
    }
  });

  it('reads $(…) through nested parens as number, and automatic variables', () => {
    expect(line('X = $(CC) $(shell $(X))')).toEqual([
      ['X =', 'keyword'],
      ['$(CC)', 'number'],
      ['$(shell $(X))', 'number'],
    ]);
    const braced = `\${Z}`;
    expect(tokenOf(`Y = ${braced} x`, braced)).toBe('number');
    expect(tokenOf('Y = $(f (a) b) x', '$(f (a) b)')).toBe('number');
    for (const v of ['$@', '$<', '$^', '$*']) expect(tokenOf(`\tcc ${v} x`, v), v).toBe('number');
  });

  it('reads directives and special targets as keywords', () => {
    expect(tokenOf('.PHONY: x', '.PHONY')).toBe('keyword');
    for (const d of [
      'ifeq',
      'ifneq',
      'ifdef',
      'include',
      '-include',
      'define',
      'export',
      'endif',
    ]) {
      expect(tokenOf(`${d} foo`, d), d).toBe('keyword');
    }
  });

  it("doesn't leak an unterminated $( or ${ past its line", () => {
    for (const open of ['$(', `\${`]) {
      expect(tokenizeLines(makefile, [`X = ${open}foo bar`, 'all: dep'])[1], open).toEqual([
        ['all:', 'type'],
      ]);
    }
    expect(tokenizeLines(makefile, ['X = $(a $(b', 'all: dep'])[1]).toEqual([['all:', 'type']]);
  });

  it('carries $( over a backslash continuation', () => {
    expect(tokenizeLines(makefile, ['X = $(foo \\', '  bar) y'])[1]).toEqual([
      ['  bar)', 'number'],
    ]);
  });

  it('survives nesting deeper than Monaco allows a stack', () => {
    expect(() => tokenizeLines(makefile, ['$('.repeat(200), 'all: x'])).not.toThrow();
  });

  it('reads the variable of an export / override assignment as keyword', () => {
    expect(tokenOf('export CC := gcc', 'CC :=')).toBe('keyword');
    expect(tokenOf('override CFLAGS += -O2', 'CFLAGS +=')).toBe('keyword');
  });

  it('reads a TAB-led recipe line as strings and $(…) only', () => {
    expect(line('\techo "hi" $(CC) x: y = z')).toEqual([
      ['"hi"', 'string'],
      ['$(CC)', 'number'],
    ]);
  });

  it('declares # comments and folds by indentation', () => {
    expect(makefile.conf.comments?.lineComment).toBe('#');
    expect(makefile.conf.folding?.offSide).toBe(true);
  });
});
