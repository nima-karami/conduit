import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('monaco-editor', () => ({
  Uri: { parse: (s: string) => ({ toString: () => s, path: s }) },
  editor: { getModel: () => null },
  languages: {},
  typescript: {},
}));

import {
  liveCursor,
  NAV_REVEAL_SOURCE,
  type NavEditor,
  registerNavEditor,
  requestNavFocus,
  revealInEditor,
  revealInNavEditor,
} from '../../webview/nav-editors';

interface Fake {
  editor: NavEditor;
  calls: string[];
  setPositionArgs: unknown[][];
}

function fakeEditor(lineCount = 50, at = { lineNumber: 1, column: 1 }): Fake {
  const calls: string[] = [];
  const setPositionArgs: unknown[][] = [];
  let pos = at;
  const model = { getLineCount: () => lineCount, getLineMaxColumn: () => 30 };
  const editor = {
    getPosition: () => pos,
    setPosition: (p: { lineNumber: number; column: number }, source?: string) => {
      calls.push('setPosition');
      setPositionArgs.push([p, source]);
      pos = p;
    },
    revealLineInCenter: (line: number) => calls.push(`reveal:${line}`),
    focus: () => calls.push('focus'),
    getModel: () => model,
  } as unknown as NavEditor;
  return { editor, calls, setPositionArgs };
}

let teardowns: (() => void)[] = [];
beforeEach(() => {
  for (const t of teardowns) t();
  teardowns = [];
});
const reg = (path: string, ed: NavEditor) => {
  const t = registerNavEditor(path, ed);
  teardowns.push(t);
  return t;
};

describe('nav-editors registry', () => {
  it('revealInEditor tags setPosition with NAV_REVEAL_SOURCE', () => {
    const f = fakeEditor();
    revealInEditor(f.editor, { line: 12, column: 3 });
    expect(f.setPositionArgs[0]).toEqual([{ lineNumber: 12, column: 3 }, NAV_REVEAL_SOURCE]);
    expect(f.calls).toEqual(['setPosition', 'reveal:12']);
  });

  it('revealInEditor clamps to the model', () => {
    const f = fakeEditor(50);
    revealInEditor(f.editor, { line: 999, column: 999 });
    expect(f.setPositionArgs[0][0]).toEqual({ lineNumber: 50, column: 30 });
    expect(f.calls).toContain('reveal:50');
  });

  it('liveCursor reads the registered editor', () => {
    reg('C:/w/a.ts', fakeEditor(50, { lineNumber: 7, column: 2 }).editor);
    expect(liveCursor('C:\\w\\a.ts')).toEqual({ line: 7, column: 2 });
    expect(liveCursor('C:/w/none.ts')).toBeUndefined();
  });

  it('stale teardown does not unregister a newer editor', () => {
    const old = reg('/w/a.ts', fakeEditor(50, { lineNumber: 1, column: 1 }).editor);
    reg('/w/a.ts', fakeEditor(50, { lineNumber: 9, column: 1 }).editor);
    old();
    expect(liveCursor('/w/a.ts')).toEqual({ line: 9, column: 1 });
  });

  it('requestNavFocus before register focuses on register', () => {
    requestNavFocus('/w/later.ts');
    const f = fakeEditor();
    reg('/w/later.ts', f.editor);
    expect(f.calls).toEqual(['focus']);
    const again = fakeEditor();
    reg('/w/later.ts', again.editor);
    expect(again.calls).toEqual([]);
  });

  it('requestNavFocus focuses a registered editor now', () => {
    const f = fakeEditor();
    reg('/w/now.ts', f.editor);
    requestNavFocus('/w/now.ts');
    expect(f.calls).toEqual(['focus']);
  });

  it('revealInNavEditor returns false when nothing is registered', () => {
    expect(revealInNavEditor('/w/nothing.ts', { line: 3, column: 1 })).toBe(false);
    const f = fakeEditor();
    reg('/w/some.ts', f.editor);
    expect(revealInNavEditor('/w/some.ts', { line: 3, column: 1 })).toBe(true);
    expect(f.calls).toEqual(['setPosition', 'reveal:3', 'focus']);
  });
});
