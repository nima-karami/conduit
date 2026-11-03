/**
 * The renderer's TS project index is bounded: a root no session in the window uses leaves it,
 * extraLib traffic to the worker is coalesced, the total indexed text has a budget that never
 * trims the active session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Monaco's addExtraLib semantics, per defaults object: the same content again is a no-op, a
// handle only removes the version it added, and every change inside one tick is ONE re-post of
// the whole map to the worker (`_fireOnDidExtraLibsChangeSoon` is a setTimeout(0)).
const { ts, js, warn } = vi.hoisted(() => {
  const make = () => ({ libs: new Map<string, { content: string; version: number }>(), posts: 0 });
  return { ts: make(), js: make(), warn: { calls: [] as unknown[][] } };
});

vi.mock('monaco-editor', () => {
  let version = 0;
  const defaults = (side: {
    libs: Map<string, { content: string; version: number }>;
    posts: number;
  }) => {
    let scheduled = false;
    const changed = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        side.posts++;
      }, 0);
    };
    return {
      addExtraLib: (content: string, uri: string) => {
        if (side.libs.get(uri)?.content === content) return { dispose: () => {} };
        const mine = ++version;
        side.libs.set(uri, { content, version: mine });
        changed();
        return {
          dispose: () => {
            if (side.libs.get(uri)?.version !== mine) return;
            side.libs.delete(uri);
            changed();
          },
        };
      },
      setCompilerOptions: () => {},
    };
  };
  return {
    Uri: { file: (p: string) => ({ toString: () => `file://${p}`, path: p }) },
    editor: { getModels: () => [], getEditors: () => [] },
    typescript: {
      typescriptDefaults: defaults(ts),
      javascriptDefaults: defaults(js),
      getTypeScriptWorker: async () => async () => ({}),
    },
  };
});
vi.mock('../../webview/monaco-warmup', () => ({ warmLanguageWorker: () => {} }));
vi.mock('../../webview/log', () => ({
  log: { warn: (...a: unknown[]) => warn.calls.push(a), info: () => {}, error: () => {} },
}));

import {
  addIndexedFiles,
  applyProjectFiles,
  expectIndexRoot,
  indexStatus,
  MAX_INDEXED_SOURCE_BYTES,
  onIndexRootEvicted,
  refreshIndexedFile,
  __resetIndexForTest as resetIndexForTest,
  retainIndexRoots,
  setActiveIndexRoots,
} from '../../webview/ts-project';

const chunk = (
  root: string,
  files: Record<string, string>,
  over: Partial<Parameters<typeof applyProjectFiles>[0]> = {},
) => {
  expectIndexRoot(root);
  applyProjectFiles({
    root,
    files: Object.entries(files).map(([path, content]) => ({ path, content, language: 'ts' })),
    seq: 0,
    total: Object.keys(files).length,
    done: true,
    skipped: 0,
    capped: 0,
    ...over,
  });
};

const tsKeys = () => [...ts.libs.keys()].sort();

beforeEach(() => {
  vi.useFakeTimers();
  resetIndexForTest();
  vi.runAllTimers();
  ts.libs.clear();
  js.libs.clear();
  ts.posts = 0;
  js.posts = 0;
  warn.calls.length = 0;
});

afterEach(() => {
  resetIndexForTest();
  vi.runAllTimers();
  vi.useRealTimers();
});

describe('root eviction', () => {
  it('a root no session in the window uses leaves the index; a used one stays', () => {
    chunk('/a', { '/a/x.ts': 'a' });
    chunk('/b', { '/b/y.ts': 'b' });
    const evicted: string[] = [];
    const off = onIndexRootEvicted((k) => evicted.push(k));
    vi.advanceTimersByTime(1000);
    retainIndexRoots(['/b']);
    off();
    expect(tsKeys()).toEqual(['file:///b/y.ts']);
    expect(evicted).toEqual(['/a']);
    expect(indexStatus().total).toBe(1);
  });

  it('ignores late chunks of an evicted root, and re-indexes it once it is expected again', () => {
    chunk('/a', { '/a/x.ts': 'a' }, { done: false });
    retainIndexRoots([]);
    applyProjectFiles({
      root: '/a',
      files: [{ path: '/a/late.ts', content: 'l', language: 'ts' }],
      seq: 1,
      total: 2,
      done: true,
      skipped: 0,
      capped: 0,
    });
    vi.runAllTimers();
    expect(tsKeys()).toEqual([]);
    chunk('/a', { '/a/x.ts': 'a' });
    vi.advanceTimersByTime(1000);
    expect(tsKeys()).toEqual(['file:///a/x.ts']);
  });

  it('a file shared by nested roots stays while either root is used', () => {
    chunk('/a', { '/a/pkg/x.ts': 'x', '/a/top.ts': 't' });
    chunk('/a/pkg', { '/a/pkg/x.ts': 'x' });
    retainIndexRoots(['/a']);
    expect(tsKeys()).toEqual(['file:///a/pkg/x.ts', 'file:///a/top.ts']);
    retainIndexRoots([]);
    expect(tsKeys()).toEqual([]);
  });

  it('matches roots by folder key, not spelling', () => {
    chunk('G:\\Work\\r', { 'G:/Work/r/x.ts': 'x' });
    retainIndexRoots(['g:/work/r/']);
    expect(tsKeys()).toEqual(['file://G:/Work/r/x.ts']);
  });
});

describe('extraLib coalescing', () => {
  it('re-posts the map at most once per second across flushes and saves', () => {
    chunk('/a', { '/a/0.ts': '0' }, { done: false });
    vi.advanceTimersByTime(1);
    expect(ts.posts).toBe(1);
    for (let i = 1; i <= 5; i++) {
      applyProjectFiles({
        root: '/a',
        files: [{ path: `/a/${i}.ts`, content: String(i), language: 'ts' }],
        seq: i,
        total: 6,
        done: false,
        skipped: 0,
        capped: 0,
      });
      vi.advanceTimersByTime(300);
    }
    refreshIndexedFile('/a/0.ts', 'saved once');
    refreshIndexedFile('/a/0.ts', 'saved twice');
    // 1.5 s in: the 1 s slot carried every flush; the two saves wait for the next slot together.
    expect(ts.posts).toBe(2);
    vi.advanceTimersByTime(2000);
    expect(ts.posts).toBe(3);
    expect(ts.libs.get('file:///a/0.ts')?.content).toBe('saved twice');
    expect(ts.libs.size).toBe(6);
  });

  it('a save of a file the index never held adds nothing', () => {
    chunk('/a', { '/a/x.ts': 'x' });
    refreshIndexedFile('/a/notes.md', '# hi');
    vi.advanceTimersByTime(5000);
    expect(tsKeys()).toEqual(['file:///a/x.ts']);
  });

  it('an on-demand resolution reaches the worker at once — a navigation is waiting on it', () => {
    chunk('/a', { '/a/x.ts': 'x' });
    vi.advanceTimersByTime(1);
    addIndexedFiles([{ path: '/a/node_modules/p/index.d.ts', content: 'export {}' }]);
    expect(ts.libs.has('file:///a/node_modules/p/index.d.ts')).toBe(true);
  });

  it('done waits for the final content to reach the worker', () => {
    chunk('/a', { '/a/0.ts': '0' }, { done: false });
    applyProjectFiles({
      root: '/a',
      files: [{ path: '/a/1.ts', content: '1', language: 'ts' }],
      seq: 1,
      total: 2,
      done: true,
      skipped: 0,
      capped: 0,
    });
    expect(indexStatus().done).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(indexStatus().done).toBe(true);
  });
});

describe('indexed-bytes budget', () => {
  const big = (n: number) => 'x'.repeat(n);
  const third = Math.floor(MAX_INDEXED_SOURCE_BYTES * 0.4);

  it('evicts the least recently active root first, and logs once', () => {
    const evicted: string[] = [];
    const off = onIndexRootEvicted((k) => evicted.push(k));
    setActiveIndexRoots(['/a']);
    chunk('/a', { '/a/x.ts': big(third) });
    setActiveIndexRoots(['/b']);
    chunk('/b', { '/b/x.ts': big(third) });
    setActiveIndexRoots(['/c']);
    chunk('/c', { '/c/x.ts': big(third) });
    vi.advanceTimersByTime(5000);
    expect(evicted).toEqual(['/a']);
    expect(tsKeys()).toEqual(['file:///b/x.ts', 'file:///c/x.ts']);
    setActiveIndexRoots(['/d']);
    chunk('/d', { '/d/x.ts': big(third) });
    vi.advanceTimersByTime(5000);
    off();
    expect(evicted).toEqual(['/a', '/b']);
    expect(warn.calls.length).toBe(1);
  });

  it("never evicts the active session's roots, even over budget", () => {
    setActiveIndexRoots(['/a', '/b']);
    chunk('/a', { '/a/x.ts': big(MAX_INDEXED_SOURCE_BYTES) });
    chunk('/b', { '/b/x.ts': big(third) });
    vi.advanceTimersByTime(5000);
    expect(tsKeys()).toEqual(['file:///a/x.ts', 'file:///b/x.ts']);
  });
});

describe('javascript worker', () => {
  it('holds the same files as the TS worker, and loses them on eviction too', () => {
    // A .js file in an allowJs repo navigates into sibling .ts sources (F12 parity).
    chunk('/w', { '/w/a.ts': 'a', '/w/b.js': 'b', '/w/c.d.ts': 'c' });
    expect([...js.libs.keys()].sort()).toEqual(tsKeys());
    retainIndexRoots([]);
    expect(js.libs.size).toBe(0);
  });
});
