import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('monaco-editor', () => ({
  Uri: { parse: (s: string) => ({ toString: () => s, path: s }) },
  editor: { getModel: () => null },
  languages: {},
  typescript: {},
}));

import {
  cancelNavFocus,
  emitCursorJump,
  groupOfEditor,
  LAST_CURSOR_CAP,
  lastCursor,
  liveCursor,
  NAV_REVEAL_SOURCE,
  type NavEditor,
  registerNavEditor,
  requestNavFocus,
  revealInEditor,
  revealInNavEditor,
  setCursorJumpSink,
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
const reg = (path: string, ed: NavEditor, group: 1 | 2 = 1) => {
  const t = registerNavEditor(path, ed, group);
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

  it('lastCursor remembers where an unmounted editor left its cursor', () => {
    const t = reg('/w/left.ts', fakeEditor(50, { lineNumber: 23, column: 4 }).editor);
    expect(lastCursor('/w/left.ts')).toEqual({ line: 23, column: 4 });
    t();
    expect(liveCursor('/w/left.ts')).toBeUndefined();
    expect(lastCursor('/w/left.ts')).toEqual({ line: 23, column: 4 });
    expect(lastCursor('/w/never.ts')).toBeUndefined();
  });

  it('lastCursor keeps only the most recently left editors', () => {
    for (let i = 0; i < LAST_CURSOR_CAP + 5; i++) {
      reg(`/w/many${i}.ts`, fakeEditor(50, { lineNumber: 2, column: 1 }).editor)();
    }
    expect(lastCursor('/w/many0.ts')).toBeUndefined();
    expect(lastCursor('/w/many4.ts')).toBeUndefined();
    expect(lastCursor('/w/many5.ts')).toEqual({ line: 2, column: 1 });
    expect(lastCursor(`/w/many${LAST_CURSOR_CAP + 4}.ts`)).toEqual({ line: 2, column: 1 });
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

  it('a focus request for a path that never mounts an editor is dropped by the next register', () => {
    requestNavFocus('/w/image.png');
    reg('/w/other.ts', fakeEditor().editor);
    const later = fakeEditor();
    reg('/w/image.png', later.editor);
    expect(later.calls).toEqual([]);
  });

  it('a newer focus request replaces a pending one', () => {
    requestNavFocus('/w/first.ts');
    requestNavFocus('/w/second.ts');
    const first = fakeEditor();
    reg('/w/first.ts', first.editor);
    expect(first.calls).toEqual([]);
  });

  it('cancelNavFocus drops a pending request', () => {
    requestNavFocus('/w/cancelled.ts');
    cancelNavFocus();
    const f = fakeEditor();
    reg('/w/cancelled.ts', f.editor);
    expect(f.calls).toEqual([]);
  });

  it('requestNavFocus focuses a registered editor now', () => {
    const f = fakeEditor();
    reg('/w/now.ts', f.editor);
    requestNavFocus('/w/now.ts');
    expect(f.calls).toEqual(['focus']);
  });

  it('emitCursorJump reaches the registered sink and is a no-op with none', () => {
    const seen: unknown[] = [];
    emitCursorJump('/w/a.ts', { line: 1, column: 1 }, { line: 40, column: 2 });
    setCursorJumpSink((path, from, to) => seen.push([path, from, to]));
    emitCursorJump('/w/a.ts', { line: 1, column: 1 }, { line: 40, column: 2 });
    setCursorJumpSink(null);
    emitCursorJump('/w/a.ts', { line: 2, column: 1 }, { line: 90, column: 1 });
    expect(seen).toEqual([['/w/a.ts', { line: 1, column: 1 }, { line: 40, column: 2 }]]);
  });

  it('revealInNavEditor returns false when nothing is registered', () => {
    expect(revealInNavEditor('/w/nothing.ts', { line: 3, column: 1 })).toBe(false);
    const f = fakeEditor();
    reg('/w/some.ts', f.editor);
    expect(revealInNavEditor('/w/some.ts', { line: 3, column: 1 })).toBe(true);
    expect(f.calls).toEqual(['setPosition', 'reveal:3', 'focus']);
  });
});

describe('nav-editors — two viewers on one path (split-editor D1)', () => {
  it('second viewer on the same path: unmounting the newer one leaves the survivor registered', () => {
    reg('/w/d1.ts', fakeEditor(50, { lineNumber: 4, column: 1 }).editor);
    const offB = reg('/w/d1.ts', fakeEditor(50, { lineNumber: 8, column: 1 }).editor);
    offB();
    expect(liveCursor('/w/d1.ts')).toEqual({ line: 4, column: 1 });
  });

  it('groupOfEditor returns the registering group', () => {
    const left = fakeEditor().editor;
    const right = fakeEditor().editor;
    reg('/w/g.ts', left, 1);
    const offRight = reg('/w/g.ts', right, 2);
    expect(groupOfEditor(left)).toBe(1);
    expect(groupOfEditor(right)).toBe(2);
    expect(groupOfEditor(fakeEditor().editor)).toBeUndefined();
    offRight();
    expect(groupOfEditor(right)).toBeUndefined();
  });

  it("requestNavFocus with a group focuses only that group's editor", () => {
    const left = fakeEditor();
    const right = fakeEditor();
    reg('/w/pair.ts', left.editor, 1);
    reg('/w/pair.ts', right.editor, 2);
    requestNavFocus('/w/pair.ts', 1);
    expect(left.calls).toEqual(['focus']);
    expect(right.calls).toEqual([]);

    requestNavFocus('/w/pending.ts', 2);
    const wrong = fakeEditor();
    reg('/w/pending.ts', wrong.editor, 1);
    expect(wrong.calls).toEqual([]);
  });

  it('liveCursor and revealInNavEditor prefer the requested group', () => {
    const left = fakeEditor(50, { lineNumber: 3, column: 1 });
    const right = fakeEditor(50, { lineNumber: 30, column: 1 });
    reg('/w/two.ts', left.editor, 1);
    reg('/w/two.ts', right.editor, 2);
    expect(liveCursor('/w/two.ts', 1)).toEqual({ line: 3, column: 1 });
    expect(liveCursor('/w/two.ts', 2)).toEqual({ line: 30, column: 1 });
    expect(revealInNavEditor('/w/two.ts', { line: 5, column: 1 }, 1)).toBe(true);
    expect(left.calls).toEqual(['setPosition', 'reveal:5', 'focus']);
    expect(right.calls).toEqual([]);
  });
});
