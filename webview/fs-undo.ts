/**
 * Pure, browser-safe undo/redo stack for file-explorer operations. No node:* imports.
 * Deletions are intentionally OUT OF SCOPE for v1 (not undoable here).
 */

export type FsOp =
  | { kind: 'create'; path: string; isDir: boolean }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'copy'; from: string; to: string };

/**
 * An undo/redo step as pure data, so the mapping to bridge fns lives in app.tsx and this
 * module stays free of bridge imports.
 */
export type InverseAction =
  | { call: 'mutate'; req: { op: 'createFile' | 'createDir' | 'remove'; path: string } }
  | { call: 'mutate'; req: { op: 'rename'; from: string; to: string } }
  | { call: 'move'; from: string; to: string }
  | { call: 'copy'; from: string; to: string };

export interface FsUndoState {
  undo: FsOp[];
  redo: FsOp[];
}

const MAX_UNDO = 50;

/** Parent directory of a path (handles both / and \ separators). */
function parentDir(p: string): string {
  const stripped = p.replace(/[\\/]+$/, '');
  const lastSep = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  if (lastSep <= 0) return stripped; // root or bare name → return as-is
  return stripped.slice(0, lastSep);
}

/** Returns the bridge calls needed to UNDO `op`. */
export function invert(op: FsOp): InverseAction[] {
  switch (op.kind) {
    case 'create':
      return [{ call: 'mutate', req: { op: 'remove', path: op.path } }];
    case 'rename':
      return [{ call: 'mutate', req: { op: 'rename', from: op.to, to: op.from } }];
    case 'move':
      return [{ call: 'move', from: op.to, to: op.from }];
    case 'copy':
      return [{ call: 'mutate', req: { op: 'remove', path: op.to } }];
  }
}

/** Returns the bridge calls needed to RE-APPLY (redo) `op`. */
export function redoActions(op: FsOp): InverseAction[] {
  switch (op.kind) {
    case 'create':
      return [
        {
          call: 'mutate',
          req: { op: op.isDir ? 'createDir' : 'createFile', path: op.path },
        },
      ];
    case 'rename':
      return [{ call: 'mutate', req: { op: 'rename', from: op.from, to: op.to } }];
    case 'move':
      return [{ call: 'move', from: op.from, to: op.to }];
    case 'copy':
      return [{ call: 'copy', from: op.from, to: op.to }];
  }
}

/**
 * Directory paths that must be refreshed after applying or undoing `op` (a move touches
 * BOTH source and destination parents).
 */
export function affectedDirs(op: FsOp): string[] {
  switch (op.kind) {
    case 'create':
      return [parentDir(op.path)];
    case 'rename':
      return [parentDir(op.to)];
    case 'move': {
      const fromDir = parentDir(op.from);
      const toDir = parentDir(op.to);
      return fromDir === toDir ? [fromDir] : [fromDir, toDir];
    }
    case 'copy':
      return [parentDir(op.to)];
  }
}

/** Push a new op onto the undo stack and clear redo, capped at MAX_UNDO (oldest evicted). */
export function pushOp(state: FsUndoState, op: FsOp): FsUndoState {
  const next = [...state.undo, op];
  if (next.length > MAX_UNDO) next.splice(0, next.length - MAX_UNDO);
  return { undo: next, redo: [] };
}

/** Move the top undo entry to the redo stack (op is undefined when undo is empty). */
export function applyUndo(state: FsUndoState): { state: FsUndoState; op: FsOp | undefined } {
  if (state.undo.length === 0) return { state, op: undefined };
  const undo = state.undo.slice();
  // length > 0 is guaranteed by the guard above, so pop() is always defined.
  const op: FsOp = undo.pop() as FsOp;
  return { state: { undo, redo: [op, ...state.redo] }, op };
}

/** Move the top redo entry back to the undo stack (op is undefined when redo is empty). */
export function applyRedo(state: FsUndoState): { state: FsUndoState; op: FsOp | undefined } {
  if (state.redo.length === 0) return { state, op: undefined };
  const redo = state.redo.slice();
  // length > 0 is guaranteed by the guard above, so shift() is always defined.
  const op: FsOp = redo.shift() as FsOp;
  return { state: { undo: [...state.undo, op], redo }, op };
}
