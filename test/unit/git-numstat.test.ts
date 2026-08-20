import { describe, expect, it } from 'vitest';
import { parseNumstatZ } from '../../src/git-history';

const NUL = '\0';

describe('parseNumstatZ', () => {
  it('parses plain records', () => {
    const out = `12\t3\tsrc/a.ts${NUL}0\t7\tsrc/b.ts${NUL}`;
    const m = parseNumstatZ(out);
    expect(m.get('src/a.ts')).toEqual({ added: 12, removed: 3 });
    expect(m.get('src/b.ts')).toEqual({ added: 0, removed: 7 });
  });

  it('skips binary records (dash counts)', () => {
    const m = parseNumstatZ(`-\t-\tassets/logo.png${NUL}`);
    expect(m.has('assets/logo.png')).toBe(false);
  });

  it('keys a -z rename record by its NEW path', () => {
    // with -M and -z, a rename emits: added TAB removed TAB NUL old NUL new NUL
    const m = parseNumstatZ(`5\t2\t${NUL}old/name.ts${NUL}new/name.ts${NUL}`);
    expect(m.get('new/name.ts')).toEqual({ added: 5, removed: 2 });
    expect(m.has('old/name.ts')).toBe(false);
  });

  it('parses a mixed stream (binary, rename, plain) in one pass', () => {
    const out = `-\t-\tlogo.png${NUL}2\t1\t${NUL}old/name.ts${NUL}new/name.ts${NUL}1\t0\tp.txt${NUL}`;
    const m = parseNumstatZ(out);
    expect(m.has('logo.png')).toBe(false);
    expect(m.get('new/name.ts')).toEqual({ added: 2, removed: 1 });
    expect(m.get('p.txt')).toEqual({ added: 1, removed: 0 });
    expect(m.size).toBe(2);
  });

  it('tolerates empty/garbage input', () => {
    expect(parseNumstatZ('').size).toBe(0);
    expect(parseNumstatZ('not-a-record').size).toBe(0);
  });
});
