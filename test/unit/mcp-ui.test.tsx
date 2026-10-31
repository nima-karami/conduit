// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CloseFilesOutcome,
  MAX_CLOSE_RESULTS,
  MAX_UNSAVED_PATHS,
  type McpUiAction,
} from '../../src/conduit-mcp/ui-types';
import type { CommitNode, HostToWebview, WebviewToHost } from '../../src/protocol';
import type { OpenDoc } from '../../webview/docs';
import {
  type CloseFilesOps,
  type McpUiHandlers,
  planCloseFiles,
  runCloseFiles,
  useMcpUi,
} from '../../webview/mcp-ui';

const bridge = vi.hoisted(() => ({
  listeners: [] as ((m: HostToWebview) => void)[],
  log: [] as string[],
  posted: [] as WebviewToHost[],
}));
vi.mock('../../webview/bridge', () => ({
  isHosted: false,
  logToHost: () => {},
  subscribe: (cb: (m: HostToWebview) => void) => {
    bridge.listeners.push(cb);
    return () => {
      bridge.listeners = bridge.listeners.filter((l) => l !== cb);
    };
  },
  post: (m: WebviewToHost) => {
    bridge.posted.push(m);
    bridge.log.push(`post:${m.type}`);
  },
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  bridge.listeners = [];
  bridge.log = [];
  bridge.posted = [];
});

const outcome: CloseFilesOutcome = { closed: ['/w/a.ts'], skipped: [] };

function fakeHandlers(over: Partial<McpUiHandlers> = {}): McpUiHandlers {
  return {
    hasSession: (id) => id === 'A' || id === 'B',
    dirtyPathsOf: () => [],
    kill: vi.fn((id: string) => bridge.log.push(`kill:${id}`)),
    closeFiles: vi.fn(async () => outcome),
    openReview: vi.fn(),
    openGitHistory: vi.fn(),
    openUrl: vi.fn(),
    ...over,
  };
}

function Probe({ h }: { h: McpUiHandlers }) {
  useMcpUi(h);
  return null;
}

function mount(h: McpUiHandlers) {
  const el = document.createElement('div');
  root = createRoot(el);
  act(() => root?.render(<Probe h={h} />));
}

function send(action: McpUiAction, sessionId = 'A', requestId = 'r1') {
  for (const l of [...bridge.listeners]) l({ type: 'mcp:ui', requestId, sessionId, action });
}

const results = () =>
  bridge.posted.flatMap((m) => (m.type === 'mcp:uiResult' ? [[m.requestId, m.result]] : []));

describe('useMcpUi', () => {
  it('closeSession clean posts the result before kill', () => {
    const h = fakeHandlers();
    mount(h);
    send({ kind: 'closeSession', target: 'B' });
    expect(bridge.log).toEqual(['post:mcp:uiResult', 'kill:B']);
    expect(results()).toStrictEqual([['r1', { kind: 'closeSession', ok: true }]]);
  });

  it('closeSession dirty posts unsaved (≤ 20) and never kills', () => {
    const dirty = Array.from({ length: 25 }, (_, i) => `/w/f${i}.ts`);
    const h = fakeHandlers({ dirtyPathsOf: (id) => (id === 'B' ? dirty : []) });
    mount(h);
    send({ kind: 'closeSession', target: 'B' });
    expect(h.kill).not.toHaveBeenCalled();
    expect(results()).toStrictEqual([
      ['r1', { kind: 'closeSession', ok: false, unsaved: dirty.slice(0, MAX_UNSAVED_PATHS) }],
    ]);
  });

  it('unknown session → unknownSession, no handler called', () => {
    const h = fakeHandlers();
    mount(h);
    send({ kind: 'closeSession', target: 'Z' }, 'A', 'r1');
    send({ kind: 'openUrl', url: 'https://x.test/', focus: true }, 'Z', 'r2');
    expect(results()).toStrictEqual([
      ['r1', { kind: 'unknownSession' }],
      ['r2', { kind: 'unknownSession' }],
    ]);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  it('closeSession checks the target, not the caller', () => {
    const h = fakeHandlers();
    mount(h);
    send({ kind: 'closeSession', target: 'B' }, 'gone');
    expect(results()).toStrictEqual([['r1', { kind: 'closeSession', ok: true }]]);
  });

  it('closeFiles posts the awaited outcome', async () => {
    const h = fakeHandlers();
    mount(h);
    send({ kind: 'closeFiles', paths: ['/w/a.ts'] }, 'B');
    expect(results()).toEqual([]);
    await act(async () => {});
    expect(h.closeFiles).toHaveBeenCalledWith('B', ['/w/a.ts']);
    expect(results()).toStrictEqual([
      ['r1', { kind: 'closeFiles', closed: ['/w/a.ts'], skipped: [] }],
    ]);
  });

  it('open kinds call their handler and post opened', () => {
    const h = fakeHandlers();
    mount(h);
    const source = { kind: 'working', scope: 'all', repoRoot: '/w' } as const;
    const commit: CommitNode = {
      sha: 'abc',
      parents: [],
      author: 'a',
      email: 'a@x',
      date: 0,
      subject: 's',
      refs: [],
    };
    send({ kind: 'openReview', source }, 'A', 'r1');
    send({ kind: 'openGitHistory', repoRoot: '/w', commit }, 'A', 'r2');
    send({ kind: 'openUrl', url: 'https://x.test/', focus: false }, 'B', 'r3');
    expect(h.openReview).toHaveBeenCalledWith('A', source);
    expect(h.openGitHistory).toHaveBeenCalledWith('A', '/w', commit);
    expect(h.openUrl).toHaveBeenCalledWith('B', 'https://x.test/', false);
    expect(results()).toStrictEqual([
      ['r1', { kind: 'opened' }],
      ['r2', { kind: 'opened' }],
      ['r3', { kind: 'opened' }],
    ]);
  });

  it('uses the latest handlers without resubscribing', () => {
    const first = fakeHandlers();
    mount(first);
    const next = fakeHandlers();
    act(() => root?.render(<Probe h={next} />));
    expect(bridge.listeners).toHaveLength(1);
    send({ kind: 'openUrl', url: 'https://x.test/', focus: true });
    expect(first.openUrl).not.toHaveBeenCalled();
    expect(next.openUrl).toHaveBeenCalledOnce();
  });

  it('a throwing handler still answers: failed, naming the step and the error', async () => {
    const h = fakeHandlers({
      openUrl: vi.fn(() => {
        throw new Error('no web tab');
      }),
      hasSession: () => {
        throw new Error('registry gone');
      },
    });
    mount(h);
    send({ kind: 'openReview', source: { kind: 'working', scope: 'all', repoRoot: '/w' } });
    h.hasSession = () => true;
    send({ kind: 'openUrl', url: 'https://x.test/', focus: true }, 'A', 'r2');
    await act(async () => {});
    expect(results()).toStrictEqual([
      ['r1', { kind: 'failed', message: 'openReview failed: registry gone' }],
      ['r2', { kind: 'failed', message: 'openUrl failed: no web tab' }],
    ]);
  });

  it('a rejecting closeFiles answers failed with its message', async () => {
    const h = fakeHandlers({
      closeFiles: vi.fn(async () => {
        throw new Error('stopped after closing 1 of 2 paths: EPERM');
      }),
    });
    mount(h);
    send({ kind: 'closeFiles', paths: 'all' });
    await act(async () => {});
    expect(results()).toStrictEqual([
      [
        'r1',
        { kind: 'failed', message: 'closeFiles failed: stopped after closing 1 of 2 paths: EPERM' },
      ],
    ]);
  });

  it('a throw after closeSession answered posts nothing more and is logged', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = fakeHandlers({
      kill: vi.fn(() => {
        throw new Error('pty gone');
      }),
    });
    mount(h);
    send({ kind: 'closeSession', target: 'B' });
    await act(async () => {});
    expect(results()).toStrictEqual([['r1', { kind: 'closeSession', ok: true }]]);
    expect(logged).toHaveBeenCalledWith('[mcp-ui] closeSession failed after answering', {
      error: 'pty gone',
    });
    logged.mockRestore();
  });
});

type Doc = Pick<OpenDoc, 'id' | 'kind' | 'path' | 'sessionId'>;
const doc = (
  kind: OpenDoc['kind'],
  path: string,
  sessionId = 'A',
  id = `${kind}:${path}`,
): Doc => ({
  id,
  kind,
  path,
  sessionId,
});

describe('planCloseFiles', () => {
  const docs: Doc[] = [
    doc('file', '/w/a.ts'),
    doc('diff', '/w/a.ts'),
    doc('diff', '/w/a.ts', 'A', 'diff@staged:/w/a.ts'),
    doc('file', '/w/b.ts', 'B'),
    doc('web', 'https://x.test/'),
    doc('review', '@review', 'A', 'review:@review'),
    doc('file', 'C:\\w\\c.ts'),
  ];

  it("file and diff tabs of the session match; other sessions' docs never", () => {
    expect(planCloseFiles(docs, 'A', ['/w/a.ts', '/w/b.ts'])).toStrictEqual({
      groups: [{ path: '/w/a.ts', ids: ['file:/w/a.ts', 'diff:/w/a.ts', 'diff@staged:/w/a.ts'] }],
      notOpen: ['/w/b.ts'],
    });
  });

  it('a web or review doc is never matched by path', () => {
    expect(planCloseFiles(docs, 'A', ['https://x.test/', '@review'])).toStrictEqual({
      groups: [],
      notOpen: ['https://x.test/', '@review'],
    });
  });

  it('unopened path → notOpen', () => {
    expect(planCloseFiles(docs, 'A', ['/w/zz.ts']).notOpen).toEqual(['/w/zz.ts']);
  });

  it('paths compare in the canonical spelling', () => {
    expect(planCloseFiles(docs, 'A', ['c:/w/c.ts']).groups).toStrictEqual([
      { path: 'c:/w/c.ts', ids: ['file:C:\\w\\c.ts'] },
    ]);
  });

  it('all groups every doc by path including @review', () => {
    expect(planCloseFiles(docs, 'A', 'all')).toStrictEqual({
      groups: [
        { path: '/w/a.ts', ids: ['file:/w/a.ts', 'diff:/w/a.ts', 'diff@staged:/w/a.ts'] },
        { path: 'https://x.test/', ids: ['web:https://x.test/'] },
        { path: '@review', ids: ['review:@review'] },
        { path: 'C:\\w\\c.ts', ids: ['file:C:\\w\\c.ts'] },
      ],
      notOpen: [],
    });
  });

  it('a requested path given twice is planned once', () => {
    expect(planCloseFiles(docs, 'A', ['/w/a.ts', '/w/a.ts', '/w/zz', '/w/zz'])).toStrictEqual({
      groups: [{ path: '/w/a.ts', ids: ['file:/w/a.ts', 'diff:/w/a.ts', 'diff@staged:/w/a.ts'] }],
      notOpen: ['/w/zz'],
    });
  });
});

describe('runCloseFiles', () => {
  function fakeOps(docs: Doc[], dirty: Set<string>, autoSave: boolean) {
    const live = new Map(docs.map((d) => [d.id, d]));
    const log: string[] = [];
    const ops: CloseFilesOps = {
      kindOf: (id) => live.get(id)?.kind,
      pathOf: (id) => live.get(id)?.path,
      isDirty: (p) => dirty.has(p),
      forceClose: (id) => {
        log.push(`force:${id}`);
        live.delete(id);
      },
      closeDirtyUnprompted: async (id) => {
        if (!autoSave) {
          log.push(`prompt:${id}`);
          return { type: 'prompt', reason: null };
        }
        log.push(`saved:${id}`);
        live.delete(id);
        return { type: 'close' };
      },
    };
    return { ops, log, live };
  }

  it('clean ids force-close', async () => {
    const docs = [doc('file', '/w/a.ts'), doc('diff', '/w/a.ts')];
    const { ops, log, live } = fakeOps(docs, new Set(), false);
    const out = await runCloseFiles(planCloseFiles(docs, 'A', ['/w/a.ts', '/w/no.ts']), ops);
    expect(out).toStrictEqual({
      closed: ['/w/a.ts'],
      skipped: [{ path: '/w/no.ts', reason: 'not_open' }],
    });
    expect(log).toEqual(['force:file:/w/a.ts', 'force:diff:/w/a.ts']);
    expect(live.size).toBe(0);
  });

  it('a dirty file needing a prompt is skipped unsaved, its diff tab still closes', async () => {
    const docs = [doc('file', '/w/a.ts'), doc('diff', '/w/a.ts')];
    const { ops, log, live } = fakeOps(docs, new Set(['/w/a.ts']), false);
    const out = await runCloseFiles(planCloseFiles(docs, 'A', ['/w/a.ts']), ops);
    expect(out).toStrictEqual({ closed: [], skipped: [{ path: '/w/a.ts', reason: 'unsaved' }] });
    expect(log).toEqual(['prompt:file:/w/a.ts', 'force:diff:/w/a.ts']);
    expect([...live.keys()]).toEqual(['file:/w/a.ts']);
  });

  it('a dirty diff tab is never asked about: only file tabs hold the buffer', async () => {
    const docs = [doc('diff', '/w/a.ts')];
    const { ops, log } = fakeOps(docs, new Set(['/w/a.ts']), false);
    const out = await runCloseFiles(planCloseFiles(docs, 'A', ['/w/a.ts']), ops);
    expect(out.closed).toEqual(['/w/a.ts']);
    expect(log).toEqual(['force:diff:/w/a.ts']);
  });

  it('a tab the user closed during an awaited auto-save is skipped, still counted closed', async () => {
    const docs = [doc('file', '/w/a.ts'), doc('diff', '/w/a.ts'), doc('file', '/w/b.ts')];
    const { ops, log, live } = fakeOps(docs, new Set(['/w/a.ts']), true);
    const save = ops.closeDirtyUnprompted;
    ops.closeDirtyUnprompted = async (id) => {
      const r = await save(id);
      live.delete('diff:/w/a.ts');
      live.delete('file:/w/b.ts');
      return r;
    };
    const out = await runCloseFiles(planCloseFiles(docs, 'A', 'all'), ops);
    expect(out).toStrictEqual({ closed: ['/w/a.ts', '/w/b.ts'], skipped: [] });
    expect(log).toEqual(['saved:file:/w/a.ts']);
  });

  it('an auto-save close counts as closed', async () => {
    const docs = [doc('file', '/w/a.ts')];
    const { ops, log } = fakeOps(docs, new Set(['/w/a.ts']), true);
    const out = await runCloseFiles(planCloseFiles(docs, 'A', 'all'), ops);
    expect(out).toStrictEqual({ closed: ['/w/a.ts'], skipped: [] });
    expect(log).toEqual(['saved:file:/w/a.ts']);
  });

  it('more than 500 entries → truncated, every doc still closed', async () => {
    const docs = Array.from({ length: MAX_CLOSE_RESULTS + 3 }, (_, i) => doc('file', `/w/f${i}`));
    const { ops, live } = fakeOps(docs, new Set(), false);
    const out = await runCloseFiles(planCloseFiles(docs, 'A', 'all'), ops);
    expect(out.closed).toHaveLength(MAX_CLOSE_RESULTS);
    expect(out.skipped).toEqual([]);
    expect(out.truncated).toBe(true);
    expect(live.size).toBe(0);
  });

  it('a throwing op mid-run rejects naming how many paths were closed', async () => {
    const docs = [doc('file', '/w/a.ts'), doc('file', '/w/b.ts'), doc('file', '/w/c.ts')];
    const { ops } = fakeOps(docs, new Set(['/w/b.ts']), false);
    ops.closeDirtyUnprompted = async () => {
      throw new Error('write EPERM');
    };
    await expect(runCloseFiles(planCloseFiles(docs, 'A', 'all'), ops)).rejects.toThrow(
      'stopped after closing 1 of 3 paths: write EPERM',
    );
  });

  it('a path whose diff tab closed before its file tab threw counts as closed', async () => {
    const docs = [doc('diff', '/w/a.ts'), doc('file', '/w/a.ts'), doc('file', '/w/b.ts')];
    const { ops, live } = fakeOps(docs, new Set(['/w/a.ts']), false);
    ops.closeDirtyUnprompted = async () => {
      throw new Error('write EPERM');
    };
    await expect(runCloseFiles(planCloseFiles(docs, 'A', 'all'), ops)).rejects.toThrow(
      'stopped after closing 1 of 2 paths: write EPERM',
    );
    expect(live.has('diff:/w/a.ts')).toBe(false);
  });

  it('a path reported skipped is not counted closed when a later path throws', async () => {
    const docs = [doc('diff', '/w/a.ts'), doc('file', '/w/a.ts'), doc('file', '/w/b.ts')];
    const { ops, live } = fakeOps(docs, new Set(['/w/a.ts', '/w/b.ts']), false);
    ops.closeDirtyUnprompted = async (id) => {
      if (id === 'file:/w/b.ts') throw new Error('write EPERM');
      return { type: 'prompt', reason: null };
    };
    await expect(runCloseFiles(planCloseFiles(docs, 'A', 'all'), ops)).rejects.toThrow(
      'stopped after closing 0 of 2 paths: write EPERM',
    );
    expect(live.has('diff:/w/a.ts')).toBe(false);
  });

  it('exactly 500 entries are not truncated', async () => {
    const docs = Array.from({ length: MAX_CLOSE_RESULTS }, (_, i) => doc('file', `/w/f${i}`));
    const { ops } = fakeOps(docs, new Set(), false);
    const out = await runCloseFiles(planCloseFiles(docs, 'A', 'all'), ops);
    expect(out.closed).toHaveLength(MAX_CLOSE_RESULTS);
    expect('truncated' in out).toBe(false);
  });
});
