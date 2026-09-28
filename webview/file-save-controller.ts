import type { WriteConflict, WriteOptions, WriteResult } from '../src/path-guard';
import type { AutoSaveMode } from '../src/settings';
import { AUTO_SAVE_COPY } from './auto-save-copy';
import {
  type AutoSaveEvent,
  type AutoSavePhase,
  type AutoSaveState,
  type AutoSaveTrigger,
  autoSaveStep,
  INITIAL_AUTO_SAVE_STATE,
  type SaveKind,
} from './auto-save-policy';
import type { SaveEntry } from './save-registry';

/**
 * The per-path save store: one entry per open file tab, backed by its Monaco model, so it
 * outlives the editor (recreated on every save, C8) and the tab's unmount (C9). Every dependency
 * is injected. Contract: docs/plans/2026-09-28-auto-save.plan.md (Contracts → Store).
 */

export interface SaveModel {
  getValue(): string;
  setValue(value: string): void;
  onDidChangeContent(cb: () => void): { dispose(): void };
}

export interface FileSaveDeps {
  getModel(path: string): SaveModel | null;
  write(path: string, content: string, opts?: WriteOptions): Promise<WriteResult>;
  canWrite: boolean;
  isMarkedDirty(path: string): boolean;
  setDirty(path: string, baseline: string, buffer: string): void;
  clearDirty(path: string): void;
  register(path: string, entry: SaveEntry): () => void;
  onSaved(path: string, content: string): void;
  requestRead(path: string): void;
  toast(message: string): void;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface AttachOpts {
  diskContent: string;
  /** false for a truncated doc (D7); binary docs never attach. */
  autoEligible: boolean;
}

export interface FileSaveStatus {
  phase: AutoSavePhase;
  conflict: WriteConflict | null;
  /** Last write failure reason; cleared when a write starts. */
  error: string | null;
}

export interface FileSaves {
  configure(cfg: { mode: AutoSaveMode; delayMs: number }): void;
  attach(path: string, opts: AttachOpts): void;
  dispose(path: string): void;
  save(path: string, kind: SaveKind): Promise<boolean>;
  trigger(path: string, trigger: AutoSaveTrigger): void;
  flushAll(trigger: 'windowBlur'): Promise<void>;
  reload(path: string): void;
  revert(path: string): void;
  getStatus(path: string): FileSaveStatus | undefined;
  getStatusSnapshot(): ReadonlyMap<string, FileSaveStatus>;
  subscribe(cb: () => void): () => void;
}

interface Entry {
  path: string;
  model: SaveModel;
  sub: { dispose(): void } | null;
  unregister: () => void;
  baseline: string;
  autoEligible: boolean;
  state: AutoSaveState;
  timer: unknown;
  /** The single write chain in flight (E1); a trailing save joins it via `next`. */
  chain: Promise<void> | null;
  next: SaveKind | null;
  lastOk: boolean;
  seeding: boolean;
  error: string | null;
  disposed: boolean;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export function createFileSaves(deps: FileSaveDeps): FileSaves {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, FileSaveStatus> = new Map();
  let mode: AutoSaveMode = 'off';
  let delayMs = 1000;
  // While flushAll runs, failures are gathered into one toast instead of one per file.
  let collecting: { path: string; error: string }[] | null = null;

  const notify = () => {
    for (const l of listeners) l();
  };

  const publish = (e: Entry) => {
    const prev = snapshot.get(e.path);
    const { phase, conflict } = e.state;
    if (prev && prev.phase === phase && prev.conflict === conflict && prev.error === e.error) {
      return;
    }
    snapshot = new Map(snapshot).set(e.path, { phase, conflict, error: e.error });
    notify();
  };

  const clearTimer = (e: Entry) => {
    if (e.timer === null) return;
    deps.clearTimer(e.timer);
    e.timer = null;
  };

  const reportFailure = (e: Entry) => {
    const error = e.error ?? '';
    if (collecting) collecting.push({ path: e.path, error });
    else deps.toast(AUTO_SAVE_COPY.saveFailed(baseName(e.path), error));
  };

  const write = async (e: Entry, kind: SaveKind) => {
    const content = e.model.getValue();
    e.error = null;
    publish(e);
    let res: WriteResult;
    try {
      res = await deps.write(
        e.path,
        content,
        kind === 'auto' ? { expected: e.baseline } : undefined,
      );
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (e.disposed) return;
    e.lastOk = res.ok;
    if (res.ok) {
      e.baseline = content;
      deps.setDirty(e.path, content, e.model.getValue());
      deps.onSaved(e.path, content);
      step(e, { type: 'writeDone', outcome: 'ok', dirty: e.model.getValue() !== e.baseline });
      return;
    }
    e.error = res.error;
    step(
      e,
      res.conflict
        ? { type: 'writeDone', outcome: 'conflict', conflict: res.conflict }
        : { type: 'writeDone', outcome: 'failed', kind },
    );
  };

  const startChain = (e: Entry, kind: SaveKind) => {
    if (e.chain) {
      e.next = kind;
      return;
    }
    e.chain = (async () => {
      let k: SaveKind | null = kind;
      while (k !== null && !e.disposed) {
        e.next = null;
        await write(e, k);
        k = e.next;
      }
      e.chain = null;
    })();
  };

  function step(e: Entry, event: AutoSaveEvent) {
    const r = autoSaveStep(e.state, event, mode);
    e.state = r.state;
    for (const fx of r.effects) {
      if (fx.type === 'arm') {
        clearTimer(e);
        e.timer = deps.setTimer(() => {
          e.timer = null;
          trigger(e.path, 'timer');
        }, delayMs);
      } else if (fx.type === 'clear') clearTimer(e);
      else if (fx.type === 'reportFailure') reportFailure(e);
      else startChain(e, fx.kind);
    }
    publish(e);
  }

  function trigger(path: string, t: AutoSaveTrigger) {
    const e = entries.get(path);
    if (!e?.autoEligible || !deps.canWrite) return;
    step(e, { type: 'trigger', trigger: t });
  }

  const onContent = (e: Entry) => {
    const value = e.model.getValue();
    deps.setDirty(e.path, e.baseline, value);
    if (!e.seeding) step(e, { type: 'edit', dirty: value !== e.baseline });
  };

  const save = async (path: string, kind: SaveKind): Promise<boolean> => {
    const e = entries.get(path);
    if (!e) return true;
    // A truncated buffer holds only the first 2 MB; comparing it to the whole file would report
    // a conflict that isn't there (D7).
    if (kind === 'auto' && !e.autoEligible) return false;
    if (!deps.canWrite) {
      if (e.model.getValue() === e.baseline) return true;
      if (kind === 'auto') return false;
      e.error = 'Saving is unavailable in the browser preview.';
      publish(e);
      deps.toast(AUTO_SAVE_COPY.saveFailed(baseName(path), e.error));
      return false;
    }
    step(e, { type: 'request', kind });
    if (e.chain) {
      await e.chain;
      return e.lastOk;
    }
    return e.state.phase === 'clean';
  };

  const revert = (path: string) => {
    const e = entries.get(path);
    if (e) e.model.setValue(e.baseline);
  };

  return {
    configure(cfg) {
      delayMs = cfg.delayMs;
      if (cfg.mode === mode) return;
      mode = cfg.mode;
      for (const e of entries.values()) step(e, { type: 'modeChanged' });
    },

    attach(path, opts) {
      const model = deps.getModel(path);
      if (!model) return;
      let e = entries.get(path);
      if (!e) {
        const created: Entry = {
          path,
          model,
          sub: null,
          unregister: () => {},
          baseline: opts.diskContent,
          autoEligible: opts.autoEligible,
          state: INITIAL_AUTO_SAVE_STATE,
          timer: null,
          chain: null,
          next: null,
          lastOk: true,
          seeding: false,
          error: null,
          disposed: false,
        };
        created.unregister = deps.register(path, {
          save: (o) => save(path, o?.kind ?? 'manual'),
          revert: () => revert(path),
        });
        entries.set(path, created);
        e = created;
      }
      const entry = e;
      if (entry.sub === null || entry.model !== model) {
        entry.sub?.dispose();
        entry.model = model;
        entry.sub = model.onDidChangeContent(() => onContent(entry));
      }
      // see docs/plans/2026-09-28-auto-save.plan.md P5: a reseed is a seed, never an edit.
      if (!deps.isMarkedDirty(path) && model.getValue() !== opts.diskContent) {
        entry.seeding = true;
        try {
          model.setValue(opts.diskContent);
        } finally {
          entry.seeding = false;
        }
      }
      entry.baseline = opts.diskContent;
      entry.autoEligible = opts.autoEligible;
      deps.setDirty(path, entry.baseline, model.getValue());
      step(entry, { type: 'seed', dirty: model.getValue() !== entry.baseline });
    },

    dispose(path) {
      const e = entries.get(path);
      if (!e) return;
      e.disposed = true;
      clearTimer(e);
      e.sub?.dispose();
      e.unregister();
      entries.delete(path);
      const next = new Map(snapshot);
      next.delete(path);
      snapshot = next;
      notify();
    },

    save,
    trigger,

    async flushAll(t) {
      const failures: { path: string; error: string }[] = [];
      collecting = failures;
      try {
        for (const path of entries.keys()) trigger(path, t);
        await Promise.all([...entries.values()].map((e) => e.chain));
      } finally {
        collecting = null;
      }
      if (failures.length >= 2) deps.toast(AUTO_SAVE_COPY.saveFailedMany(failures.length));
      else if (failures.length === 1) {
        deps.toast(AUTO_SAVE_COPY.saveFailed(baseName(failures[0].path), failures[0].error));
      }
    },

    reload(path) {
      const e = entries.get(path);
      if (!e) return;
      // see docs/specs/2026-09-28-auto-save.md §2.3: clear first, then read.
      deps.clearDirty(path);
      e.error = null;
      step(e, { type: 'reset' });
      deps.requestRead(path);
    },

    revert,
    getStatus: (path) => snapshot.get(path),
    getStatusSnapshot: () => snapshot,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
