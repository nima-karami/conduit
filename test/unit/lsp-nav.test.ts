/**
 * The language-server branch of `runNavCommand` (spec docs/specs/2026-09-22-language-server-go.md
 * §2.1, §3.3). The real ts-nav, nav-outcome, monaco-message, toast-store and project-index run;
 * only the host channel (lsp-sync / lsp-status / bridge) and monaco's internals are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspLanguageInfo, LspReply } from '../../src/lsp-protocol';
import { fileUri, setDefinitionOpener } from '../../webview/project-index';
import { __resetToastsForTest, getToastsSnapshot } from '../../webview/toast-store';
import { runNavCommand } from '../../webview/ts-nav';

const h = vi.hoisted(() => ({
  lspRequest: vi.fn(),
  flushPending: vi.fn(async () => {}),
  openDocs: new Set<string>(),
  states: new Map<string, string>(),
  langs: new Map<string, unknown>(),
  lspInvoke: vi.fn(async () => ({ ok: true })),
  executeCommandWithArgs: vi.fn(async () => {}),
  getTypeScriptWorker: vi.fn(),
  models: new Map<string, unknown>(),
  created: [] as { uri: string; text: string; disposed: boolean }[],
  order: [] as string[],
}));

vi.mock('monaco-editor', async () => {
  const { URI } = await import('monaco-editor/esm/vs/base/common/uri.js');
  return {
    Uri: URI,
    Range: {
      lift: (r: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      }) => ({
        containsPosition: (p: { lineNumber: number; column: number }) =>
          (p.lineNumber > r.startLineNumber ||
            (p.lineNumber === r.startLineNumber && p.column >= r.startColumn)) &&
          (p.lineNumber < r.endLineNumber ||
            (p.lineNumber === r.endLineNumber && p.column <= r.endColumn)),
      }),
    },
    editor: {
      getModel: (uri: { toString(): string }) => h.models.get(uri.toString()) ?? null,
      createModel: (text: string, _lang: string, uri: { toString(): string }) => {
        const rec = { uri: uri.toString(), text, disposed: false };
        h.created.push(rec);
        const model = {
          uri,
          isDisposed: () => rec.disposed,
          dispose: () => {
            rec.disposed = true;
            h.models.delete(uri.toString());
          },
        };
        h.models.set(uri.toString(), model);
        return model;
      },
    },
    languages: {},
    typescript: {
      getTypeScriptWorker: () => h.getTypeScriptWorker(),
      getJavaScriptWorker: () => h.getTypeScriptWorker(),
      typescriptDefaults: { getExtraLibs: () => ({}) },
    },
  };
});
vi.mock('../../webview/monaco-languages', () => ({ ensureTokenizer: () => {} }));
vi.mock('../../webview/monaco-commands', () => ({
  executeCommandWithArgs: h.executeCommandWithArgs,
}));
vi.mock('../../webview/bridge', () => ({ lspInvoke: h.lspInvoke, subscribe: () => () => {} }));
vi.mock('../../webview/lsp-sync', () => ({
  lspRequest: (...a: unknown[]) => {
    h.order.push('request');
    return h.lspRequest(...a);
  },
  flushPending: (...a: unknown[]) => {
    h.order.push('flush');
    return h.flushPending(...(a as []));
  },
  serverKeyForDoc: () => 'go:/w',
  isLspDocOpen: (p: string) => h.openDocs.has(p),
}));
vi.mock('../../webview/lsp-status', () => ({
  lspStateForKey: (k: string | null) => (k ? (h.states.get(k) ?? null) : null),
  lspLanguage: (id: string) => h.langs.get(id) ?? null,
  hasLanguageServer: (id: string) => h.langs.has(id),
}));

const GO: LspLanguageInfo = {
  languageId: 'go',
  displayName: 'Go',
  binary: 'gopls',
  installHint: 'go install golang.org/x/tools/gopls@latest',
  moduleMarker: 'go.mod',
};

type Pos = { lineNumber: number; column: number };

/** An editor with real listener plumbing for the four events a navigation guard watches. */
function fakeEditor(
  path = '/w/main.go',
  languageId = 'go',
  pos: Pos = { lineNumber: 6, column: 3 },
) {
  const listeners = {
    cursor: new Set<(e: { position: Pos }) => void>(),
    model: new Set<() => void>(),
    content: new Set<() => void>(),
    dispose: new Set<() => void>(),
  };
  const on =
    <T>(set: Set<T>) =>
    (cb: T) => {
      set.add(cb);
      return { dispose: () => set.delete(cb) };
    };
  const inline: string[] = [];
  let closed = 0;
  let position = pos;
  const model = {
    uri: fileUri(path),
    getLanguageId: () => languageId,
    getWordAtPosition: () => ({ word: 'helper', startColumn: 2, endColumn: 8 }),
    getVersionId: () => 1,
    getOffsetAt: () => 0,
    isDisposed: () => false,
  };
  h.models.set(model.uri.toString(), model);
  const editor = {
    focus: () => {},
    getModel: () => model,
    getPosition: () => ({ ...position }),
    getContribution: () => ({
      showMessage: (m: string) => inline.push(m),
      closeMessage: () => {
        closed++;
      },
    }),
    setPosition: (p: Pos) => {
      position = p;
    },
    revealRangeInCenter: () => {},
    onDidChangeCursorPosition: on(listeners.cursor),
    onDidChangeModel: on(listeners.model),
    onDidChangeModelContent: on(listeners.content),
    onDidDispose: on(listeners.dispose),
  };
  return {
    editor: editor as never,
    inline,
    closed: () => closed,
    moveCursor(p: Pos) {
      position = p;
      for (const l of listeners.cursor) l({ position: p });
    },
    listenerCount: () => listeners.cursor.size + listeners.model.size + listeners.content.size,
  };
}

const R = (line: number, c0: number, c1: number) => ({
  start: { line, character: c0 },
  end: { line, character: c1 },
});
const locations = (
  locs: { path: string; line: number }[],
  targets: string[] = locs.map((l) => l.path),
): LspReply => ({
  kind: 'locations',
  locations: locs.map((l) => ({ path: l.path, range: R(l.line, 5, 11) })),
  targets: [...new Set(targets)].map((path) => ({ path, text: `package main // ${path}` })),
  dropped: 0,
});

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let opened: string[];
beforeEach(() => {
  __resetToastsForTest();
  h.lspRequest.mockReset();
  h.lspInvoke.mockClear();
  h.executeCommandWithArgs.mockClear();
  h.getTypeScriptWorker.mockReset();
  h.openDocs.clear();
  h.states.clear();
  h.langs.clear();
  h.langs.set('go', GO);
  h.models.clear();
  h.created.length = 0;
  h.order.length = 0;
  opened = [];
  setDefinitionOpener((p) => opened.push(p));
});

const toasts = () => getToastsSnapshot().map((t) => t.message);
const cancels = () =>
  (h.lspInvoke.mock.calls as unknown as [{ type: string; requestId: string }][])
    .map(([m]) => m)
    .filter((m) => m.type === 'lsp:cancel');

describe('LSP navigation (E2)', () => {
  it('F12 on a server-language model flushes, asks definition, and one other-file result opens via the definition opener', async () => {
    h.lspRequest.mockResolvedValue(locations([{ path: '/w/helper.go', line: 2 }]));
    const e = fakeEditor();
    const outcome = await runNavCommand(e.editor, 'editor.action.revealDefinition');
    expect(outcome).toEqual({ kind: 'navigated' });
    expect(h.order).toEqual(['flush', 'request']);
    const [path, op, pos] = h.lspRequest.mock.calls[0] ?? [];
    expect([path, op, pos]).toEqual(['/w/main.go', 'definition', { line: 5, character: 2 }]);
    expect(opened).toEqual(['/w/helper.go']);
    expect(toasts()).toEqual([]);
  });

  it('many results peek via peekLocations with models from targets', async () => {
    h.lspRequest.mockResolvedValue(
      locations([
        { path: '/w/a.go', line: 1 },
        { path: '/w/b.go', line: 4 },
      ]),
    );
    const outcome = await runNavCommand(fakeEditor().editor, 'editor.action.goToImplementation');
    expect(outcome).toEqual({ kind: 'peeked' });
    expect(h.created.map((m) => m.uri)).toEqual([
      fileUri('/w/a.go').toString(),
      fileUri('/w/b.go').toString(),
    ]);
    const call = h.executeCommandWithArgs.mock.calls[0] as unknown[];
    expect(call[0]).toBe('editor.action.peekLocations');
    expect((call[3] as { range: unknown }[]).map((l) => l.range)).toEqual([
      { startLineNumber: 2, startColumn: 6, endLineNumber: 2, endColumn: 12 },
      { startLineNumber: 5, startColumn: 6, endLineNumber: 5, endColumn: 12 },
    ]);
    expect(h.lspRequest.mock.calls[0]?.[1]).toBe('implementation');
  });

  it('a result we hold no content for is dropped', async () => {
    h.lspRequest.mockResolvedValue(locations([{ path: '/goroot/x.go', line: 1 }], []));
    const outcome = await runNavCommand(fakeEditor().editor, 'editor.action.revealDefinition');
    expect(outcome).toEqual({ kind: 'none' });
    expect(opened).toEqual([]);
  });

  it('definition at the cursor falls through to references', async () => {
    h.lspRequest
      .mockResolvedValueOnce(locations([{ path: '/w/main.go', line: 5 }], []))
      .mockResolvedValueOnce(
        locations([
          { path: '/w/main.go', line: 5 },
          { path: '/w/helper.go', line: 2 },
        ]),
      );
    const e = fakeEditor('/w/main.go', 'go', { lineNumber: 6, column: 8 });
    const outcome = await runNavCommand(e.editor, 'editor.action.revealDefinition');
    expect(h.lspRequest.mock.calls.map((c) => c[1])).toEqual(['definition', 'references']);
    expect(outcome).toEqual({ kind: 'peeked' });
  });

  it('Alt+F12 asks definition and peeks', async () => {
    h.lspRequest.mockResolvedValue(locations([{ path: '/w/helper.go', line: 2 }]));
    const outcome = await runNavCommand(fakeEditor().editor, 'editor.action.peekDefinition');
    expect(h.lspRequest.mock.calls[0]?.[1]).toBe('definition');
    expect(outcome).toEqual({ kind: 'peeked' });
    expect(opened).toEqual([]);
  });
});

describe('LSP navigation — cancellation (E12, #9)', () => {
  it('a cursor move to a different position before the reply → no open, no message, lsp:cancel sent', async () => {
    const d = deferred<LspReply>();
    h.lspRequest.mockReturnValue(d.promise);
    const e = fakeEditor();
    const nav = runNavCommand(e.editor, 'editor.action.revealDefinition');
    await vi.waitFor(() => expect(h.lspRequest).toHaveBeenCalled());
    e.moveCursor({ lineNumber: 9, column: 1 });
    d.resolve(locations([{ path: '/w/helper.go', line: 2 }]));
    expect(await nav).toEqual({ kind: 'cancelled' });
    expect(opened).toEqual([]);
    expect(toasts()).toEqual([]);
    expect(e.inline).toEqual([]);
    expect(h.created).toEqual([]);
    expect(cancels()).toEqual([{ type: 'lsp:cancel', requestId: h.lspRequest.mock.calls[0]?.[3] }]);
  });

  it("a cursor event AT the nav origin (Ctrl+click's own setPosition) does not cancel", async () => {
    const d = deferred<LspReply>();
    h.lspRequest.mockReturnValue(d.promise);
    const e = fakeEditor();
    const nav = runNavCommand(e.editor, 'editor.action.revealDefinition', { gesture: 'pointer' });
    await vi.waitFor(() => expect(h.lspRequest).toHaveBeenCalled());
    e.moveCursor({ lineNumber: 6, column: 3 });
    d.resolve(locations([{ path: '/w/helper.go', line: 2 }]));
    expect(await nav).toEqual({ kind: 'navigated' });
    expect(opened).toEqual(['/w/helper.go']);
    expect(cancels()).toEqual([]);
  });

  it('a second nav cancels the first', async () => {
    const first = deferred<LspReply>();
    h.lspRequest
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(locations([{ path: '/w/b.go', line: 1 }]));
    const e = fakeEditor();
    const one = runNavCommand(e.editor, 'editor.action.revealDefinition');
    await vi.waitFor(() => expect(h.lspRequest).toHaveBeenCalledTimes(1));
    const two = runNavCommand(e.editor, 'editor.action.revealDefinition');
    first.resolve(locations([{ path: '/w/a.go', line: 1 }]));
    expect(await one).toEqual({ kind: 'cancelled' });
    expect(await two).toEqual({ kind: 'navigated' });
    expect(opened).toEqual(['/w/b.go']);
    expect(cancels()).toHaveLength(1);
    expect(e.listenerCount()).toBe(0);
  });

  it('stale reply → cancelled, silent', async () => {
    h.lspRequest.mockResolvedValue({ kind: 'stale' });
    expect(await runNavCommand(fakeEditor().editor, 'editor.action.revealDefinition')).toEqual({
      kind: 'cancelled',
    });
    expect(toasts()).toEqual([]);
  });
});

describe('LSP navigation — messages', () => {
  it('loading state shows "Go: loading workspace…" first', async () => {
    h.states.set('go:/w', 'loading');
    const d = deferred<LspReply>();
    h.lspRequest.mockReturnValue(d.promise);
    const e = fakeEditor();
    const nav = runNavCommand(e.editor, 'editor.action.revealDefinition');
    await vi.waitFor(() => expect(h.lspRequest).toHaveBeenCalled());
    expect(e.inline).toEqual(['Go: loading workspace…']);
    d.resolve(locations([{ path: '/w/helper.go', line: 2 }]));
    expect(await nav).toEqual({ kind: 'navigated' });
    expect(e.closed()).toBeGreaterThan(0);
  });

  it('missing → install toast; pointer gesture → silent', async () => {
    h.lspRequest.mockResolvedValue({ kind: 'unavailable', reason: 'missing' });
    await runNavCommand(fakeEditor().editor, 'editor.action.revealDefinition', {
      gesture: 'pointer',
    });
    expect(toasts()).toEqual([]);
    await runNavCommand(fakeEditor().editor, 'editor.action.revealDefinition');
    expect(toasts()).toEqual([
      'Go navigation needs gopls — install with `go install golang.org/x/tools/gopls@latest`',
    ]);
  });

  it('timeout → timed-out message', async () => {
    h.lspRequest.mockResolvedValue({ kind: 'unavailable', reason: 'timeout' });
    expect(await runNavCommand(fakeEditor().editor, 'editor.action.goToReferences')).toEqual({
      kind: 'timed-out',
    });
    expect(toasts()).toEqual(['Couldn’t resolve in time. Try again.']);
  });

  it('an empty result under an ad-hoc root names the missing module marker', async () => {
    h.lspRequest.mockResolvedValue({ kind: 'empty', adHocRoot: true });
    const e = fakeEditor();
    await runNavCommand(e.editor, 'editor.action.revealDefinition');
    expect(e.inline).toEqual(["No definition for 'helper' here (no go.mod found for this file)"]);
  });
});

describe('LSP navigation — isolation', () => {
  it('the branch is chosen by lspLanguage, not by id', async () => {
    h.langs.set('rust', { ...GO, languageId: 'rust', displayName: 'Rust' });
    h.lspRequest.mockResolvedValue(locations([{ path: '/w/lib.rs', line: 3 }]));
    const outcome = await runNavCommand(
      fakeEditor('/w/main.rs', 'rust').editor,
      'editor.action.revealDefinition',
    );
    expect(outcome).toEqual({ kind: 'navigated' });
    expect(opened).toEqual(['/w/lib.rs']);
  });

  it('an LSP nav never calls the TS worker', async () => {
    h.lspRequest.mockResolvedValue({ kind: 'empty', adHocRoot: false });
    await runNavCommand(fakeEditor().editor, 'editor.action.goToTypeDefinition');
    expect(h.getTypeScriptWorker).not.toHaveBeenCalled();
    expect(h.lspRequest.mock.calls[0]?.[1]).toBe('typeDefinition');
  });

  it('a TS nav is unchanged', async () => {
    h.getTypeScriptWorker.mockRejectedValue('TypeScript not registered!');
    const outcome = await runNavCommand(
      fakeEditor('/w/a.ts', 'typescript').editor,
      'editor.action.revealDefinition',
    );
    expect(outcome).toEqual({ kind: 'timed-out' });
    expect(h.lspRequest).not.toHaveBeenCalled();
    expect(h.getTypeScriptWorker).toHaveBeenCalled();
  });

  it('a language with no server is still unsupported', async () => {
    const outcome = await runNavCommand(
      fakeEditor('/w/x.py', 'python').editor,
      'editor.action.revealDefinition',
    );
    expect(outcome).toEqual({ kind: 'unsupported', languageId: 'python' });
    expect(h.lspRequest).not.toHaveBeenCalled();
  });
});

describe('LSP navigation — cleanup', () => {
  it("previous nav's target models are disposed unless an open doc", async () => {
    h.lspRequest.mockResolvedValueOnce(
      locations([
        { path: '/w/a.go', line: 1 },
        { path: '/w/b.go', line: 1 },
      ]),
    );
    const e = fakeEditor();
    await runNavCommand(e.editor, 'editor.action.goToReferences');
    expect(h.created.map((m) => m.disposed)).toEqual([false, false]);
    h.openDocs.add('/w/b.go');
    h.lspRequest.mockResolvedValueOnce({ kind: 'empty', adHocRoot: false });
    await runNavCommand(e.editor, 'editor.action.goToReferences');
    expect(h.created.map((m) => m.disposed)).toEqual([true, false]);
  });
});
