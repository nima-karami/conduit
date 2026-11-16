// @vitest-environment jsdom

import type { Uri } from 'monaco-editor';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileContentDTO, HostToWebview, WebviewToHost } from '../../src/protocol';

/**
 * A fake Monaco, recording what CodeViewer creates. Models and editors are the only state the
 * assertions read: which models exist, what each is keyed by, and whether it is still alive.
 */
const m = vi.hoisted(() => {
  // Also the shape of a decorations collection, which the marker hooks clear and set.
  const disposable = () => ({
    dispose() {},
    clear() {},
    set() {},
    getRanges: () => [],
  });
  const enumLike = () =>
    new Proxy({} as Record<string, number>, {
      get: (_t, k) => (typeof k === 'string' ? 0 : undefined),
    });
  class FakeModel {
    disposed = false;
    version = 1;
    private changeListeners = new Set<() => void>();
    private willDispose = new Set<() => void>();
    constructor(
      public readonly uri: Uri,
      private value: string,
      public language: string,
    ) {}
    getValue() {
      return this.value;
    }
    setValue(v: string) {
      this.value = v;
      this.version += 1;
      for (const l of [...this.changeListeners]) l();
    }
    getVersionId() {
      return this.version;
    }
    getLanguageId() {
      return this.language;
    }
    getLineCount() {
      return this.value.split('\n').length;
    }
    getLineMaxColumn() {
      return 1;
    }
    getOffsetAt() {
      return 0;
    }
    getValueInRange() {
      return '';
    }
    isDisposed() {
      return this.disposed;
    }
    onDidChangeContent(cb: () => void) {
      this.changeListeners.add(cb);
      return { dispose: () => this.changeListeners.delete(cb) };
    }
    onWillDispose(cb: () => void) {
      this.willDispose.add(cb);
      return { dispose: () => this.willDispose.delete(cb) };
    }
    dispose() {
      if (this.disposed) return;
      for (const cb of [...this.willDispose]) cb();
      this.disposed = true;
      if (models.get(this.uri.toString()) === this) models.delete(this.uri.toString());
    }
  }
  class FakeEditor {
    disposed = false;
    actions: { id: string; run: () => unknown }[] = [];
    private blurListeners = new Set<() => void>();
    private disposeListeners = new Set<() => void>();
    constructor(
      private model: FakeModel,
      public readonly options: Record<string, unknown>,
    ) {}
    getModel() {
      return this.disposed ? null : this.model;
    }
    getPosition() {
      return null;
    }
    getSelection() {
      return null;
    }
    getScrollTop() {
      return 0;
    }
    getScrollHeight() {
      return 0;
    }
    getOption() {
      return 0;
    }
    getLayoutInfo() {
      return { height: 0 };
    }
    saveViewState() {
      return null;
    }
    onDidDispose(cb: () => void) {
      this.disposeListeners.add(cb);
      return { dispose: () => this.disposeListeners.delete(cb) };
    }
    onDidBlurEditorWidget(cb: () => void) {
      this.blurListeners.add(cb);
      return { dispose: () => this.blurListeners.delete(cb) };
    }
    /** Lets a test play the user leaving the editor. */
    fireBlur() {
      for (const cb of [...this.blurListeners]) cb();
    }
    addAction(action: { id: string; run: () => unknown }) {
      this.actions.push(action);
      return { dispose: () => {} };
    }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      for (const cb of [...this.disposeListeners]) cb();
    }
  }
  const models = new Map<string, FakeModel>();
  const editors: FakeEditor[] = [];
  /** Any Monaco method this test does not model is a no-op with a disposable result. */
  const lenient = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, k, r) {
        if (k in t) return Reflect.get(t, k, r);
        return () => disposable();
      },
    });
  const editorApi = {
    create: (_el: unknown, opts: { model: FakeModel } & Record<string, unknown>) => {
      const ed = lenient(new FakeEditor(opts.model, opts));
      editors.push(ed);
      return ed;
    },
    getModel: (uri: Uri) => models.get(uri.toString()) ?? null,
    createModel: (value: string, language: string, uri: Uri) => {
      const model = new FakeModel(uri, value, language);
      models.set(uri.toString(), model);
      return model;
    },
    setModelLanguage: (model: FakeModel, language: string) => {
      model.language = language;
    },
    getEditors: () => editors.filter((e) => !e.disposed),
    setTheme: () => {},
    defineTheme: () => {},
    EndOfLinePreference: enumLike(),
    EditorOption: enumLike(),
    CursorChangeReason: enumLike(),
    ContentWidgetPositionPreference: enumLike(),
    MouseTargetType: enumLike(),
    OverviewRulerLane: enumLike(),
    MinimapPosition: enumLike(),
  };
  const monacoFake = {
    editor: editorApi,
    KeyCode: enumLike(),
    KeyMod: enumLike(),
    languages: lenient({}),
  };
  const fileSaves = {
    attach: vi.fn(),
    save: vi.fn(),
    trigger: vi.fn(),
    reload: vi.fn(),
  };
  const bus = { posted: [] as WebviewToHost[], listeners: new Set<(msg: HostToWebview) => void>() };
  const settings = {
    wordWrap: false,
    editorMinimap: false,
    editorFontSize: 13,
    editorChangeMarkers: false,
    reviewIgnoreWhitespace: false,
    shortcuts: {} as Record<string, string>,
    theme: 'dark',
    surfaceColor: '',
    codeOpacity: 1,
    htmlDefaultView: 'preview',
  };
  return { models, editors, monacoFake, fileSaves, bus, settings };
});

vi.mock('monaco-editor', async () => {
  const { URI } = await import('monaco-editor/esm/vs/base/common/uri.js');
  return { ...m.monacoFake, Uri: URI };
});

vi.mock('../../webview/bridge', () => ({
  post: (msg: WebviewToHost) => m.bus.posted.push(msg),
  subscribe: (cb: (msg: HostToWebview) => void) => {
    m.bus.listeners.add(cb);
    return () => m.bus.listeners.delete(cb);
  },
}));

// The local save store is Monaco-, bridge- and index-bound. The tests only need to see whether a
// remote editor reaches it.
vi.mock('../../webview/file-saves', () => ({
  fileSaves: m.fileSaves,
  useFileSaveStatus: () => undefined,
  closeDocForPath: () => {},
}));
vi.mock('../../webview/settings', () => ({
  useSettings: () => ({ settings: m.settings, update: () => {} }),
}));
vi.mock('../../webview/monaco-theme', () => ({ ensureTheme: () => 'conduit' }));
vi.mock('../../webview/monaco-languages', () => ({ ensureTokenizer: () => {} }));
// Spied, not replaced: the real registration runs, and a test asks whether it was made at all.
vi.mock('../../webview/nav-editors', async (orig) => {
  const actual = await orig<typeof import('../../webview/nav-editors')>();
  return { ...actual, registerNavEditor: vi.fn(actual.registerNavEditor) };
});
vi.mock('../../webview/monaco-warmup', () => ({
  gotoInflight: { active: () => false, subscribe: () => () => {} },
}));

import { CodeViewer } from '../../webview/components/code-viewer';
import { closeRemoteBuffer } from '../../webview/remote-file-saves';
import { seedLspState } from '../../webview/lsp-status';
import { registerNavEditor } from '../../webview/nav-editors';
import { fileUri } from '../../webview/project-index';

const PATH = '/home/me/proj/src/a.ts';
const KEY = 'remote-file@M1:/home/me/proj/src/a.ts';
const REMOTE = {
  kind: 'remote' as const,
  key: KEY,
  machineId: 'M1',
  machineName: 'build-box',
  sessionId: 's1',
};
const HASH = 'ab'.repeat(32);

const fileDoc = (content: string, overrides: Partial<FileContentDTO> = {}): FileContentDTO => ({
  path: PATH,
  content,
  language: 'typescript',
  truncated: false,
  binary: false,
  ...overrides,
});

const remoteDoc = (content: string): FileContentDTO =>
  fileDoc(content, { readOnlyReason: 'remote' });
/** A file from a B that can save: it carries the hash of what B read. */
const writableRemoteDoc = (content: string): FileContentDTO => fileDoc(content, { hash: HASH });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame ??= (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});

const mounted: { root: Root; host: HTMLDivElement }[] = [];

async function mount(node: ReturnType<typeof createElement>): Promise<Root> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(node);
  });
  return root;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  const i = mounted.findIndex((x) => x.root === root);
  if (i >= 0) {
    mounted[i]?.host.remove();
    mounted.splice(i, 1);
  }
}

beforeEach(() => {
  m.models.clear();
  m.editors.length = 0;
  m.bus.posted.length = 0;
  // Every spy: a previous test's unmount still runs its local cleanup, which fires `trigger`.
  for (const spy of Object.values(m.fileSaves)) spy.mockClear();
  vi.mocked(registerNavEditor).mockClear();
});

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  // The remote store holds a buffer until its tab closes; each test starts with none.
  closeRemoteBuffer(KEY);
});

describe('CodeViewer with a remote source', () => {
  it('a remote source never shares the local model of the same path', async () => {
    await mount(createElement(CodeViewer, { doc: fileDoc('local text') }));
    await mount(
      createElement(CodeViewer, {
        doc: remoteDoc('remote text'),
        viewStateId: 'remote-file@M1:/home/me/proj/src/a.ts',
        source: REMOTE,
      }),
    );

    const local = m.models.get(fileUri(PATH).toString());
    const remoteEntries = [...m.models.values()].filter((x) => x.uri.scheme === 'conduit-remote');
    expect(m.models.size).toBe(2);
    expect(local?.getValue()).toBe('local text');
    expect(remoteEntries).toHaveLength(1);
    expect(remoteEntries[0]?.uri.authority).toBe('M1');
    expect(remoteEntries[0]?.getValue()).toBe('remote text');
    // A TypeScript file's remote text never reaches Monaco's TS worker, the project index or a
    // language server, so it is plain text.
    expect(remoteEntries[0]?.getLanguageId()).toBe('plaintext');
    const remoteEditor = m.editors.find((e) => e.getModel() === remoteEntries[0]);
    expect(remoteEditor?.options.readOnly).toBe(true);
  });

  it('a remote source never attaches the dirty store', async () => {
    await mount(
      createElement(CodeViewer, {
        doc: remoteDoc('remote text'),
        viewStateId: 'remote-file@M1:/home/me/proj/src/a.ts',
        source: REMOTE,
      }),
    );
    expect(m.fileSaves.attach).not.toHaveBeenCalled();
    expect(m.fileSaves.trigger).not.toHaveBeenCalled();

    // The same mount without a source does attach, so the check above is not vacuous.
    await mount(createElement(CodeViewer, { doc: fileDoc('local text') }));
    expect(m.fileSaves.attach).toHaveBeenCalledWith(PATH, expect.anything());
  });

  it('a remote model outlives its editor and goes when its tab closes', async () => {
    const remoteRoot = await mount(
      createElement(CodeViewer, {
        doc: remoteDoc('remote text'),
        viewStateId: 'remote-file@M1:/home/me/proj/src/a.ts',
        source: REMOTE,
      }),
    );
    const remoteModel = [...m.models.values()].find((x) => x.uri.scheme === 'conduit-remote');
    expect(remoteModel).toBeDefined();

    const localRoot = await mount(createElement(CodeViewer, { doc: fileDoc('local text') }));
    const localModel = m.models.get(fileUri(PATH).toString());

    await unmount(remoteRoot);
    await unmount(localRoot);
    // A tab switch unmounts the editor; an unsaved remote edit must survive it (plan CON-44 d8).
    expect(remoteModel?.isDisposed()).toBe(false);
    expect(localModel?.isDisposed()).toBe(false);
    closeRemoteBuffer(KEY);
    expect(remoteModel?.isDisposed()).toBe(true);
  });

  it('a remote file B can save is editable, and Save sends B the hash it read', async () => {
    await mount(
      createElement(CodeViewer, {
        doc: writableRemoteDoc('remote text'),
        viewStateId: KEY,
        source: REMOTE,
      }),
    );
    const editor = m.editors.at(-1);
    expect(editor?.options.readOnly).toBe(false);
    await act(async () => {
      editor?.getModel()?.setValue('edited');
      editor?.actions.find((a) => a.id === 'agentdeck.saveFile')?.run();
    });
    expect(m.bus.posted).toContainEqual(
      expect.objectContaining({
        type: 'remoteFs:write',
        machineId: 'M1',
        sessionId: 's1',
        path: PATH,
        data: 'edited',
        expect: HASH,
      }),
    );
    // Never the local store: the path is another machine's.
    expect(m.fileSaves.save).not.toHaveBeenCalled();
  });

  it('a remote editor never saves or triggers a save of the local file of its path', async () => {
    const remoteRoot = await mount(
      createElement(CodeViewer, {
        doc: remoteDoc('remote text'),
        viewStateId: 'remote-file@M1:/home/me/proj/src/a.ts',
        source: REMOTE,
      }),
    );
    const remoteEditor = m.editors.at(-1);
    expect(remoteEditor).toBeDefined();
    // The Save action runs whatever the editor holds; the remote editor has nothing to save.
    remoteEditor?.actions.find((a) => a.id === 'agentdeck.saveFile')?.run();
    remoteEditor?.fireBlur();
    expect(m.fileSaves.save).not.toHaveBeenCalled();
    expect(m.fileSaves.trigger).not.toHaveBeenCalled();

    await unmount(remoteRoot);
    expect(m.fileSaves.trigger).not.toHaveBeenCalled();
    expect(registerNavEditor).not.toHaveBeenCalled();

    // The same actions on a local editor do reach the local store, so the checks above can fail.
    await mount(createElement(CodeViewer, { doc: fileDoc('local text') }));
    const localEditor = m.editors.at(-1);
    localEditor?.actions.find((a) => a.id === 'agentdeck.saveFile')?.run();
    localEditor?.fireBlur();
    expect(m.fileSaves.save).toHaveBeenCalledWith(PATH, 'manual');
    expect(m.fileSaves.trigger).toHaveBeenCalledWith(PATH, 'editorBlur');
    expect(registerNavEditor).toHaveBeenCalledWith(PATH, expect.anything(), expect.anything());
  });

  it('a remote python file keeps its language, a remote TypeScript file is plain text', async () => {
    // Python is served by a language server here, so it is a language this project analyses: the
    // test holds that it still keeps its own language, which only TypeScript gives up.
    seedLspState({
      servers: [],
      languages: [
        {
          languageId: 'python',
          languageIds: ['python'],
          displayName: 'Python',
          binary: 'pyright',
          installHint: '',
          moduleMarker: '',
        },
      ],
    });
    await mount(
      createElement(CodeViewer, {
        doc: { ...remoteDoc('print(1)'), language: 'python' },
        viewStateId: 'remote-file@M1:/home/me/proj/src/a.py',
        source: REMOTE,
      }),
    );
    const remoteModels = [...m.models.values()].filter((x) => x.uri.scheme === 'conduit-remote');
    expect(remoteModels.map((x) => x.getLanguageId())).toEqual(['python']);
  });
});
