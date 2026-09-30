import { useMemo, useRef } from 'react';
import {
  type DirtyCloseReason,
  type DirtyFile,
  dirtyCloseCopy,
  dirtySaveStatus,
} from '../src/quit-guard';
import { type SaveProbe, saveUnsaved, unsavedFiles } from './unsaved-files';
import { type ModalEntry, type ModalSlot, nextModalKey } from './use-modal-slot';

export interface DirtyAsk {
  reason: DirtyCloseReason;
  paths: readonly string[];
  running: number;
  busy: number;
  exitedSession?: string;
  sessionOf?: (path: string) => string | undefined;
  grouped?: boolean;
  onShown?: () => void;
  signal?: AbortSignal;
}

export type DirtyAnswer = 'saved' | 'discarded' | 'cancel';

interface DirtyCloseDeps {
  saves: SaveProbe & { subscribe(cb: () => void): () => void };
  rootOf: (path: string) => string | undefined;
  slot: ModalSlot;
}

/** See the dirty-quit-guard plan, "Dialog hook". */
export function useDirtyClose(deps: DirtyCloseDeps): { ask(req: DirtyAsk): Promise<DirtyAnswer> } {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  return useMemo(
    () => ({
      ask: (req: DirtyAsk) =>
        new Promise<DirtyAnswer>((resolve) => {
          if (req.signal?.aborted) {
            resolve('cancel');
            return;
          }
          const { saves, rootOf, slot } = depsRef.current;
          const key = nextModalKey();
          const state: { files: DirtyFile[]; phase: 'ready' | 'saving'; status: string | null } = {
            files: unsavedFiles(req.paths, saves, rootOf, req.sessionOf),
            phase: 'ready',
            status: null,
          };
          let settled = false;

          const pending = () => state.files.filter((f) => f.tag !== 'saved');

          const finish = (answer: DirtyAnswer) => {
            if (settled) return;
            settled = true;
            unsubscribe();
            req.signal?.removeEventListener('abort', onAbort);
            slot.close(key);
            resolve(answer);
          };

          const entry = (): ModalEntry => ({
            kind: 'dirty',
            key,
            props: {
              copy: dirtyCloseCopy({
                files: state.files,
                running: req.running,
                busy: req.busy,
                reason: req.reason,
                exitedSession: req.exitedSession,
                grouped: req.grouped,
              }),
              phase: state.phase,
              status: state.status,
              onSaveAll,
              onDiscard: () => finish('discarded'),
              onCancel: () => finish('cancel'),
              onShown: req.onShown,
            },
          });

          const publish = () => {
            if (!settled) slot.update(entry());
          };

          async function onSaveAll() {
            if (settled || state.phase === 'saving') return;
            const toSave = pending();
            state.phase = 'saving';
            state.status = dirtySaveStatus('saving', toSave.length);
            publish();
            const { unsaved } = await saveUnsaved(toSave, saves);
            if (settled) return;
            if (unsaved.length === 0) {
              finish('saved');
              return;
            }
            state.files = unsaved;
            state.phase = 'ready';
            state.status = dirtySaveStatus('failed', unsaved.length);
            publish();
          }

          function onAbort() {
            finish('cancel');
          }

          const unsubscribe = saves.subscribe(() => {
            if (settled || slot.current?.key !== key) return;
            const fresh = unsavedFiles(
              state.files.map((f) => f.path),
              saves,
              rootOf,
              req.sessionOf,
            );
            state.files = fresh.map((f) => {
              if (saves.getStatus(f.path)?.phase !== 'clean') return f;
              const { error: _stale, ...rest } = f;
              return { ...rest, tag: 'saved' };
            });
            publish();
          });
          req.signal?.addEventListener('abort', onAbort);

          slot.open(entry());
        }),
    }),
    [],
  );
}
