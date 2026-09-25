import { folderKey } from '../src/folder-key';
import { countNoun } from '../src/menu-selection';
import { isAncestorOf } from '../src/owning-session';
import type { LocateReason, WebviewToHost } from '../src/protocol';
import { repoBaseName } from '../src/repo-display';
import type { FolderSectionModel } from '../src/session-sections';
import type { requestHost } from './host-request';
import type { PushToastInput } from './toast-store';

// A native picker stays open as long as the user leaves it; the op replies are host-local.
const PICK_TIMEOUT_MS = 30 * 60_000;
const OP_TIMEOUT_MS = 15_000;

const STR = {
  duplicate: (n: string) => `${n} is already in this session.`,
  overlaps: (n: string) => `${n} overlaps a folder already in this session.`,
  addFailed: (n: string) => `Couldn't add ${n}.`,
  dirty: (n: number, name: string) =>
    `Save or close ${countNoun(n, 'unsaved file', 'unsaved files')} in ${name} first.`,
  removed: (n: string) => `Removed ${n} from session`,
  undo: 'Undo',
  removeFailed: (n: string) => `Couldn't remove ${n}.`,
  makeHomeFailed: (n: string) => `Couldn't make ${n} home.`,
  locateFailed: (n: string) => `Couldn't locate ${n}.`,
};

export type FolderActionOutcome =
  | { kind: 'added'; key: string; name: string }
  | { kind: 'located'; key: string; name: string }
  | { kind: 'removed'; key: string; name: string }
  | { kind: 'none' };

export interface FolderActionsDeps {
  sessionId: string;
  request: typeof requestHost;
  post: (m: WebviewToHost) => void;
  toast: (t: PushToastInput) => void;
  /** app: getDirtySnapshot (webview/dirty-store.ts) */
  dirtyPaths: () => ReadonlySet<string>;
}

export interface FolderActions {
  add(): Promise<FolderActionOutcome>;
  remove(section: FolderSectionModel): Promise<FolderActionOutcome>;
  makeHome(section: FolderSectionModel): Promise<void>;
  /** The one renderer Locate helper (locked L11); mf-live-edits' centre pane calls it too. */
  locate(section: FolderSectionModel): Promise<FolderActionOutcome>;
  /** No toast: the drop menu composes one for the whole batch. */
  attach(paths: readonly string[]): Promise<{ attached: string[]; failed: string[] }>;
}

/** Folder edits from the Files tab (mf-files spec §2.4–§2.7). The host is the source of truth:
 *  nothing here is optimistic, the next `state` moves the sections. */
export function createFolderActions(deps: FolderActionsDeps): FolderActions {
  const { sessionId, request } = deps;
  const error = (message: string) => deps.toast({ message, variant: 'error' });

  const addRoot = async (sid: string, path: string) =>
    request(
      (requestId) => ({ type: 'session:addRoot', sessionId: sid, path, requestId }),
      ['session:opResult'],
      OP_TIMEOUT_MS,
    );

  const addFailureCopy = (reason: LocateReason | undefined, name: string) =>
    reason === 'duplicate'
      ? STR.duplicate(name)
      : reason === 'overlaps'
        ? STR.overlaps(name)
        : STR.addFailed(name);

  return {
    async add() {
      const picked = await request(
        (requestId) => ({ type: 'folder:pick', requestId }),
        ['folder:picked'],
        PICK_TIMEOUT_MS,
      );
      const path = picked?.path;
      if (!path) return { kind: 'none' };
      const name = repoBaseName(path);
      const r = await addRoot(sessionId, path);
      if (r?.ok) return { kind: 'added', key: folderKey(path), name };
      error(addFailureCopy(r?.reason, name));
      return { kind: 'none' };
    },

    async remove(section) {
      const key = section.key;
      const dirty = [...deps.dirtyPaths()].filter((p) => isAncestorOf(key, folderKey(p))).length;
      if (dirty > 0) {
        error(STR.dirty(dirty, section.label));
        return { kind: 'none' };
      }
      const r = await request(
        (requestId) => ({ type: 'session:removeRoot', sessionId, path: section.path, requestId }),
        ['session:opResult'],
        OP_TIMEOUT_MS,
      );
      if (!r?.ok) {
        error(STR.removeFailed(section.label));
        return { kind: 'none' };
      }
      // Captured now: Undo targets this session and spelling even after a session switch.
      const captured = { sid: sessionId, path: section.path, label: section.label };
      deps.toast({
        message: STR.removed(section.label),
        variant: 'info',
        // addRoot would reject a folder that isn't on disk, so a missing one gets no Undo.
        ...(section.missing
          ? {}
          : {
              action: {
                label: STR.undo,
                run: () => {
                  void addRoot(captured.sid, captured.path).then((u) => {
                    if (!u?.ok && u?.reason !== 'duplicate') {
                      error(addFailureCopy(u?.reason, captured.label));
                    }
                  });
                },
              },
            }),
      });
      return { kind: 'removed', key, name: section.label };
    },

    async makeHome(section) {
      const r = await request(
        (requestId) => ({ type: 'session:setHome', sessionId, path: section.path, requestId }),
        ['session:opResult'],
        OP_TIMEOUT_MS,
      );
      if (!r?.ok) error(STR.makeHomeFailed(section.label));
    },

    async locate(section) {
      const r = await request(
        (requestId) => ({
          type: 'session:locateFolder',
          sessionId,
          path: section.path,
          requestId,
        }),
        ['session:locateResult'],
        PICK_TIMEOUT_MS,
      );
      if (!r || r.reason === 'cancelled') return { kind: 'none' };
      if (r.ok && r.path !== undefined) {
        return { kind: 'located', key: folderKey(r.path), name: repoBaseName(r.path) };
      }
      const picked = r.path !== undefined ? repoBaseName(r.path) : section.label;
      error(
        r.reason === 'duplicate' || r.reason === 'overlaps'
          ? addFailureCopy(r.reason, picked)
          : STR.locateFailed(section.label),
      );
      return { kind: 'none' };
    },

    async attach(paths) {
      const attached: string[] = [];
      const failed: string[] = [];
      for (const p of paths) {
        const r = await addRoot(sessionId, p);
        (r?.ok ? attached : failed).push(p);
      }
      return { attached, failed };
    },
  };
}
