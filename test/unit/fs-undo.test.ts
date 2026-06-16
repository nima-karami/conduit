import { describe, expect, it } from 'vitest';
import {
  affectedDirs,
  applyRedo,
  applyUndo,
  type FsOp,
  type FsUndoState,
  invert,
  pushOp,
  redoActions,
} from '../../webview/fs-undo';

// ---- invert() ----

describe('invert — undo actions for each op kind', () => {
  it('create → remove(path)', () => {
    const op: FsOp = { kind: 'create', path: '/proj/src/foo.ts', isDir: false };
    expect(invert(op)).toEqual([
      { call: 'mutate', req: { op: 'remove', path: '/proj/src/foo.ts' } },
    ]);
  });

  it('create dir → remove(path)', () => {
    const op: FsOp = { kind: 'create', path: '/proj/src/utils', isDir: true };
    expect(invert(op)).toEqual([
      { call: 'mutate', req: { op: 'remove', path: '/proj/src/utils' } },
    ]);
  });

  it('rename → rename(to, from)', () => {
    const op: FsOp = { kind: 'rename', from: '/proj/old.ts', to: '/proj/new.ts' };
    expect(invert(op)).toEqual([
      { call: 'mutate', req: { op: 'rename', from: '/proj/new.ts', to: '/proj/old.ts' } },
    ]);
  });

  it('move → move(to, from)', () => {
    const op: FsOp = { kind: 'move', from: '/proj/src/a.ts', to: '/proj/lib/a.ts' };
    expect(invert(op)).toEqual([{ call: 'move', from: '/proj/lib/a.ts', to: '/proj/src/a.ts' }]);
  });

  it('copy → remove(to)', () => {
    const op: FsOp = { kind: 'copy', from: '/proj/src/a.ts', to: '/proj/lib/a.ts' };
    expect(invert(op)).toEqual([{ call: 'mutate', req: { op: 'remove', path: '/proj/lib/a.ts' } }]);
  });
});

// ---- redoActions() ----

describe('redoActions — re-apply actions for each op kind', () => {
  it('create file → createFile(path)', () => {
    const op: FsOp = { kind: 'create', path: '/proj/src/foo.ts', isDir: false };
    expect(redoActions(op)).toEqual([
      { call: 'mutate', req: { op: 'createFile', path: '/proj/src/foo.ts' } },
    ]);
  });

  it('create dir → createDir(path)', () => {
    const op: FsOp = { kind: 'create', path: '/proj/src/utils', isDir: true };
    expect(redoActions(op)).toEqual([
      { call: 'mutate', req: { op: 'createDir', path: '/proj/src/utils' } },
    ]);
  });

  it('rename → rename(from, to)', () => {
    const op: FsOp = { kind: 'rename', from: '/proj/old.ts', to: '/proj/new.ts' };
    expect(redoActions(op)).toEqual([
      { call: 'mutate', req: { op: 'rename', from: '/proj/old.ts', to: '/proj/new.ts' } },
    ]);
  });

  it('move → move(from, to)', () => {
    const op: FsOp = { kind: 'move', from: '/proj/src/a.ts', to: '/proj/lib/a.ts' };
    expect(redoActions(op)).toEqual([
      { call: 'move', from: '/proj/src/a.ts', to: '/proj/lib/a.ts' },
    ]);
  });

  it('copy → copy(from, to)', () => {
    const op: FsOp = { kind: 'copy', from: '/proj/src/a.ts', to: '/proj/lib/a.ts' };
    expect(redoActions(op)).toEqual([
      { call: 'copy', from: '/proj/src/a.ts', to: '/proj/lib/a.ts' },
    ]);
  });
});

// ---- affectedDirs() ----

describe('affectedDirs — POSIX paths', () => {
  it('create → parent of created path', () => {
    const op: FsOp = { kind: 'create', path: '/proj/src/foo.ts', isDir: false };
    expect(affectedDirs(op)).toEqual(['/proj/src']);
  });

  it('rename → parent of target (to) path', () => {
    const op: FsOp = { kind: 'rename', from: '/proj/src/old.ts', to: '/proj/src/new.ts' };
    expect(affectedDirs(op)).toEqual(['/proj/src']);
  });

  it('move with different parent dirs → both parents', () => {
    const op: FsOp = { kind: 'move', from: '/proj/src/a.ts', to: '/proj/lib/a.ts' };
    expect(affectedDirs(op)).toEqual(['/proj/src', '/proj/lib']);
  });

  it('move within the same dir → only one parent', () => {
    const op: FsOp = { kind: 'move', from: '/proj/src/a.ts', to: '/proj/src/b.ts' };
    expect(affectedDirs(op)).toEqual(['/proj/src']);
  });

  it('copy → parent of destination', () => {
    const op: FsOp = { kind: 'copy', from: '/proj/src/a.ts', to: '/proj/lib/a.ts' };
    expect(affectedDirs(op)).toEqual(['/proj/lib']);
  });
});

describe('affectedDirs — Windows paths (backslash)', () => {
  it('create on Windows path', () => {
    const op: FsOp = {
      kind: 'create',
      path: 'C:\\Users\\dev\\proj\\src\\foo.ts',
      isDir: false,
    };
    expect(affectedDirs(op)).toEqual(['C:\\Users\\dev\\proj\\src']);
  });

  it('move Windows paths different dirs', () => {
    const op: FsOp = {
      kind: 'move',
      from: 'C:\\proj\\src\\a.ts',
      to: 'C:\\proj\\lib\\a.ts',
    };
    expect(affectedDirs(op)).toEqual(['C:\\proj\\src', 'C:\\proj\\lib']);
  });

  it('rename Windows path', () => {
    const op: FsOp = {
      kind: 'rename',
      from: 'C:\\proj\\src\\old.ts',
      to: 'C:\\proj\\src\\new.ts',
    };
    expect(affectedDirs(op)).toEqual(['C:\\proj\\src']);
  });
});

// ---- pushOp() ----

describe('pushOp — stack behaviour', () => {
  const empty: FsUndoState = { undo: [], redo: [] };

  it('push adds to undo stack', () => {
    const op: FsOp = { kind: 'create', path: '/a.ts', isDir: false };
    const s = pushOp(empty, op);
    expect(s.undo).toHaveLength(1);
    expect(s.undo[0]).toBe(op);
  });

  it('push clears the redo stack', () => {
    const op1: FsOp = { kind: 'create', path: '/a.ts', isDir: false };
    const op2: FsOp = { kind: 'create', path: '/b.ts', isDir: false };
    const withRedo: FsUndoState = { undo: [op1], redo: [op2] };
    const s = pushOp(withRedo, op1);
    expect(s.redo).toHaveLength(0);
  });

  it('caps undo stack at 50 entries (oldest evicted)', () => {
    let s = empty;
    for (let i = 0; i < 55; i++) {
      const op: FsOp = { kind: 'create', path: `/f${i}.ts`, isDir: false };
      s = pushOp(s, op);
    }
    expect(s.undo).toHaveLength(50);
    // The first 5 (f0-f4) were evicted; f5 should be the oldest remaining.
    expect((s.undo[0] as Extract<FsOp, { kind: 'create' }>).path).toBe('/f5.ts');
  });
});

// ---- applyUndo() / applyRedo() ----

describe('applyUndo — moves top entry from undo to redo', () => {
  it('moves the top op from undo to redo', () => {
    const op1: FsOp = { kind: 'create', path: '/a.ts', isDir: false };
    const op2: FsOp = { kind: 'create', path: '/b.ts', isDir: false };
    const s: FsUndoState = { undo: [op1, op2], redo: [] };
    const { state, op } = applyUndo(s);
    expect(op).toBe(op2);
    expect(state.undo).toEqual([op1]);
    expect(state.redo).toEqual([op2]);
  });

  it('returns undefined op when undo stack is empty', () => {
    const { state, op } = applyUndo({ undo: [], redo: [] });
    expect(op).toBeUndefined();
    expect(state.undo).toHaveLength(0);
  });

  it('prepends to existing redo stack', () => {
    const op1: FsOp = { kind: 'create', path: '/a.ts', isDir: false };
    const op2: FsOp = { kind: 'create', path: '/b.ts', isDir: false };
    const op3: FsOp = { kind: 'create', path: '/c.ts', isDir: false };
    const s: FsUndoState = { undo: [op1, op2], redo: [op3] };
    const { state } = applyUndo(s);
    expect(state.redo).toEqual([op2, op3]);
  });
});

describe('applyRedo — moves top entry from redo to undo', () => {
  it('moves the first redo entry back to undo', () => {
    const op1: FsOp = { kind: 'create', path: '/a.ts', isDir: false };
    const op2: FsOp = { kind: 'create', path: '/b.ts', isDir: false };
    const s: FsUndoState = { undo: [op1], redo: [op2] };
    const { state, op } = applyRedo(s);
    expect(op).toBe(op2);
    expect(state.undo).toEqual([op1, op2]);
    expect(state.redo).toHaveLength(0);
  });

  it('returns undefined op when redo stack is empty', () => {
    const { state, op } = applyRedo({ undo: [], redo: [] });
    expect(op).toBeUndefined();
    expect(state.redo).toHaveLength(0);
  });
});

describe('undo/redo round-trip', () => {
  it('push → undo → redo restores original state', () => {
    const op: FsOp = { kind: 'rename', from: '/a.ts', to: '/b.ts' };
    let s = pushOp({ undo: [], redo: [] }, op);
    expect(s.undo).toHaveLength(1);

    const undoResult = applyUndo(s);
    s = undoResult.state;
    expect(s.undo).toHaveLength(0);
    expect(s.redo).toHaveLength(1);

    const redoResult = applyRedo(s);
    s = redoResult.state;
    expect(s.undo).toHaveLength(1);
    expect(s.redo).toHaveLength(0);
  });
});
