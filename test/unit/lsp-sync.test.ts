import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspMessage } from '../../src/lsp-protocol';
import * as status from '../../webview/lsp-status';
import * as sync from '../../webview/lsp-sync';
import { fileUri } from '../../webview/project-index';

type Listener = () => void;

/** A model just rich enough for sync: value, content events, dispose event. */
function fakeModel(uri: { toString(): string }, value: string) {
  const change = new Set<Listener>();
  const dispose = new Set<Listener>();
  return {
    uri,
    value,
    getValue() {
      return this.value;
    },
    edit(v: string) {
      this.value = v;
      for (const l of change) l();
    },
    onDidChangeContent: (l: Listener) => {
      change.add(l);
      return { dispose: () => change.delete(l) };
    },
    onWillDispose: (l: Listener) => {
      dispose.add(l);
      return { dispose: () => dispose.delete(l) };
    },
  };
}
type FakeModel = ReturnType<typeof fakeModel>;

const h = vi.hoisted(() => ({
  models: new Map<string, unknown>(),
  created: new Set<(m: unknown) => void>(),
  sent: [] as LspMessage[],
  pushes: new Set<(m: unknown) => void>(),
  replies: {} as Record<string, unknown>,
}));

vi.mock('monaco-editor', async () => ({
  Uri: (await import('monaco-editor/esm/vs/base/common/uri.js')).URI,
  editor: {
    getModel: (uri: { toString(): string }) => h.models.get(uri.toString()) ?? null,
    onDidCreateModel: (cb: (m: unknown) => void) => {
      h.created.add(cb);
      return { dispose: () => h.created.delete(cb) };
    },
  },
}));

vi.mock('../../webview/bridge', () => ({
  lspInvoke: vi.fn(async (msg: LspMessage) => {
    h.sent.push(msg);
    return (
      h.replies[msg.type] ??
      (msg.type === 'lsp:open' ? { serverKey: 'go:/w', state: 'ready' } : { ok: true })
    );
  }),
  subscribe: (cb: (m: unknown) => void) => {
    h.pushes.add(cb);
    return () => h.pushes.delete(cb);
  },
}));

const P = '/w/main.go';
const doc = (text: string, path = P) => ({ path, languageId: 'go', text });
const types = () => h.sent.map((m) => m.type);

function addModel(path: string, value: string): FakeModel {
  const m = fakeModel(fileUri(path), value);
  h.models.set(fileUri(path).toString(), m);
  for (const cb of h.created) cb(m);
  return m;
}

beforeEach(() => {
  vi.useFakeTimers();
});
const onTeardown: (() => void)[] = [];

afterEach(async () => {
  for (const f of onTeardown.splice(0)) f();
  sync.reconcileLspDocs([]);
  await vi.runAllTimersAsync();
  h.sent.length = 0;
  h.models.clear();
  h.replies = {};
  vi.useRealTimers();
});

describe('lsp-sync', () => {
  it('reconcile opens new docs with version 1 and closes removed ones', async () => {
    sync.reconcileLspDocs([doc('a'), doc('b', '/w/b.go')]);
    expect(h.sent).toEqual([
      { type: 'lsp:open', path: P, languageId: 'go', version: 1, text: 'a' },
      { type: 'lsp:open', path: '/w/b.go', languageId: 'go', version: 1, text: 'b' },
    ]);
    sync.reconcileLspDocs([doc('a')]);
    expect(h.sent.at(-1)).toEqual({ type: 'lsp:close', path: '/w/b.go' });
    expect(sync.isLspDocOpen('/w/b.go')).toBe(false);
    expect(sync.isLspDocOpen(P)).toBe(true);
  });

  it('unchanged text sends nothing; changed text (e.g. a disk reload) sends a change', () => {
    sync.reconcileLspDocs([doc('a')]);
    sync.reconcileLspDocs([doc('a')]);
    expect(types()).toEqual(['lsp:open']);
    sync.reconcileLspDocs([doc('a2')]);
    expect(h.sent.at(-1)).toEqual({ type: 'lsp:change', path: P, version: 2, text: 'a2' });
  });

  it('model edits debounce to one lsp:change at 150 ms', async () => {
    const m = addModel(P, 'a');
    sync.reconcileLspDocs([doc('a')]);
    m.edit('ab');
    m.edit('abc');
    await vi.advanceTimersByTimeAsync(sync.LSP_CHANGE_DEBOUNCE_MS - 1);
    expect(types()).toEqual(['lsp:open']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent.at(-1)).toEqual({ type: 'lsp:change', path: P, version: 2, text: 'abc' });
    expect(types()).toEqual(['lsp:open', 'lsp:change']);
  });

  it('flushPending sends immediately and resolves after the invoke', async () => {
    const m = addModel(P, 'a');
    sync.reconcileLspDocs([doc('a')]);
    m.edit('typed');
    await sync.flushPending(P);
    expect(h.sent.at(-1)).toMatchObject({ type: 'lsp:change', text: 'typed', version: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(types().filter((t) => t === 'lsp:change')).toHaveLength(1);
    await sync.flushPending('/w/none.go');
  });

  it('a request carries the last sent version', async () => {
    const m = addModel(P, 'a');
    sync.reconcileLspDocs([doc('a')]);
    m.edit('b');
    await sync.flushPending(P);
    expect(sync.currentVersion(P)).toBe(2);
    h.replies['lsp:request'] = { kind: 'empty', adHocRoot: false };
    await sync.lspRequest(P, 'definition', { line: 1, character: 2 }, 'r1');
    expect(h.sent.at(-1)).toEqual({
      type: 'lsp:request',
      requestId: 'r1',
      path: P,
      version: 2,
      op: 'definition',
      line: 1,
      character: 2,
    });
  });

  it('a request for a path not open resolves empty without invoking', async () => {
    expect(await sync.lspRequest('/w/x.go', 'hover', { line: 0, character: 0 }, 'r')).toEqual({
      kind: 'empty',
      adHocRoot: false,
    });
    expect(h.sent).toEqual([]);
    expect(sync.currentVersion('/w/x.go')).toBeNull();
  });

  it('open reply records serverKey', async () => {
    h.replies['lsp:open'] = { serverKey: 'go:/w', state: 'starting' };
    sync.reconcileLspDocs([doc('a')]);
    expect(sync.serverKeyForDoc(P)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.serverKeyForDoc(P)).toBe('go:/w');
  });

  it('only models whose uri equals fileUri(tab path) are attached', async () => {
    h.replies['lsp:statusSnapshot'] = { servers: [], languages: [] };
    const dispose = sync.initLspClient();
    onTeardown.push(dispose);
    sync.reconcileLspDocs([doc('a')]);
    const other = addModel('/w/peek.go', 'x');
    const mine = addModel(P, 'a');
    other.edit('changed');
    await vi.advanceTimersByTimeAsync(200);
    expect(types()).not.toContain('lsp:change');
    mine.edit('mine');
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sent.at(-1)).toMatchObject({ type: 'lsp:change', path: P, text: 'mine' });
  });

  it('subscribeLspDocSent fires after the open and after each sent change', async () => {
    const seen: string[] = [];
    const off = sync.subscribeLspDocSent((p) => seen.push(p));
    const m = addModel(P, 'a');
    sync.reconcileLspDocs([doc('a')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([P]);
    m.edit('b');
    await vi.advanceTimersByTimeAsync(sync.LSP_CHANGE_DEBOUNCE_MS);
    m.edit('c');
    await sync.flushPending(P);
    expect(seen).toEqual([P, P, P]);
    off();
  });

  it('requestTrust asks the host and arms focus for the prompt the host names (the keyboard route)', async () => {
    h.replies['lsp:trustRequest'] = { ok: true, promptId: 'p9' };
    const bumps = vi.fn();
    const off = status.subscribeLspStatus(bumps);
    await sync.requestTrust('/w/main.go', 'go');
    off();
    status.setTrustFocusTarget(null);
    expect(h.sent.at(-1)).toEqual({
      type: 'lsp:trustRequest',
      path: '/w/main.go',
      languageId: 'go',
    });
    expect(bumps).toHaveBeenCalledTimes(1);
  });

  it('initLspClient seeds servers and languages from statusSnapshot and applies lsp:status pushes', async () => {
    const go = {
      languageId: 'go',
      displayName: 'Go',
      binary: 'gopls',
      installHint: 'go install golang.org/x/tools/gopls@latest',
      moduleMarker: 'go.mod',
    };
    h.replies['lsp:statusSnapshot'] = {
      servers: [{ serverKey: 'go:/w', languageId: 'go', root: '/w', state: 'loading', pid: 7 }],
      languages: [go],
    };
    const dispose = sync.initLspClient();
    await vi.advanceTimersByTimeAsync(0);
    expect(status.hasLanguageServer('go')).toBe(true);
    expect(status.lspStateForKey('go:/w')).toBe('loading');
    for (const cb of h.pushes) {
      cb({
        type: 'lsp:status',
        status: { serverKey: 'go:/w', languageId: 'go', root: '/w', state: 'ready', pid: 7 },
      });
    }
    expect(status.lspStateForKey('go:/w')).toBe('ready');
    dispose();
    expect(h.pushes.size).toBe(0);
    expect(h.created.size).toBe(0);
  });
});
