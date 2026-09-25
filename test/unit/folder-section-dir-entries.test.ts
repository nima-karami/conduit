// @vitest-environment jsdom
import { act, createElement, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../src/folder-key';
import type { HostToWebview } from '../../src/protocol';
import { FolderSection } from '../../webview/components/folder-section';
import { SettingsProvider } from '../../webview/settings';

const listeners = vi.hoisted(() => new Set<(m: HostToWebview) => void>());
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  subscribe: (cb: (m: HostToWebview) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  post: () => {},
}));
const applied = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('../../webview/file-tree', async (orig) => {
  const real = await orig<typeof import('../../webview/file-tree')>();
  return {
    ...real,
    applyEntries: (...a: Parameters<typeof real.applyEntries>) => {
      applied.paths.push(a[2]);
      return real.applyEntries(...a);
    },
  };
});

const noop = () => {};
const pane = {
  draggedPaths: [],
  dropTargetPath: null,
  committing: false,
  hasClipboard: false,
  dragOutMode: 'download' as const,
  setDropTarget: noop,
  startDrag: noop,
  endDrag: noop,
  dropInternal: noop,
  dropOs: noop,
  cut: noop,
  copy: noop,
  paste: noop,
  clearClipboard: noop,
  announce: noop,
  scrollTo: noop,
  openFolderMenu: noop,
};

let host: HTMLDivElement;
let root: Root | null = null;
let commits = 0;

const emit = (m: HostToWebview) =>
  act(async () => {
    for (const l of listeners) l(m);
  });
const entries = (names: string[]) => names.map((name) => ({ name, kind: 'dir' as const }));

async function render(path: string) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const section = { path, key: folderKey(path), kind: 'home' as const, missing: false };
  await act(async () => {
    root?.render(
      createElement(
        SettingsProvider,
        null,
        createElement(
          Profiler,
          { id: 'section', onRender: () => commits++ },
          createElement(FolderSection, {
            section: { ...section, name: 'a', label: 'a' },
            pane,
            view: { scrollTop: 0, viewportHeight: 600, rowHeight: 22 },
            collapsed: false,
            onToggleCollapsed: noop,
            treeCache: new Map(),
            rowChanges: new Map(),
            onPerf: noop,
            handleRef: noop,
            onOpenFile: noop,
            setMenu: noop,
            revealPath: noop,
            openExternalApp: noop,
            openWithChooser: noop,
            openAsSession: noop,
            copyToClipboard: noop,
            onDelete: noop,
            onRenamed: noop,
          }),
        ),
      ),
    );
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  listeners.clear();
});

describe('FolderSection dirEntries', () => {
  it("another folder's replies never re-render this section (review S1)", async () => {
    await render('/w/a');
    await emit({ type: 'dirEntries', path: '/w/a', entries: entries(['src', 'lib']) });
    expect(host.textContent).toContain('src');
    commits = 0;
    applied.paths = [];
    for (let i = 0; i < 20; i++) {
      await emit({ type: 'dirEntries', path: `/w/b/d${i}`, entries: entries(['x']) });
      await emit({ type: 'dirEntries', path: '/w/b', entries: entries(['y']) });
    }
    expect(commits).toBe(0);
    expect(applied.paths).toEqual([]);
    await emit({ type: 'dirEntries', path: '/w/a', entries: entries(['src', 'lib', 'new']) });
    expect(commits).toBeGreaterThan(0);
    expect(host.textContent).toContain('new');
  });

  it('a sibling whose name extends the folder name is foreign too', async () => {
    await render('/w/a');
    await emit({ type: 'dirEntries', path: '/w/a', entries: entries(['src']) });
    commits = 0;
    await emit({ type: 'dirEntries', path: '/w/ab', entries: entries(['zz']) });
    expect(commits).toBe(0);
    expect(host.textContent).not.toContain('zz');
  });
});
