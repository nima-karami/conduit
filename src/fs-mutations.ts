import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInsideAnyRoot, realPathLeaf } from './path-guard';

/**
 * File-tree mutation layer (L2). The Explorer can ask the host to create / rename /
 * delete files and folders, so — exactly like the write-file IPC — this is a trust
 * boundary: the renderer is untrusted and EVERY path is validated for containment in
 * the open workspace `roots` (the same roots notion `writeFile` uses) before any disk
 * mutation runs.
 *
 * Two halves, both small and testable (mirroring `git-actions.ts`):
 *  - PURE validation (`planMutation`): turns a request into a typed plan or a typed
 *    rejection. No IO — unit-tested without Electron. Containment is enforced here via
 *    `isInsideAnyRoot` + `realPathLeaf` from path-guard (case-insensitive on win32,
 *    symlink-resolved), so a `..`/absolute/symlink escape can never reach `fs`.
 *  - Thin executors (`createFile`, `createDir`, `rename`, `remove`, `removePermanent`):
 *    run a validated plan against the real filesystem. `remove` takes an INJECTED
 *    `trash` function (Electron `shell.trashItem` in the app) so this module has no hard
 *    Electron dependency and the recycle-bin path stays testable.
 */

export type MutationResult = { ok: true; path: string } | { ok: false; error: string };

export type FsMutationRequest =
  | { op: 'createFile' | 'createDir' | 'remove' | 'removePermanent'; path: string }
  | { op: 'rename'; from: string; to: string };

/** A validated plan an executor can run without further checks. */
export type MutationPlan =
  | { kind: 'createFile'; path: string }
  | { kind: 'createDir'; path: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'remove'; path: string }
  | { kind: 'removePermanent'; path: string }
  | { kind: 'reject'; error: string };

/** Resolve + strip a trailing separator, for exact root-equality comparison. */
function resolvedNoSep(p: string): string {
  const r = path.resolve(p);
  return r.endsWith(path.sep) ? r.slice(0, -1) : r;
}

/** Case-fold on win32 (the filesystem is), exact elsewhere — matches path-guard. */
function eqPath(a: string, b: string): boolean {
  const x = resolvedNoSep(a);
  const y = resolvedNoSep(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** True when `target` resolves to one of the workspace roots itself (never mutate a root). */
function isWorkspaceRoot(target: string, roots: readonly string[]): boolean {
  return roots.some((r) => eqPath(target, r));
}

/**
 * Containment check for a mutation target. A path is allowed when its lexically
 * resolved form AND its symlink-resolved real path both stay inside some root — the
 * same two-stage defence the write-file guard uses. (We don't reject directories here
 * the way `validateWrite` does, because create-dir / rename / remove legitimately act
 * on directories; the per-op rules below handle existence/collision/root cases.)
 */
function contained(target: string, roots: readonly string[]): boolean {
  const abs = path.resolve(target);
  if (!isInsideAnyRoot(abs, roots)) return false;
  return isInsideAnyRoot(realPathLeaf(abs), roots);
}

/**
 * Validate a mutation request against the workspace `roots` and produce a runnable
 * plan, or a typed rejection. PURE — no filesystem reads except the collision check
 * for create/rename (existence is a fact about disk, so it must be observed; it is the
 * only IO here and is read-only).
 *
 * Rejection cases (all reported, never silently swallowed):
 *  - empty / missing path(s),
 *  - no open workspace roots,
 *  - target escapes every root (lexical or symlink),
 *  - mutating a workspace root itself (rename/remove of a root),
 *  - createFile onto an existing path (no clobber),
 *  - rename onto an existing target (collision),
 *  - rename where the source does not exist.
 */
export function planMutation(req: FsMutationRequest, roots: readonly string[]): MutationPlan {
  if (roots.length === 0) return { kind: 'reject', error: 'No open workspace to act in.' };

  if (req.op === 'rename') {
    const { from, to } = req;
    if (!from || !to) return { kind: 'reject', error: 'Both source and target are required.' };
    if (!contained(from, roots)) {
      return { kind: 'reject', error: `Refusing to act outside the workspace: ${from}` };
    }
    if (!contained(to, roots)) {
      return { kind: 'reject', error: `Refusing to act outside the workspace: ${to}` };
    }
    if (isWorkspaceRoot(from, roots)) {
      return { kind: 'reject', error: 'Refusing to rename a workspace root.' };
    }
    if (!fs.existsSync(path.resolve(from))) {
      return { kind: 'reject', error: 'Source no longer exists.' };
    }
    // Collision: reject unless `to` is just a case-rename of `from` on a
    // case-insensitive filesystem (renaming `Foo`→`foo` is legitimate there).
    if (fs.existsSync(path.resolve(to)) && !eqPath(from, to)) {
      return { kind: 'reject', error: 'A file or folder with that name already exists.' };
    }
    return { kind: 'rename', from: path.resolve(from), to: path.resolve(to) };
  }

  const { op, path: target } = req;
  if (!target) return { kind: 'reject', error: 'No path provided.' };
  if (!contained(target, roots)) {
    return { kind: 'reject', error: `Refusing to act outside the workspace: ${target}` };
  }
  const abs = path.resolve(target);

  switch (op) {
    case 'createFile':
      if (fs.existsSync(abs)) {
        return { kind: 'reject', error: 'A file or folder with that name already exists.' };
      }
      return { kind: 'createFile', path: abs };
    case 'createDir':
      return { kind: 'createDir', path: abs };
    case 'remove':
      if (isWorkspaceRoot(target, roots)) {
        return { kind: 'reject', error: 'Refusing to delete a workspace root.' };
      }
      return { kind: 'remove', path: abs };
    case 'removePermanent':
      if (isWorkspaceRoot(target, roots)) {
        return { kind: 'reject', error: 'Refusing to delete a workspace root.' };
      }
      return { kind: 'removePermanent', path: abs };
    default:
      return { kind: 'reject', error: `Unknown op: ${String(op)}` };
  }
}

/** Create an empty file (never clobbering — guarded by planMutation). */
export async function createFile(
  target: string,
  roots: readonly string[],
): Promise<MutationResult> {
  const plan = planMutation({ op: 'createFile', path: target }, roots);
  if (plan.kind !== 'createFile') return planError(plan, 'create file');
  try {
    await fs.promises.mkdir(path.dirname(plan.path), { recursive: true });
    // `wx` fails if the file already exists, closing the TOCTOU window between the
    // planMutation existence check and the write.
    const fh = await fs.promises.open(plan.path, 'wx');
    await fh.close();
    return { ok: true, path: plan.path };
  } catch (e: unknown) {
    return fail(e);
  }
}

/** Create a directory (recursive — idempotent). */
export async function createDir(target: string, roots: readonly string[]): Promise<MutationResult> {
  const plan = planMutation({ op: 'createDir', path: target }, roots);
  if (plan.kind !== 'createDir') return planError(plan, 'create folder');
  try {
    await fs.promises.mkdir(plan.path, { recursive: true });
    return { ok: true, path: plan.path };
  } catch (e: unknown) {
    return fail(e);
  }
}

/** Rename / move a file or folder; both ends validated by planMutation. */
export async function rename(
  from: string,
  to: string,
  roots: readonly string[],
): Promise<MutationResult> {
  const plan = planMutation({ op: 'rename', from, to }, roots);
  if (plan.kind !== 'rename') return planError(plan, 'rename');
  try {
    await fs.promises.mkdir(path.dirname(plan.to), { recursive: true });
    // Case-only rename on a case-insensitive FS (`Foo`→`foo`): a direct rename can no-op,
    // so route through a temp name to force the case change actually lands.
    if (plan.from !== plan.to && plan.from.toLowerCase() === plan.to.toLowerCase()) {
      const tmp = `${plan.to}.conduit-case-${process.pid}-${Date.now()}`;
      await fs.promises.rename(plan.from, tmp);
      await fs.promises.rename(tmp, plan.to);
    } else {
      await fs.promises.rename(plan.from, plan.to);
    }
    return { ok: true, path: plan.to };
  } catch (e: unknown) {
    return fail(e);
  }
}

/**
 * Move a file or folder to the OS recycle bin via the injected `trash` function
 * (Electron `shell.trashItem`). If `trash` rejects, the error is returned — this layer
 * NEVER falls back to a permanent delete. The renderer surfaces the failure and may
 * offer an explicit, separately-confirmed `removePermanent`.
 */
export async function remove(
  target: string,
  roots: readonly string[],
  trash: (p: string) => Promise<void>,
): Promise<MutationResult> {
  const plan = planMutation({ op: 'remove', path: target }, roots);
  if (plan.kind !== 'remove') return planError(plan, 'delete');
  try {
    await trash(plan.path);
    return { ok: true, path: plan.path };
  } catch (e: unknown) {
    return fail(e);
  }
}

/**
 * Permanently delete a file or folder (recursive). Separate from `remove` and only
 * ever reached after the renderer's explicit second confirm; still fully
 * containment-checked + root-protected by planMutation.
 */
export async function removePermanent(
  target: string,
  roots: readonly string[],
): Promise<MutationResult> {
  const plan = planMutation({ op: 'removePermanent', path: target }, roots);
  if (plan.kind !== 'removePermanent') return planError(plan, 'delete');
  try {
    await fs.promises.rm(plan.path, { recursive: true, force: true });
    return { ok: true, path: plan.path };
  } catch (e: unknown) {
    return fail(e);
  }
}

/** Turn a non-matching plan into a typed failure (rejection reason or a guard mismatch). */
function planError(plan: MutationPlan, action: string): MutationResult {
  if (plan.kind === 'reject') return { ok: false, error: plan.error };
  return { ok: false, error: `Could not ${action}.` };
}

function fail(e: unknown): MutationResult {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}
