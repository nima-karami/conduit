import { describe, expect, it, vi } from 'vitest';
import {
  buildExplorerMenuItems,
  type ExplorerMenuContext,
  resolveExplorerTargets,
} from '../../webview/explorer-menu';

// Menu-array coverage for the Explorer row menu — see
// docs/specs/2026-08-16-selection-aware-context-menus.md §4.2 and §14 B.

const FILE = { path: '/p/a.txt', kind: 'file' as const };
const DIR = { path: '/p/sub', kind: 'dir' as const };

function ctx(over: Partial<ExplorerMenuContext> = {}): ExplorerMenuContext {
  return {
    node: FILE,
    targets: [FILE.path],
    targetDir: '/p',
    hasClipboard: false,
    relativePath: (abs) => abs.replace('/p/', ''),
    onOpen: () => undefined,
    onOpenExternally: () => undefined,
    onOpenWith: () => undefined,
    onNewFile: () => undefined,
    onNewFolder: () => undefined,
    onRename: () => undefined,
    onCut: () => undefined,
    onCopy: () => undefined,
    onPaste: () => undefined,
    onCopyText: () => undefined,
    onReveal: () => undefined,
    onOpenAsSession: () => undefined,
    onDelete: () => undefined,
    ...over,
  };
}

const THREE = ['/p/a.txt', '/p/b.txt', '/p/c.txt'];
const labels = (c: ExplorerMenuContext) => buildExplorerMenuItems(c).map((i) => i.label);
const find = (c: ExplorerMenuContext, label: string) =>
  buildExplorerMenuItems(c).find((i) => i.label === label);

// The decidable no-regression baseline for §8 (not the phrase "identical to today").
const FILE_LABELS = [
  'Open',
  'Open externally',
  'Open with…',
  'New file…',
  'Rename…',
  'Cut',
  'Copy',
  'Paste into folder',
  'Copy path',
  'Copy relative path',
  'Reveal in Explorer',
  'Delete',
];
const DIR_LABELS = [
  'New file…',
  'New folder…',
  'Rename…',
  'Cut',
  'Copy',
  'Paste into folder',
  'Copy path',
  'Copy relative path',
  'Reveal in Explorer',
  'Open as new session',
  'Delete',
];

describe('buildExplorerMenuItems — single target', () => {
  it('builds the file variant in its established order', () => {
    expect(labels(ctx())).toEqual(FILE_LABELS);
  });

  it('builds the folder variant in its established order', () => {
    expect(labels(ctx({ node: DIR, targets: [DIR.path], targetDir: DIR.path }))).toEqual(
      DIR_LABELS,
    );
  });

  it('reads Delete without a count', () => {
    const items = buildExplorerMenuItems(ctx());
    const last = items[items.length - 1];
    expect(last.label).toBe('Delete');
    expect(last.danger).toBe(true);
    expect(last.separatorBefore).toBe(true);
  });

  it('disables nothing but the empty-clipboard Paste', () => {
    const disabled = buildExplorerMenuItems(ctx())
      .filter((i) => i.disabled)
      .map((i) => i.label);
    expect(disabled).toEqual(['Paste into folder']);
  });

  it('enables Paste into folder once the clipboard holds something', () => {
    expect(find(ctx({ hasClipboard: true }), 'Paste into folder')?.disabled).toBe(false);
  });
});

describe('buildExplorerMenuItems — multi target', () => {
  const multi = ctx({ targets: THREE, hasClipboard: true });

  it('counts the destructive item and keeps it last, danger and separated', () => {
    const items = buildExplorerMenuItems(multi);
    const last = items[items.length - 1];
    expect(last.label).toBe('Delete 3 items');
    expect(last.danger).toBe(true);
    expect(last.separatorBefore).toBe(true);
  });

  it('disables every single-only item', () => {
    const disabled = buildExplorerMenuItems(multi)
      .filter((i) => i.disabled)
      .map((i) => i.label);
    expect(disabled).toEqual([
      'Open externally',
      'Open with…',
      'New file…',
      'Rename…',
      'Paste into folder',
      'Reveal in Explorer',
    ]);
  });

  it('also disables New folder… on the folder variant', () => {
    const items = buildExplorerMenuItems(
      ctx({ node: DIR, targets: [DIR.path, '/p/other'], targetDir: DIR.path, hasClipboard: true }),
    );
    expect(items.find((i) => i.label === 'New folder…')?.disabled).toBe(true);
  });

  it('leaves the selection-scoped items enabled', () => {
    for (const label of ['Open', 'Cut', 'Copy', 'Copy path', 'Copy relative path']) {
      expect(find(multi, label)?.disabled).toBeFalsy();
    }
  });

  it('scopes Open, Cut, Copy and Delete to every target', () => {
    const onOpen = vi.fn();
    const onCut = vi.fn();
    const onCopy = vi.fn();
    const onDelete = vi.fn();
    const c = ctx({ targets: THREE, onOpen, onCut, onCopy, onDelete });
    find(c, 'Open')?.onClick();
    find(c, 'Cut')?.onClick();
    find(c, 'Copy')?.onClick();
    find(c, 'Delete 3 items')?.onClick();
    expect(onOpen).toHaveBeenCalledWith(THREE);
    expect(onCut).toHaveBeenCalledWith(THREE);
    expect(onCopy).toHaveBeenCalledWith(THREE);
    expect(onDelete).toHaveBeenCalledWith(THREE);
  });

  it('joins Copy path with newlines in tree order', () => {
    const onCopyText = vi.fn();
    const c = ctx({ targets: THREE, onCopyText });
    find(c, 'Copy path')?.onClick();
    expect(onCopyText).toHaveBeenCalledTimes(1);
    expect(onCopyText).toHaveBeenCalledWith('/p/a.txt\n/p/b.txt\n/p/c.txt');
  });

  it('joins Copy relative path with newlines in tree order', () => {
    const onCopyText = vi.fn();
    const c = ctx({ targets: THREE, onCopyText });
    find(c, 'Copy relative path')?.onClick();
    expect(onCopyText).toHaveBeenCalledTimes(1);
    expect(onCopyText).toHaveBeenCalledWith('a.txt\nb.txt\nc.txt');
  });

  it('acts on the clicked row for the single-only items', () => {
    const onRename = vi.fn();
    const onReveal = vi.fn();
    const c = ctx({ targets: THREE, onRename, onReveal });
    find(c, 'Rename…')?.onClick();
    find(c, 'Reveal in Explorer')?.onClick();
    expect(onRename).toHaveBeenCalledWith(FILE);
    expect(onReveal).toHaveBeenCalledWith(FILE.path);
  });

  it('changes scope and enabled-ness only — never the menu shape', () => {
    const single = labels(ctx());
    const many = labels(multi);
    expect(many.length).toBe(single.length);
    expect(many.map((l) => l.replace(/^Delete 3 items$/, 'Delete'))).toEqual(single);
  });
});

describe('Open as new session', () => {
  const dir = (over: Partial<ExplorerMenuContext> = {}) =>
    ctx({ node: DIR, targets: [DIR.path], targetDir: DIR.path, ...over });
  const ROOT = { path: '/p', kind: 'dir' as const };

  it('offers it on a single folder', () => {
    expect(labels(dir())).toContain('Open as new session');
  });

  it('offers it on the project-root row', () => {
    expect(labels(ctx({ node: ROOT, targets: [ROOT.path], targetDir: ROOT.path }))).toContain(
      'Open as new session',
    );
  });

  it('never offers it on a file', () => {
    expect(labels(ctx())).not.toContain('Open as new session');
    expect(labels(ctx({ targets: THREE }))).not.toContain('Open as new session');
  });

  it('disables it, with a reason, when the selection is more than one folder', () => {
    const many = dir({ targets: [DIR.path, '/p/other'] });
    expect(labels(many)).toEqual(labels(dir()).map((l) => l.replace(/^Delete$/, 'Delete 2 items')));
    const item = find(many, 'Open as new session');
    expect(item?.disabled).toBe(true);
    expect(item?.title).toBe('Select a single folder');
  });

  it('carries no tooltip while it is enabled', () => {
    expect(find(dir(), 'Open as new session')?.title).toBeUndefined();
  });

  it('keeps it when a nested selection collapses onto one folder', () => {
    const { targets } = resolveExplorerTargets(['/p/sub', '/p/sub/x'], '/p/sub/x');
    expect(labels(dir({ targets }))).toContain('Open as new session');
  });

  it('passes the clicked folder to the handler', () => {
    const onOpenAsSession = vi.fn();
    find(dir({ onOpenAsSession }), 'Open as new session')?.onClick();
    expect(onOpenAsSession).toHaveBeenCalledWith(DIR.path);
  });

  it('sits in its own group directly above the destructive item', () => {
    const items = buildExplorerMenuItems(dir());
    const i = items.findIndex((it) => it.label === 'Open as new session');
    expect(items[i].separatorBefore).toBe(true);
    expect(items[i].danger).toBeFalsy();
    expect(items[i].disabled).toBeFalsy();
    expect(items[i + 1].label).toBe('Delete');
    expect(items.length).toBe(i + 2);
  });
});

describe('resolveExplorerTargets', () => {
  it('keeps the whole selection when the clicked row is in it', () => {
    const r = resolveExplorerTargets(['/p/a', '/p/b'], '/p/a');
    expect(r).toEqual({ targets: ['/p/a', '/p/b'], collapse: false });
  });

  it('collapses onto a clicked row outside the selection', () => {
    const r = resolveExplorerTargets(['/p/a', '/p/b'], '/p/z');
    expect(r).toEqual({ targets: ['/p/z'], collapse: true });
  });

  it('drops a nested target so the count is final before the menu opens', () => {
    const r = resolveExplorerTargets(['/p/sub', '/p/sub/x', '/p/b'], '/p/b');
    expect(r).toEqual({ targets: ['/p/sub', '/p/b'], collapse: false });
  });

  it('preserves the selection when the clicked row is nested inside another target', () => {
    // The row IS selected, so rule 1 applies even though the de-dupe removes it.
    const r = resolveExplorerTargets(['/p/sub', '/p/sub/x'], '/p/sub/x');
    expect(r).toEqual({ targets: ['/p/sub'], collapse: false });
  });
});

// Cross-menu invariants from docs/specs/archive/2026-06-23-context-menu-consistency.md §7.
describe('context-menu invariants', () => {
  const all = [
    ctx(),
    ctx({ targets: THREE }),
    ctx({ node: DIR, targets: [DIR.path], targetDir: DIR.path }),
    ctx({ node: DIR, targets: THREE, targetDir: DIR.path }),
  ];

  it('never puts a separator before the first item', () => {
    for (const c of all) expect(buildExplorerMenuItems(c)[0].separatorBefore).toBeFalsy();
  });

  it('keeps every danger item last in its menu', () => {
    for (const c of all) {
      const items = buildExplorerMenuItems(c);
      const dangerAt = items.map((it, i) => (it.danger ? i : -1)).filter((i) => i >= 0);
      expect(dangerAt).toEqual([items.length - 1]);
    }
  });
});
