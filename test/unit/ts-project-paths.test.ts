/**
 * A renamed or deleted path leaves the TS project: its extraLibs go (a rename re-adds them at the
 * new path), and so does any model left on it that no tab shows — otherwise an import of the old
 * path keeps resolving, and F12 on it opens a tab on a file that no longer exists.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Monaco's own addExtraLib semantics: the same content again is a no-op whose handle removes
// nothing, and a handle only removes the version it added.
const { libs, models } = vi.hoisted(() => ({
  libs: new Map<string, { content: string; version: number }>(),
  models: [] as {
    uri: { toString: () => string; path: string };
    disposed: boolean;
    isDisposed: () => boolean;
    dispose: () => void;
  }[],
}));

vi.mock('monaco-editor', () => {
  let version = 0;
  const defaults = () => ({
    addExtraLib: (content: string, uri: string) => {
      if (libs.get(uri)?.content === content) return { dispose: () => {} };
      const mine = ++version;
      libs.set(uri, { content, version: mine });
      return {
        dispose: () => {
          if (libs.get(uri)?.version === mine) libs.delete(uri);
        },
      };
    },
    setCompilerOptions: () => {},
  });
  return {
    Uri: { file: (p: string) => ({ toString: () => `file://${p}`, path: p }) },
    editor: {
      getModels: () => models.filter((m) => !m.disposed),
      getEditors: () => [],
    },
    typescript: {
      typescriptDefaults: defaults(),
      javascriptDefaults: defaults(),
      getTypeScriptWorker: async () => async () => ({}),
    },
  };
});
vi.mock('../../webview/monaco-warmup', () => ({ warmLanguageWorker: () => {} }));

import { applyProjectFiles, forgetIndexedPath, moveIndexedPath } from '../../webview/ts-project';

function model(path: string) {
  const m = {
    uri: { toString: () => `file://${path}`, path },
    disposed: false,
    isDisposed: () => m.disposed,
    dispose: () => {
      m.disposed = true;
    },
  };
  models.push(m);
  return m;
}

const index = (files: Record<string, string>) =>
  applyProjectFiles({
    root: '/w',
    files: Object.entries(files).map(([path, content]) => ({ path, content, language: 'ts' })),
    seq: 0,
    total: Object.keys(files).length,
    done: true,
    skipped: 0,
    capped: 0,
    supplemental: true,
  });

beforeEach(() => {
  forgetIndexedPath('/w', () => false);
  libs.clear();
  models.length = 0;
});

describe('ts-project path moves', () => {
  it('a rename moves the file out of the old path and into the new one', () => {
    index({ '/w/a.ts': 'export const a = 1;', '/w/keep.ts': 'k' });
    moveIndexedPath('/w/a.ts', '/w/b.ts', () => false);
    expect([...libs.keys()].sort()).toEqual(['file:///w/b.ts', 'file:///w/keep.ts']);
    expect(libs.get('file:///w/b.ts')?.content).toBe('export const a = 1;');
  });

  it('a folder rename moves everything under it and nothing beside it', () => {
    index({ '/w/dir/c.ts': 'c', '/w/dir/sub/d.ts': 'd', '/w/dir2/e.ts': 'e' });
    moveIndexedPath('/w/dir', '/w/renamed', () => false);
    expect([...libs.keys()].sort()).toEqual([
      'file:///w/dir2/e.ts',
      'file:///w/renamed/c.ts',
      'file:///w/renamed/sub/d.ts',
    ]);
  });

  it('a delete drops the path and everything under it', () => {
    index({ '/w/dir/c.ts': 'c', '/w/gone.ts': 'g', '/w/keep.ts': 'k' });
    forgetIndexedPath('/w/dir', () => false);
    forgetIndexedPath('/w/gone.ts', () => false);
    expect([...libs.keys()]).toEqual(['file:///w/keep.ts']);
  });

  it('a file re-indexed with the same content can still be removed', () => {
    index({ '/w/a.ts': 'same' });
    index({ '/w/a.ts': 'same' });
    forgetIndexedPath('/w/a.ts', () => false);
    expect(libs.size).toBe(0);
  });

  it("drops models left on the old path, but never an open tab's", () => {
    const stale = model('/w/dir/peeked.ts');
    const tab = model('/w/dir/open.ts');
    const beside = model('/w/other.ts');
    forgetIndexedPath('/w/dir', (p) => p === '/w/dir/open.ts');
    expect(stale.disposed).toBe(true);
    expect(tab.disposed).toBe(false);
    expect(beside.disposed).toBe(false);
  });
});
