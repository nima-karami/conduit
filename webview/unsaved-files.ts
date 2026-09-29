import { pathBelow } from '../src/canonical-path';
import type { DirtyFile, DirtyTag } from '../src/quit-guard';
import type { SaveKind } from './auto-save-policy';
import { filePathsClosedWithSession, type OpenDoc } from './docs';
import type { FileSaveStatus } from './file-save-controller';

export interface SaveProbe {
  getStatus(path: string): FileSaveStatus | undefined;
  isPartial(path: string): boolean;
  save(path: string, kind: SaveKind): Promise<boolean>;
}

export interface SaveOutcome {
  saved: string[];
  unsaved: DirtyFile[];
}

type StatusProbe = Pick<SaveProbe, 'getStatus' | 'isPartial'>;

function tagOf(path: string, probe: StatusProbe): { tag: DirtyTag; error?: string } {
  if (probe.isPartial(path)) return { tag: 'partial' };
  const status = probe.getStatus(path);
  if (!status) return { tag: 'noEntry' };
  if (status.phase === 'conflict') return { tag: 'conflict' };
  if (status.phase === 'failed') {
    return status.error === null ? { tag: 'failed' } : { tag: 'failed', error: status.error };
  }
  return { tag: status.edited ? null : 'notEdited' };
}

function dirOf(parent: string, root: string | undefined): string {
  const below = root === undefined ? null : pathBelow(parent, root);
  if (below === null) return parent;
  return below
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/');
}

export function unsavedFiles(
  paths: readonly string[],
  probe: StatusProbe,
  rootOf: (path: string) => string | undefined,
  sessionOf?: (path: string) => string | undefined,
): DirtyFile[] {
  return paths.map((path) => {
    const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const session = sessionOf?.(path);
    return {
      path,
      name: path.slice(sep + 1),
      dir: dirOf(path.slice(0, Math.max(sep, 0)), rootOf(path)),
      ...tagOf(path, probe),
      ...(session === undefined ? {} : { session }),
    };
  });
}

export async function saveUnsaved(
  files: readonly DirtyFile[],
  probe: SaveProbe,
): Promise<SaveOutcome> {
  const saved: string[] = [];
  const unsaved: DirtyFile[] = [];
  for (const file of files) {
    if (file.tag === 'partial' || file.tag === 'noEntry') {
      unsaved.push(file);
      continue;
    }
    // see dirty-quit-guard plan D3: force only a row the user saw tagged conflict
    const ok = await probe.save(file.path, file.tag === 'conflict' ? 'force' : 'manual');
    if (ok && probe.getStatus(file.path)?.phase === 'clean') {
      saved.push(file.path);
    } else {
      const { error: _stale, ...rest } = file;
      unsaved.push({ ...rest, ...tagOf(file.path, probe) });
    }
  }
  return { saved, unsaved };
}

export function sessionDirtyPaths(
  docs: readonly OpenDoc[],
  sessionIds: readonly string[],
  dirty: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const id of sessionIds) {
    for (const path of filePathsClosedWithSession(docs, id)) {
      if (dirty.has(path)) out.add(path);
    }
  }
  return [...out];
}
