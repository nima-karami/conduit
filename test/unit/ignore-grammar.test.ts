import { describe, expect, it } from 'vitest';
import { ignore } from '../../webview/ignore-grammar';
import { tokenizeLines } from './grammar-runner';

const line = (text: string) => tokenizeLines(ignore, [text])[0];

describe('ignore grammar', () => {
  it('reads # as a comment at column 0 only', () => {
    expect(line('# c')).toEqual([['# c', 'comment']]);
    expect(line('a#b')).toEqual([]);
  });

  it('reads a leading ! as keyword', () => {
    expect(line('!keep')).toEqual([['!', 'keyword']]);
    expect(line('a!b')).toEqual([]);
  });

  it('reads glob characters and a trailing slash as type', () => {
    expect(line('*.log')).toEqual([['*', 'type']]);
    expect(line('**/x')).toEqual([['**', 'type']]);
    expect(line('a?')).toEqual([['?', 'type']]);
    expect(line('[ab].txt')).toEqual([['[ab]', 'type']]);
    expect(line('build/')).toEqual([['/', 'type']]);
    expect(line('a/b')).toEqual([]);
  });

  it('leaves an escaped glob character plain', () => {
    expect(line('\\#file')).toEqual([]);
    expect(line('a\\*b')).toEqual([]);
  });

  it('declares # comments', () => {
    expect(ignore.conf.comments?.lineComment).toBe('#');
  });
});
