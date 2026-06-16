/**
 * Pure, browser-safe undo/redo stack for file-explorer operations.
 *
 * No node:* imports — safe in the renderer bundle.
 *
 * Recorded ops:
 *   create  — a file or directory was created
 *   rename  — a file or directory was renamed/moved within a dir
 *   move    — a drag-and-drop move (cross-dir)
 *   copy    — a drag-and-drop copy
 *
 * Deletions are intentionally OUT OF SCOPE for v1 (not undoable here).
 */

/** Discriminated union of recordable file operations. */
export type FsOp =
  | { kind: 'create'; path: string; isDir: boolean }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'copy'; from: string; to: string };

/**
 * An action the executor must run to perform an undo or redo step.
 * Kept as a pure data shape so the mapping to bridge fns lives in app.tsx,
 * not here, keeping this module free of bridge imports.
 */
export type InverseAction =
  | { call: 'mutate'; req: { op: 'createFile' | 'createDir' | 'remove'; path: string } }
  | { call: 'mutate'; req: { op: 'rename'; from: string; to: string } }
  | { call: 'move'; from: string; to: string }
  | { call: 'copy'; from: string; to: string };

/** Pure undo/redo stack state — no side effects. */
export interface FsUndoState {
  undo: FsOp[];
  redo: FsOp[];
}

const MAX_UNDO = 50;

// ---- Path helpers (no node:path, cross-platform) ----

/** Parent directory of a path (handles both / and \ separators). */
function parentDir(p: string): string {
  // Strip trailing separators first, then remove the last segment.
  const stripped = p.replace(/[\\/]+$/, '');
  const lastSep = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  if (lastSep <= 0) return stripped; // root or bare name → return as-is
  return stripped.slice(0, lastSep);
}

// ---- Inverse actions ----

/**
 * Returns the bridge calls needed to UNDO `op`.
 *
 * create  → remove (trash) the created path
 * rename  → rename back (to → from)
 * move    → move back (to → from)
 * copy    → remove (trash) the copy at `to`
 */
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

/**
 * Returns the bridge calls needed to RE-APPLY (redo) `op`.
 *
 * create  → createFile or createDir at the same path
 * rename  → rename(from, to)
 * move    → move(from, to)
 * copy    → copy(from, to)
 */
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
 * Returns the set of directory paths that must be refreshed after applying
 * or undoing `op`.
 *
 * create / rename / copy → parent dir of the target path
 * move                   → parent dirs of BOTH source and destination
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

// ---- Pure stack reducers ----

/**
 * Push a new op onto the undo stack and clear the redo stack.
 * Caps the undo stack at MAX_UNDO entries (oldest evicted first).
 */
export function pushOp(state: FsUndoState, op: FsOp): FsUndoState {
  const next = [...state.undo, op];
  if (next.length > MAX_UNDO) next.splice(0, next.length - MAX_UNDO);
  return { undo: next, redo: [] };
}

/**
 * Pop the top entry from the undo stack and push it onto the redo stack.
 * Returns undefined for the op if the undo stack is empty.
 */
export function applyUndo(state: FsUndoState): { state: FsUndoState; op: FsOp | undefined } {
  if (state.undo.length === 0) return { state, op: undefined };
  const undo = state.undo.slice();
  // length > 0 is guaranteed by the guard above, so pop() is always defined.
  const op: FsOp = undo.pop() as FsOp;
  return { state: { undo, redo: [op, ...state.redo] }, op };
}

/**
 * Pop the top entry from the redo stack and push it onto the undo stack.
 * Returns undefined for the op if the redo stack is empty.
 */
export function applyRedo(state: FsUndoState): { state: FsUndoState; op: FsOp | undefined } {
  if (state.redo.length === 0) return { state, op: undefined };
  const redo = state.redo.slice();
  // length > 0 is guaranteed by the guard above, so shift() is always defined.
  const op: FsOp = redo.shift() as FsOp;
  return { state: { undo: [...state.undo, op], redo }, op };
}
