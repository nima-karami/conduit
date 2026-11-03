/**
 * The renderer's TS project index is bounded: a root no session in the window uses leaves it,
 * extraLib traffic to the worker is coalesced, the total indexed text has a budget that never
 * trims the active session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Monaco's addExtraLib semantics, per defaults object: the same content again is a no-op, a
// handle only removes the version it added, and every change inside one tick is ONE re-post of
// the whole map to the worker (`_fireOnDidExtraLibsChangeSoon` is a setTimeout(0)).
const { ts, js, warn, mon } = vi.hoisted(() => {
  const make = () => ({ libs: new Map<string, { content: string; version: number }>(), posts: 0 });
  return {
    ts: make(),
    js: make(),
    warn: { calls: [] as unknown[][] },
    mon: {
      models: [] as JsModel[],
      created: new Set<(m: unknown) => void>(),
    },
  };
});

interface JsModel {
  uri: { toString: () => string; path: string };
  getValue: () => string;
  setValue: (text: string) => void;
  getLanguageId: () => string;
  isDisposed: () => boolean;
  dispose: () => void;
  onDidChangeContent: (cb: () => void) => { dispose: () => void };
  onWillDispose: (cb: () => void) => { dispose: () => void };
}

/** A model as monaco's editor creates one: listed, then announced to onDidCreateModel. */
function openModel(path: string, text: string, language = 'javascript'): JsModel {
  let value = text;
  let disposed = false;
  const edits = new Set<() => void>();
  const closes = new Set<() => void>();
  const m: JsModel = {
    uri: { toString: () => `file://${path}`, path },
    getValue: () => value,
    setValue: (t) => {
      value = t;
      for (const cb of edits) cb();
    },
    getLanguageId: () => language,
    isDisposed: () => disposed,
    dispose: () => {
      for (const cb of closes) cb();
      disposed = true;
    },
    onDidChangeContent: (cb) => {
      edits.add(cb);
      return { dispose: () => edits.delete(cb) };
    },
    onWillDispose: (cb) => {
      closes.add(cb);
      return { dispose: () => closes.delete(cb) };
    },
  };
  mon.models.push(m);
  for (const cb of mon.created) cb(m);
  return m;
}

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
    editor: {
      getModels: () => mon.models.filter((m) => !m.isDisposed()),
      getEditors: () => [],
      onDidCreateModel: (cb: (m: unknown) => void) => {
        mon.created.add(cb);
        return { dispose: () => mon.created.delete(cb) };
      },
      onDidChangeModelLanguage: () => ({ dispose: () => {} }),
    },
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
const jsKeys = () => [...js.libs.keys()].sort();

beforeEach(() => {
  vi.useFakeTimers();
  resetIndexForTest();
  vi.runAllTimers();
  mon.models.length = 0;
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
  it('holds only JS sources and declarations while no JS model imports a .ts file', () => {
    chunk('/w', {
      '/w/a.ts': 'a',
      '/w/t.tsx': 't',
      '/w/b.js': 'b',
      '/w/e.mjs': 'e',
      '/w/c.d.ts': 'c',
      '/w/m.d.mts': 'm',
    });
    expect(jsKeys()).toEqual([
      'file:///w/b.js',
      'file:///w/c.d.ts',
      'file:///w/e.mjs',
      'file:///w/m.d.mts',
    ]);
    expect(tsKeys().length).toBe(6);
    retainIndexRoots([]);
    expect(js.libs.size).toBe(0);
  });

  it('gets the .ts sources an open JS model imports, transitively, and nothing unrelated', () => {
    // F12 / hover from a .js file in an allowJs repo into a sibling .ts source.
    chunk('/w', {
      '/w/main.js': "import { foo } from './foo.ts';",
      '/w/foo.ts': "export { deep as foo } from './lib/deep.js';",
      '/w/lib/deep.ts': 'export const deep = 1;',
      '/w/unrelated.ts': 'export const u = 1;',
    });
    openModel('/w/main.js', "import { foo } from './foo.ts';");
    vi.advanceTimersByTime(1000);
    expect(js.libs.has('file:///w/foo.ts')).toBe(true);
    expect(js.libs.has('file:///w/lib/deep.ts')).toBe(true);
    expect(js.libs.has('file:///w/unrelated.ts')).toBe(false);
    expect(ts.libs.has('file:///w/unrelated.ts')).toBe(true);
  });

  it('follows an import added while editing, and lets go of .ts files once the JS tab closes', () => {
    chunk('/w', { '/w/a.ts': 'export const a = 1;', '/w/b.ts': 'export const b = 1;' });
    const m = openModel('/w/main.js', "import { a } from './a';");
    vi.advanceTimersByTime(1000);
    expect(jsKeys()).toEqual(['file:///w/a.ts']);
    m.setValue("import { a } from './a';\nimport { b } from './b';");
    vi.advanceTimersByTime(1000);
    expect(jsKeys()).toEqual(['file:///w/a.ts', 'file:///w/b.ts']);
    m.dispose();
    vi.advanceTimersByTime(1000);
    expect(jsKeys()).toEqual([]);
    expect(tsKeys()).toEqual(['file:///w/a.ts', 'file:///w/b.ts']);
  });

  it('a .ts file a JS model imports reaches the JS worker when it is indexed after the tab opened', () => {
    openModel('/w/main.js', "import { a } from './a';");
    chunk('/w', { '/w/a.ts': 'export const a = 1;' });
    vi.advanceTimersByTime(1000);
    expect(jsKeys()).toEqual(['file:///w/a.ts']);
  });

  it('an on-demand resolution reaches the JS worker too — a .js navigation may be waiting on it', () => {
    chunk('/w', { '/w/x.ts': 'x' });
    vi.advanceTimersByTime(1);
    addIndexedFiles([{ path: '/w/packages/p/src/index.ts', content: 'export {}' }]);
    expect(js.libs.has('file:///w/packages/p/src/index.ts')).toBe(true);
    expect(js.libs.has('file:///w/x.ts')).toBe(false);
  });
});

describe('a new file saved under an indexed root', () => {
  it('joins the index on the next push, without waiting for the fsChanged top-up', () => {
    chunk('/a', { '/a/x.ts': 'x' });
    vi.advanceTimersByTime(1);
    refreshIndexedFile('/a/src/b.ts', 'export const b = 1;');
    vi.advanceTimersByTime(1000);
    expect(tsKeys()).toEqual(['file:///a/src/b.ts', 'file:///a/x.ts']);
    // Owned by the root: it leaves with it.
    retainIndexRoots([]);
    expect(tsKeys()).toEqual([]);
  });

  it('stays out when it is not a source the host would index, or no indexed root holds it', () => {
    chunk('/a', { '/a/x.ts': 'x' });
    refreshIndexedFile('/a/node_modules/p/index.ts', 'n');
    refreshIndexedFile('/elsewhere/c.ts', 'c');
    vi.advanceTimersByTime(5000);
    expect(tsKeys()).toEqual(['file:///a/x.ts']);
  });
});

describe('retaining roots', () => {
  it("never evicts the active session's roots, even when the session list is briefly empty", () => {
    const evicted: string[] = [];
    const off = onIndexRootEvicted((k) => evicted.push(k));
    setActiveIndexRoots(['/a']);
    chunk('/a', { '/a/x.ts': 'a' });
    chunk('/b', { '/b/y.ts': 'b' });
    vi.advanceTimersByTime(1000);
    retainIndexRoots([]);
    off();
    expect(evicted).toEqual(['/b']);
    expect(tsKeys()).toEqual(['file:///a/x.ts']);
  });
});
