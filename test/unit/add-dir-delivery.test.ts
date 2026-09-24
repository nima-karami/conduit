import { describe, expect, it } from 'vitest';
import { type AddDirDeps, addDirArg, addDirInput, runAddDir } from '../../src/add-dir-delivery';

function fake(over: Partial<AddDirDeps> = {}) {
  const writes: string[] = [];
  const pasted: string[] = [];
  const deps: AddDirDeps = {
    sessionExists: () => true,
    isAlive: () => true,
    isBusy: () => false,
    typeable: () => ['C:\\a b', 'D:\\c'],
    bracketedPaste: () => true,
    write: (d) => {
      writes.push(d);
      return true;
    },
    onPasted: (p) => pasted.push(p),
    ...over,
  };
  return { deps, writes, pasted };
}

describe('runAddDir (AC-8, revised per conductor after real-claude QA)', () => {
  it('busy → busy with zero writes', () => {
    const f = fake({ isBusy: () => true });
    expect(runAddDir(f.deps)).toEqual({ ok: false, reason: 'busy' });
    expect(f.writes).toEqual([]);
  });

  it('pastes ONE folder, the first typeable, as a bracketed paste and never presses Enter', () => {
    const f = fake();
    expect(runAddDir(f.deps)).toEqual({ ok: true, pasted: 'C:\\a b' });
    expect(f.writes).toEqual(['\x1b[200~/add-dir C:\\a b\x1b[201~']);
    expect(f.writes.join('')).not.toMatch(/[\r\n]/);
    expect(f.pasted).toEqual(['C:\\a b']);
  });

  it('paste mode off → the same line as plain text, still no Enter', () => {
    const f = fake({ bracketedPaste: () => false });
    runAddDir(f.deps);
    expect(f.writes).toEqual(['/add-dir C:\\a b']);
  });

  it('the path is typed verbatim: double spaces and & survive', () => {
    const f = fake({ typeable: () => ['C:\\R&D  x'], bracketedPaste: () => false });
    runAddDir(f.deps);
    expect(f.writes[0]).toBe('/add-dir C:\\R&D  x');
  });

  it('a refused write → writeFailed and nothing marked pasted', () => {
    const f = fake({ write: () => false });
    expect(runAddDir(f.deps)).toEqual({ ok: false, reason: 'writeFailed' });
    expect(f.pasted).toEqual([]);
  });

  it('no scope → notClaude; empty → nothingPending; dead → notRunning; gone → noSession', () => {
    expect(runAddDir(fake({ typeable: () => undefined }).deps)).toMatchObject({
      reason: 'notClaude',
    });
    expect(runAddDir(fake({ typeable: () => [] }).deps)).toMatchObject({
      reason: 'nothingPending',
    });
    expect(runAddDir(fake({ isAlive: () => false }).deps)).toMatchObject({ reason: 'notRunning' });
    expect(runAddDir(fake({ sessionExists: () => false }).deps)).toMatchObject({
      reason: 'noSession',
    });
  });
});

describe('addDirArg (review F3: a trailing separator before Enter is a newline to claude)', () => {
  it.each([
    ['D:\\', 'D:/'],
    ['d:/', 'd:/'],
    ['D:\\\\', 'D:/'],
    ['C:\\work\\', 'C:\\work'],
    ['/home/u/x/', '/home/u/x'],
    ['/', '/'],
    ['C:\\a b', 'C:\\a b'],
  ])('%j → %j', (p, typed) => {
    expect(addDirArg(p)).toBe(typed);
    expect(addDirInput(p, false)).toBe(`/add-dir ${typed}`);
  });

  it('never ends the pasted command in a backslash', () => {
    for (const p of ['D:\\', 'C:\\x\\', 'E:\\\\']) {
      expect(addDirInput(p, true).endsWith('\\\x1b[201~')).toBe(false);
    }
  });
});
