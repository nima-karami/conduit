import { describe, expect, it, vi } from 'vitest';
import type { FileContentDTO, RemoteWriteOutcome } from '../../src/protocol';
import type { RemoteReadResult } from '../../webview/remote-files-store';
import type { SaveEntry } from '../../webview/save-registry';

vi.mock('monaco-editor', () => ({
  editor: { EndOfLinePreference: { TextDefined: 0 } },
}));
vi.mock('../../webview/bridge', () => ({ post: () => {}, subscribe: () => () => {} }));
// ts-nav pulls in the whole Monaco language stack; the factory only needs its language test.
vi.mock('../../webview/ts-nav', () => ({
  isTsLanguage: (id: string) => id === 'typescript' || id === 'javascript',
}));

import {
  createRemoteFileSaves,
  type RemoteBufferRef,
  type RemoteWriteRequest,
} from '../../webview/remote-file-saves';

const PATH = '/w/a.ts';
const KEY = `remote-file@M1:${PATH}`;
const REF: RemoteBufferRef = {
  key: KEY,
  machineId: 'M1',
  sessionId: 'S1',
  path: PATH,
  machineName: 'Box',
};

const file = (over: Partial<FileContentDTO> = {}): FileContentDTO => ({
  path: PATH,
  content: 'one',
  language: 'plaintext',
  truncated: false,
  binary: false,
  hash: 'h1',
  ...over,
});

class FakeModel {
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
}

function setup() {
  const models = new Map<string, FakeModel>();
  const disposed: FakeModel[] = [];
  const dirty = new Set<string>();
  const registered = new Map<string, SaveEntry>();
  const posts: RemoteWriteRequest[] = [];
  const answers: RemoteWriteOutcome[] = [];
  const reads: RemoteReadResult[] = [];
  const readCalls: string[] = [];
  const toasts: string[] = [];

  const store = createRemoteFileSaves({
    createModel: (ref, text) => {
      const m = new FakeModel(text);
      models.set(ref.key, m);
      return m;
    },
    getModel: (ref) => models.get(ref.key) ?? null,
    disposeModel: (m) => {
      disposed.push(m as FakeModel);
      models.forEach((v, k) => {
        if (v === m) models.delete(k);
      });
    },
    postWrite: async (req) => {
      posts.push(req);
      return answers.shift() ?? { kind: 'error', error: 'no answer queued' };
    },
    read: async (_m, _s, path) => {
      readCalls.push(path);
      return reads.shift() ?? { ok: false, error: 'no read queued' };
    },
    toast: (m) => toasts.push(m),
    setTimer: () => 0,
    clearTimer: () => {},
    isMarkedDirty: (k) => dirty.has(k),
    setDirty: (k, baseline, buffer) => {
      if (baseline === buffer) dirty.delete(k);
      else dirty.add(k);
    },
    clearDirty: (k) => {
      dirty.delete(k);
    },
    register: (k, entry) => {
      registered.set(k, entry);
      return () => {
        if (registered.get(k) === entry) registered.delete(k);
      };
    },
  });

  const model = (): FakeModel => {
    const m = models.get(KEY);
    if (!m) throw new Error('no model');
    return m;
  };
  return { store, model, dirty, registered, posts, answers, reads, readCalls, toasts, disposed };
}

describe('remote file saves', () => {
  it('(a) every save names the hash B last reported', async () => {
    const t = setup();
    t.store.open(REF, file({ content: 'one', hash: 'h1' }));

    t.model().setValue('two');
    t.answers.push({ kind: 'written', hash: 'h2' });
    expect(await t.store.save(KEY, 'manual')).toBe(true);
    expect(t.posts[0]).toMatchObject({ path: PATH, data: 'two', expect: 'h1' });

    t.model().setValue('three');
    t.answers.push({ kind: 'written', hash: 'h3' });
    expect(await t.store.save(KEY, 'manual')).toBe(true);
    expect(t.posts[1]).toMatchObject({ data: 'three', expect: 'h2' });
  });

  it('(b) a conflict is reported, and Re-apply names the hash B reported for it', async () => {
    const t = setup();
    t.store.open(REF, file({ content: 'one', hash: 'h1' }));
    t.model().setValue('mine');

    t.answers.push({ kind: 'conflict', currentHash: 'hB' });
    expect(await t.store.save(KEY, 'manual')).toBe(false);
    expect(t.store.getStatus(KEY)).toMatchObject({ phase: 'conflict', conflict: 'changed' });

    t.answers.push({ kind: 'written', hash: 'hB2' });
    expect(await t.store.reapply(KEY)).toBe(true);
    expect(t.posts.at(-1)).toMatchObject({ data: 'mine', expect: 'hB' });
  });

  it('(c) a conflict where B reports the file gone: Re-apply creates it (expect null)', async () => {
    const t = setup();
    t.store.open(REF, file({ content: 'one', hash: 'h1' }));
    t.model().setValue('mine');

    t.answers.push({ kind: 'conflict', currentHash: null });
    expect(await t.store.save(KEY, 'manual')).toBe(false);
    expect(t.store.getStatus(KEY)).toMatchObject({ phase: 'conflict', conflict: 'deleted' });

    t.answers.push({ kind: 'written', hash: 'hNew' });
    expect(await t.store.reapply(KEY)).toBe(true);
    expect(t.posts.at(-1)).toMatchObject({ data: 'mine', expect: null });
  });

  it('(d) a refresh while dirty keeps the old hash and the buffer', async () => {
    const t = setup();
    t.store.open(REF, file({ content: 'one', hash: 'h1' }));
    t.model().setValue('edited');

    t.store.open(REF, file({ content: 'B-new', hash: 'h2' }));
    expect(t.model().getValue()).toBe('edited');

    t.answers.push({ kind: 'written', hash: 'h3' });
    expect(await t.store.save(KEY, 'manual')).toBe(true);
    expect(t.posts[0]).toMatchObject({ data: 'edited', expect: 'h1' });
  });

  it('(e) a refresh while clean takes the new content and hash', async () => {
    const t = setup();
    t.store.open(REF, file({ content: 'one', hash: 'h1' }));

    t.store.open(REF, file({ content: 'B-new', hash: 'h2' }));
    expect(t.model().getValue()).toBe('B-new');
    expect(t.store.getStatus(KEY)?.phase).toBe('clean');

    t.model().setValue('B-new, edited');
    t.answers.push({ kind: 'written', hash: 'h3' });
    expect(await t.store.save(KEY, 'manual')).toBe(true);
    expect(t.posts[0]).toMatchObject({ data: 'B-new, edited', expect: 'h2' });
  });

  it.each([
    ['a file with no hash', file({ hash: undefined })],
    ['a file B cannot save', file({ readOnlyReason: 'remote' })],
  ])('(f) %s is read-only: save posts nothing', async (_name, f) => {
    const t = setup();
    t.store.open(REF, f);
    t.model().setValue('edited');

    expect(await t.store.save(KEY, 'manual')).toBe(false);
    expect(t.posts).toHaveLength(0);
  });

  it('(g) Discard re-reads B and takes its content and hash', async () => {
    const t = setup();
    t.store.open(REF, file({ content: 'one', hash: 'h1' }));
    t.model().setValue('mine');
    t.reads.push({
      ok: true,
      file: file({ content: 'B-disk', hash: 'h9' }),
    });

    t.store.reload(KEY);
    await new Promise((r) => setTimeout(r, 0));

    expect(t.readCalls).toEqual([PATH]);
    expect(t.model().getValue()).toBe('B-disk');
    expect(t.dirty.has(KEY)).toBe(false);

    t.model().setValue('B-disk, edited');
    t.answers.push({ kind: 'written', hash: 'h10' });
    expect(await t.store.save(KEY, 'manual')).toBe(true);
    expect(t.posts[0]).toMatchObject({ expect: 'h9' });
  });

  it('(h) closing a buffer disposes its model, clears dirty and drops its save entry', () => {
    const t = setup();
    t.store.open(REF, file({ content: 'one', hash: 'h1' }));
    t.model().setValue('edited');
    const model = t.model();
    expect(t.dirty.has(KEY)).toBe(true);
    expect(t.registered.has(KEY)).toBe(true);

    t.store.close(KEY);

    expect(t.disposed).toEqual([model]);
    expect(t.dirty.has(KEY)).toBe(false);
    expect(t.registered.has(KEY)).toBe(false);
    expect(t.store.modelOf(KEY)).toBeNull();
    expect(t.store.getStatus(KEY)).toBeUndefined();
  });
});
