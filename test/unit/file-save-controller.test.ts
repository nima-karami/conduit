import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WriteOptions, WriteResult } from '../../src/path-guard';
import type { AutoSaveMode } from '../../src/settings';
import { AUTO_SAVE_COPY } from '../../webview/auto-save-copy';
import {
  createFileSaves,
  type FileSaveDeps,
  type SaveModel,
} from '../../webview/file-save-controller';
import type { SaveEntry } from '../../webview/save-registry';

const PARTIAL = AUTO_SAVE_COPY.partialFile;

class FakeModel implements SaveModel {
  private listeners = new Set<() => void>();
  constructor(public value: string) {}
  getValue() {
    return this.value;
  }
  setValue(v: string) {
    this.value = v;
    for (const l of this.listeners) l();
  }
  onDidChangeContent(cb: () => void) {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }
  get listenerCount() {
    return this.listeners.size;
  }
}

/** Monaco picks one EOL for a mixed file, so a seed can differ from the disk bytes (C10). */
class NormalizingModel extends FakeModel {
  setValue(v: string) {
    super.setValue(v.replace(/\r\n/g, '\n'));
  }
}

interface PendingWrite {
  path: string;
  content: string;
  opts?: WriteOptions;
  resolve: (r: WriteResult) => void;
}

function harness(opts: { canWrite?: boolean; mode?: AutoSaveMode; delayMs?: number } = {}) {
  const models = new Map<string, FakeModel>();
  const writes: PendingWrite[] = [];
  const dirty = new Set<string>();
  const registered = new Map<string, SaveEntry>();
  let registerCalls = 0;
  const calls: string[] = [];
  const toasts: string[] = [];
  const saved: [string, string][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: FileSaveDeps = {
    getModel: (p) => models.get(p) ?? null,
    write: (path, content, o) =>
      new Promise<WriteResult>((resolve) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        writes.push({
          path,
          content,
          opts: o,
          resolve: (r) => {
            inFlight--;
            resolve(r);
          },
        });
      }),
    canWrite: opts.canWrite ?? true,
    isMarkedDirty: (p) => dirty.has(p),
    setDirty: (p, baseline, buffer) => {
      if (baseline === buffer) dirty.delete(p);
      else dirty.add(p);
    },
    clearDirty: (p) => {
      calls.push('clearDirty');
      dirty.delete(p);
    },
    register: (p, entry) => {
      registerCalls++;
      registered.set(p, entry);
      return () => {
        if (registered.get(p) === entry) registered.delete(p);
      };
    },
    onSaved: (p, c) => saved.push([p, c]),
    requestRead: () => calls.push('requestRead'),
    toast: (m) => toasts.push(m),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const saves = createFileSaves(deps);
  saves.configure({ mode: opts.mode ?? 'off', delayMs: opts.delayMs ?? 1000 });
  const open = (path: string, disk: string, readOnly: string | null = null) => {
    if (!models.has(path)) models.set(path, new FakeModel(disk));
    saves.attach(path, { diskContent: disk, readOnly });
    // biome-ignore lint/style/noNonNullAssertion: set on the line above
    return models.get(path)!;
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return {
    saves,
    models,
    writes,
    dirty,
    registered,
    calls,
    toasts,
    saved,
    open,
    flush,
    get registerCalls() {
      return registerCalls;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const OK = (path: string): WriteResult => ({ ok: true, path });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createFileSaves', () => {
  it('attach reseeds a clean model without counting an edit', async () => {
    const h = harness({ mode: 'onFocusChange' });
    h.models.set('/a.ts', new FakeModel('x'));
    h.saves.attach('/a.ts', { diskContent: 'y', readOnly: null });
    expect(h.models.get('/a.ts')?.getValue()).toBe('y');
    h.saves.trigger('/a.ts', 'viewLeave');
    await vi.runAllTimersAsync();
    expect(h.writes).toHaveLength(0);
  });

  it('a seed that normalises content is dirty but never auto-saved (C10)', async () => {
    const h = harness({ mode: 'onFocusChange' });
    h.models.set('/a.ts', new NormalizingModel('stale'));
    h.saves.attach('/a.ts', { diskContent: 'a\r\nb\n', readOnly: null });
    expect(h.models.get('/a.ts')?.getValue()).toBe('a\nb\n');
    expect(h.dirty.has('/a.ts')).toBe(true);
    h.saves.trigger('/a.ts', 'viewLeave');
    await vi.runAllTimersAsync();
    expect(h.writes).toHaveLength(0);
  });

  it('a seed-dirty buffer saves manually: one write, true only after it (B2)', async () => {
    const h = harness();
    h.models.set('/a.ts', new NormalizingModel('stale'));
    h.saves.attach('/a.ts', { diskContent: 'a\r\nb\n', readOnly: null });
    expect(h.saves.getStatus('/a.ts')?.phase).toBe('dirty');
    let settled = false;
    const p = h.saves.save('/a.ts', 'manual').then((ok) => {
      settled = true;
      return ok;
    });
    await h.flush();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].content).toBe('a\nb\n');
    expect(settled).toBe(false);
    h.writes[0].resolve(OK('/a.ts'));
    expect(await p).toBe(true);
    expect(h.dirty.has('/a.ts')).toBe(false);
  });

  it('an auto save of an unedited seed-dirty buffer writes nothing', async () => {
    const h = harness({ mode: 'onFocusChange' });
    h.models.set('/a.ts', new NormalizingModel('stale'));
    h.saves.attach('/a.ts', { diskContent: 'a\r\nb\n', readOnly: null });
    const p = h.saves.save('/a.ts', 'auto');
    expect(h.writes).toHaveLength(0);
    expect(await p).toBe(false);
    expect(h.saves.getStatus('/a.ts')).toMatchObject({ phase: 'dirty', edited: false });
  });

  it('attach never reseeds a marked-dirty model', () => {
    const h = harness();
    const m = h.open('/a.ts', 'one');
    m.setValue('mine');
    h.saves.attach('/a.ts', { diskContent: 'theirs', readOnly: null });
    expect(m.getValue()).toBe('mine');
  });

  it('afterDelay writes once after the delay with expected baseline', async () => {
    const h = harness({ mode: 'afterDelay' });
    const m = h.open('/a.ts', 'one');
    for (const ch of ['a', 'b', 'c']) {
      m.setValue(m.getValue() + ch);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].content).toBe('oneabc');
    expect(h.writes[0].opts?.expected).toBe('one');
  });

  it('manual save sends no expected', async () => {
    const h = harness();
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    const p = h.saves.save('/a.ts', 'manual');
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].opts?.expected).toBeUndefined();
    h.writes[0].resolve(OK('/a.ts'));
    expect(await p).toBe(true);
    expect(h.dirty.has('/a.ts')).toBe(false);
    expect(h.saved).toEqual([['/a.ts', 'two']]);
  });

  it('edit during write triggers exactly one trailing save (E1)', async () => {
    const h = harness({ mode: 'afterDelay', delayMs: 100 });
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    await vi.advanceTimersByTimeAsync(100);
    expect(h.writes).toHaveLength(1);
    m.setValue('three');
    await vi.advanceTimersByTimeAsync(100);
    m.setValue('four');
    await vi.advanceTimersByTimeAsync(100);
    expect(h.writes).toHaveLength(1);
    h.writes[0].resolve(OK('/a.ts'));
    await h.flush();
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].content).toBe('four');
    expect(h.writes[1].opts?.expected).toBe('two');
    h.writes[1].resolve(OK('/a.ts'));
    await vi.runAllTimersAsync();
    expect(h.writes).toHaveLength(2);
    expect(h.maxInFlight).toBe(1);
    expect(h.saves.getStatus('/a.ts')?.phase).toBe('clean');
  });

  it('concurrent save calls share one chain and both resolve with its result', async () => {
    const h = harness();
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    const a = h.saves.save('/a.ts', 'manual');
    const b = h.saves.save('/a.ts', 'manual');
    expect(h.writes).toHaveLength(1);
    h.writes[0].resolve(OK('/a.ts'));
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(h.writes).toHaveLength(1);
    expect(h.maxInFlight).toBe(1);
  });

  it('conflict changed pauses: manual save returns false and does not write; force writes without expected', async () => {
    const h = harness({ mode: 'onFocusChange' });
    const m = h.open('/a.ts', 'one');
    m.setValue('mine');
    h.saves.trigger('/a.ts', 'editorBlur');
    h.writes[0].resolve({ ok: false, conflict: 'changed', error: 'The file changed on disk.' });
    await h.flush();
    expect(h.saves.getStatus('/a.ts')).toEqual({
      phase: 'conflict',
      edited: true,
      conflict: 'changed',
      error: 'The file changed on disk.',
    });
    expect(await h.saves.save('/a.ts', 'manual')).toBe(false);
    m.setValue('mine2');
    h.saves.trigger('/a.ts', 'editorBlur');
    expect(h.writes).toHaveLength(1);
    expect(h.toasts).toEqual([]);
    const forced = h.saves.save('/a.ts', 'force');
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].opts?.expected).toBeUndefined();
    h.writes[1].resolve(OK('/a.ts'));
    expect(await forced).toBe(true);
    expect(h.saves.getStatus('/a.ts')?.phase).toBe('clean');
  });

  it('reload clears dirty, resets to clean, then requests a read', async () => {
    const h = harness({ mode: 'onFocusChange' });
    const m = h.open('/a.ts', 'one');
    m.setValue('mine');
    h.saves.trigger('/a.ts', 'editorBlur');
    h.writes[0].resolve({ ok: false, conflict: 'changed', error: 'The file changed on disk.' });
    await h.flush();
    h.saves.reload('/a.ts');
    expect(h.calls).toEqual(['clearDirty', 'requestRead']);
    expect(h.saves.getStatus('/a.ts')).toEqual({
      phase: 'clean',
      edited: false,
      conflict: null,
      error: null,
    });
    h.saves.attach('/a.ts', { diskContent: 'theirs', readOnly: null });
    expect(m.getValue()).toBe('theirs');
    expect(h.dirty.has('/a.ts')).toBe(false);
  });

  it('a truncated entry is never written, however it is saved (E9)', async () => {
    const h = harness({ mode: 'afterDelay' });
    const m = h.open('/big.txt', 'one', PARTIAL);
    m.setValue('two');
    await vi.advanceTimersByTimeAsync(5000);
    h.saves.trigger('/big.txt', 'viewLeave');
    await h.saves.flushAll('windowBlur');
    const manual = h.saves.save('/big.txt', 'manual');
    const viaRegistry = h.registered.get('/big.txt')?.save();
    expect(h.writes).toHaveLength(0);
    expect(await manual).toBe(false);
    expect(await viaRegistry).toBe(false);
    expect(h.toasts).toHaveLength(2);
    expect(h.saves.getStatus('/big.txt')?.error).toMatch(/2 MB/);
  });

  it('a refused save names why the doc is read-only, not always the 2 MB cut', async () => {
    const h = harness();
    const m = h.open('/latin1.txt', 'caf?', AUTO_SAVE_COPY.invalidUtf8Refusal);
    m.setValue('changed');
    expect(await h.saves.save('/latin1.txt', 'manual')).toBe(false);
    expect(h.toasts).toEqual([
      AUTO_SAVE_COPY.saveFailed('latin1.txt', AUTO_SAVE_COPY.invalidUtf8Refusal),
    ]);
    expect(h.toasts[0]).not.toMatch(/2 MB/);
  });

  it('a clean truncated entry saves as a no-op, without a toast', async () => {
    const h = harness();
    h.open('/big.txt', 'one', PARTIAL);
    expect(await h.saves.save('/big.txt', 'manual')).toBe(true);
    expect(h.writes).toHaveLength(0);
    expect(h.toasts).toEqual([]);
  });

  it('an auto save of a truncated entry writes nothing and leaves the phase (B3)', async () => {
    const h = harness({ mode: 'onFocusChange' });
    const m = h.open('/big.txt', 'one', PARTIAL);
    m.setValue('two');
    const before = h.saves.getStatus('/big.txt');
    const p = h.saves.save('/big.txt', 'auto');
    expect(h.writes).toHaveLength(0);
    expect(await p).toBe(false);
    expect(h.saves.getStatus('/big.txt')).toBe(before);
  });

  it('rename moves the entry — buffer, dirty flag, save entry and writer — to the new path', async () => {
    const h = harness({ mode: 'afterDelay', delayMs: 100 });
    const old = h.open('/a.ts', 'one');
    old.setValue('two');
    h.models.set('/b.ts', new FakeModel('two'));
    h.saves.rename('/a.ts', '/b.ts');
    expect(h.dirty.has('/a.ts')).toBe(false);
    expect(h.dirty.has('/b.ts')).toBe(true);
    expect(h.registered.has('/a.ts')).toBe(false);
    expect(h.saves.getStatus('/a.ts')).toBeUndefined();
    expect(h.saves.getStatus('/b.ts')?.edited).toBe(true);
    expect(old.listenerCount).toBe(0);

    const p = h.registered.get('/b.ts')?.save();
    expect(h.writes.map((w) => [w.path, w.content])).toEqual([['/b.ts', 'two']]);
    h.writes[0].resolve(OK('/b.ts'));
    expect(await p).toBe(true);
    expect(h.dirty.has('/b.ts')).toBe(false);

    h.models.get('/b.ts')?.setValue('three');
    await vi.advanceTimersByTimeAsync(150);
    expect(h.writes.map((w) => [w.path, w.content, w.opts?.expected])).toEqual([
      ['/b.ts', 'two', undefined],
      ['/b.ts', 'three', 'two'],
    ]);
  });

  it('a timer armed before the rename fires against the new path', async () => {
    const h = harness({ mode: 'afterDelay', delayMs: 100 });
    h.open('/a.ts', 'one').setValue('two');
    h.models.set('/b.ts', new FakeModel('two'));
    h.saves.rename('/a.ts', '/b.ts');
    await vi.advanceTimersByTimeAsync(150);
    expect(h.writes.map((w) => w.path)).toEqual(['/b.ts']);
  });

  it('rename onto a path that already has an entry changes nothing', () => {
    const h = harness();
    h.open('/a.ts', 'one').setValue('two');
    h.open('/b.ts', 'other');
    expect(h.saves.canRename('/a.ts', '/b.ts')).toBe(false);
    h.saves.rename('/a.ts', '/b.ts');
    expect(h.registered.has('/a.ts')).toBe(true);
    expect(h.dirty.has('/a.ts')).toBe(true);
  });

  it('canRename allows a free destination, and a path without an entry', () => {
    const h = harness();
    h.open('/a.ts', 'one');
    expect(h.saves.canRename('/a.ts', '/b.ts')).toBe(true);
    expect(h.saves.canRename('/none.ts', '/b.ts')).toBe(true);
    expect(h.saves.canRename('/a.ts', '/a.ts')).toBe(false);
  });

  it('a write in flight when the file is renamed does not count as saving the new path', async () => {
    const h = harness();
    h.open('/a.ts', 'one').setValue('two');
    const p = h.saves.save('/a.ts', 'manual');
    expect(h.writes.map((w) => w.path)).toEqual(['/a.ts']);
    h.models.set('/b.ts', new FakeModel('two'));
    h.saves.rename('/a.ts', '/b.ts');
    h.writes[0].resolve(OK('/a.ts'));
    await h.flush();
    expect(h.dirty.has('/b.ts')).toBe(true);
    expect(h.saved).toEqual([]);
    expect(h.writes.map((w) => [w.path, w.content])).toEqual([
      ['/a.ts', 'two'],
      ['/b.ts', 'two'],
    ]);
    h.writes[1].resolve(OK('/b.ts'));
    expect(await p).toBe(true);
    expect(h.dirty.has('/b.ts')).toBe(false);
    expect(h.saved).toEqual([['/b.ts', 'two']]);
  });

  it('marking a dirty entry deleted pauses it: no auto or manual write, force recreates', async () => {
    const h = harness({ mode: 'afterDelay', delayMs: 100 });
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    h.saves.markConflict('/a.ts', 'deleted');
    expect(h.saves.getStatus('/a.ts')).toMatchObject({ phase: 'conflict', conflict: 'deleted' });
    m.setValue('three');
    await vi.advanceTimersByTimeAsync(500);
    await h.saves.flushAll('windowBlur');
    expect(await h.saves.save('/a.ts', 'manual')).toBe(false);
    expect(h.writes).toHaveLength(0);
    expect(h.dirty.has('/a.ts')).toBe(true);
    const p = h.saves.save('/a.ts', 'force');
    expect(h.writes.map((w) => [w.path, w.content, w.opts?.expected])).toEqual([
      ['/a.ts', 'three', undefined],
    ]);
    h.writes[0].resolve(OK('/a.ts'));
    expect(await p).toBe(true);
  });

  it('marking a dirty entry changed on disk pauses it; Reload takes the disk version', async () => {
    const h = harness({ mode: 'afterDelay', delayMs: 100 });
    const m = h.open('/a.ts', 'one');
    m.setValue('mine');
    h.saves.markConflict('/a.ts', 'changed');
    expect(h.saves.getStatus('/a.ts')).toMatchObject({ phase: 'conflict', conflict: 'changed' });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.writes).toHaveLength(0);
    h.saves.reload('/a.ts');
    h.saves.attach('/a.ts', { diskContent: 'moved in', readOnly: null });
    expect(m.getValue()).toBe('moved in');
    expect(h.dirty.has('/a.ts')).toBe(false);
  });

  it('canWrite false: auto trigger is silent, manual save toasts once', async () => {
    const h = harness({ canWrite: false, mode: 'afterDelay' });
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    await vi.advanceTimersByTimeAsync(5000);
    h.saves.trigger('/a.ts', 'windowBlur');
    expect(await h.saves.save('/a.ts', 'auto')).toBe(false);
    expect(h.toasts).toEqual([]);
    expect(await h.saves.save('/a.ts', 'manual')).toBe(false);
    expect(h.toasts).toHaveLength(1);
    expect(h.writes).toHaveLength(0);
  });

  it('a failed auto save toasts only on the first failure of a streak', async () => {
    const h = harness({ mode: 'onFocusChange' });
    const m = h.open('/a.ts', 'one');
    for (const v of ['two', 'three']) {
      m.setValue(v);
      h.saves.trigger('/a.ts', 'editorBlur');
      h.writes[h.writes.length - 1].resolve({ ok: false, error: 'EACCES' });
      await h.flush();
    }
    expect(h.writes).toHaveLength(2);
    expect(h.toasts).toEqual(['Could not save a.ts: EACCES']);
    expect(h.saves.getStatus('/a.ts')).toEqual({
      phase: 'failed',
      edited: true,
      conflict: null,
      error: 'EACCES',
    });
    expect(h.dirty.has('/a.ts')).toBe(true);
  });

  it('flushAll aggregates two failures into one toast', async () => {
    const h = harness({ mode: 'onWindowChange' });
    for (const p of ['/a.ts', '/b.ts']) h.open(p, 'one').setValue('two');
    const done = h.saves.flushAll('windowBlur');
    expect(h.writes).toHaveLength(2);
    for (const w of h.writes) w.resolve({ ok: false, error: 'EACCES' });
    await done;
    expect(h.toasts).toEqual(['Could not save 2 files']);
  });

  it('write resolving after dispose is ignored', async () => {
    const h = harness();
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    const p = h.saves.save('/a.ts', 'manual');
    h.saves.dispose('/a.ts');
    const setDirtyBefore = h.dirty.has('/a.ts');
    h.writes[0].resolve(OK('/a.ts'));
    await p;
    expect(h.saved).toEqual([]);
    expect(h.dirty.has('/a.ts')).toBe(setDirtyBefore);
    expect(h.saves.getStatus('/a.ts')).toBeUndefined();
  });

  it('save entry stays registered after the editor is gone until dispose (D11 / C9)', async () => {
    const h = harness();
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    const entry = h.registered.get('/a.ts');
    expect(entry).toBeDefined();
    const p = entry?.save();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].opts?.expected).toBeUndefined();
    h.writes[0].resolve(OK('/a.ts'));
    expect(await p).toBe(true);
    h.saves.dispose('/a.ts');
    expect(h.registered.has('/a.ts')).toBe(false);
    expect(m.listenerCount).toBe(0);
  });

  it('revert restores the baseline and clears dirty', () => {
    const h = harness();
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    h.registered.get('/a.ts')?.revert?.();
    expect(m.getValue()).toBe('one');
    expect(h.dirty.has('/a.ts')).toBe(false);
  });

  it('mode change clears an armed timer', async () => {
    const h = harness({ mode: 'afterDelay' });
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    h.saves.configure({ mode: 'onWindowChange', delayMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.writes).toHaveLength(0);
  });

  it('status snapshot identity changes only when a status changes', () => {
    const h = harness({ mode: 'afterDelay' });
    const m = h.open('/a.ts', 'one');
    const s0 = h.saves.getStatusSnapshot();
    const notified = vi.fn();
    h.saves.subscribe(notified);
    m.setValue('two');
    const s1 = h.saves.getStatusSnapshot();
    expect(s1).not.toBe(s0);
    m.setValue('three');
    expect(h.saves.getStatusSnapshot()).toBe(s1);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('whenIdle waits for the chain and a queued trailing save', async () => {
    const h = harness();
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    void h.saves.save('/a.ts', 'manual');
    m.setValue('three');
    void h.saves.save('/a.ts', 'manual');
    let idle = false;
    const done = h.saves.whenIdle().then(() => {
      idle = true;
    });
    expect(h.writes).toHaveLength(1);
    h.writes[0].resolve(OK('/a.ts'));
    await h.flush();
    expect(h.writes).toHaveLength(2);
    expect(idle).toBe(false);
    h.writes[1].resolve(OK('/a.ts'));
    await done;
    expect(idle).toBe(true);
  });

  it('whenIdle re-checks for a chain started while it waited', async () => {
    const h = harness();
    h.open('/a.ts', 'one').setValue('two');
    const b = h.open('/b.ts', 'one');
    void h.saves.save('/a.ts', 'manual');
    let idle = false;
    const done = h.saves.whenIdle().then(() => {
      idle = true;
    });
    b.setValue('two');
    h.writes[0].resolve(OK('/a.ts'));
    void h.saves.save('/b.ts', 'manual');
    await h.flush();
    expect(h.writes).toHaveLength(2);
    expect(idle).toBe(false);
    h.writes[1].resolve(OK('/b.ts'));
    await done;
    expect(idle).toBe(true);
  });

  it('whenIdle resolves immediately with no chains', async () => {
    const h = harness();
    h.open('/a.ts', 'one').setValue('two');
    let idle = false;
    void h.saves.whenIdle().then(() => {
      idle = true;
    });
    await h.flush();
    expect(idle).toBe(true);
  });

  it('toasts suppressed while on', async () => {
    const h = harness({ mode: 'onFocusChange' });
    const m = h.open('/a.ts', 'one');
    h.saves.setToastsSuppressed(true);
    m.setValue('two');
    h.saves.trigger('/a.ts', 'editorBlur');
    h.writes[0].resolve({ ok: false, error: 'EACCES' });
    await h.flush();
    expect(h.saves.getStatus('/a.ts')?.phase).toBe('failed');
    expect(h.toasts).toEqual([]);
    h.saves.setToastsSuppressed(false);
    h.saves.reload('/a.ts');
    m.setValue('three');
    h.saves.trigger('/a.ts', 'editorBlur');
    h.writes[1].resolve({ ok: false, error: 'EACCES' });
    await h.flush();
    expect(h.toasts).toEqual(['Could not save a.ts: EACCES']);
  });

  it('toasts suppressed while on covers the flushAll batch and the preview refusal', async () => {
    const h = harness({ mode: 'onWindowChange' });
    for (const p of ['/a.ts', '/b.ts']) h.open(p, 'one').setValue('two');
    h.saves.setToastsSuppressed(true);
    const done = h.saves.flushAll('windowBlur');
    for (const w of h.writes) w.resolve({ ok: false, error: 'EACCES' });
    await done;
    const preview = harness({ canWrite: false });
    preview.saves.setToastsSuppressed(true);
    preview.open('/a.ts', 'one').setValue('two');
    expect(await preview.saves.save('/a.ts', 'manual')).toBe(false);
    expect(preview.saves.getStatus('/a.ts')?.error).toBe(
      'Saving is unavailable in the browser preview.',
    );
    expect([...h.toasts, ...preview.toasts]).toEqual([]);
  });

  it('isPartial reflects autoEligible:false attach', () => {
    const h = harness();
    h.open('/part.ts', 'head', PARTIAL);
    h.open('/full.ts', 'all');
    expect(h.saves.isPartial('/part.ts')).toBe(true);
    expect(h.saves.isPartial('/full.ts')).toBe(false);
    expect(h.saves.isPartial('/none.ts')).toBe(false);
  });

  it('off mode still tracks edited/conflict/failed (A3)', async () => {
    const h = harness({ mode: 'off' });
    const m = h.open('/a.ts', 'one');
    m.setValue('two');
    expect(h.saves.getStatus('/a.ts')).toMatchObject({ phase: 'dirty', edited: true });
    const conflicted = h.saves.save('/a.ts', 'manual');
    h.writes[0].resolve({ ok: false, conflict: 'deleted', error: 'The file was deleted.' });
    expect(await conflicted).toBe(false);
    expect(h.saves.getStatus('/a.ts')).toMatchObject({ phase: 'conflict', conflict: 'deleted' });
    const b = h.open('/b.ts', 'one');
    b.setValue('two');
    const failed = h.saves.save('/b.ts', 'manual');
    h.writes[1].resolve({ ok: false, error: 'EACCES' });
    expect(await failed).toBe(false);
    expect(h.saves.getStatus('/b.ts')).toMatchObject({ phase: 'failed', error: 'EACCES' });
  });

  it('a second attach on the same path keeps one save registration and one content subscription', () => {
    const h = harness({ mode: 'afterDelay' });
    const m = new FakeModel('one');
    h.models.set('/a.ts', m);
    const subscribe = vi.spyOn(m, 'onDidChangeContent');
    h.saves.attach('/a.ts', { diskContent: 'one', readOnly: null });
    h.saves.attach('/a.ts', { diskContent: 'one', readOnly: null });
    expect(h.registerCalls).toBe(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(m.listenerCount).toBe(1);
  });
});
