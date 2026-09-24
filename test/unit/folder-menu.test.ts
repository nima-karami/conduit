import { describe, expect, it, vi } from 'vitest';
import type { FolderSectionModel } from '../../src/session-sections';
import { buildFolderMenuItems, type FolderMenuHandlers } from '../../webview/folder-menu';

const sec = (over: Partial<FolderSectionModel> = {}): FolderSectionModel => ({
  path: '/w/ci-image',
  key: '/w/ci-image',
  kind: 'attached',
  missing: false,
  name: 'ci-image',
  label: 'ci-image',
  ...over,
});

const handlers = (): FolderMenuHandlers & Record<string, ReturnType<typeof vi.fn>> => ({
  makeHome: vi.fn(),
  reveal: vi.fn(),
  copyPath: vi.fn(),
  remove: vi.fn(),
});

describe('buildFolderMenuItems', () => {
  it('home: Reveal in Explorer, Copy path — no Remove, no Make home', () => {
    const items = buildFolderMenuItems(sec({ kind: 'home' }), handlers());
    expect(items.map((i) => i.label)).toEqual(['Reveal in Explorer', 'Copy path']);
  });

  it('attached: Make home, Reveal, Copy path, Remove from session (danger, separatorBefore)', () => {
    const items = buildFolderMenuItems(sec(), handlers());
    expect(items.map((i) => i.label)).toEqual([
      'Make home',
      'Reveal in Explorer',
      'Copy path',
      'Remove from session',
    ]);
    const remove = items[3];
    expect(remove.danger).toBe(true);
    expect(remove.separatorBefore).toBe(true);
    expect(items.slice(0, 3).every((i) => !i.danger && !i.separatorBefore)).toBe(true);
    expect(items[0].disabled).toBeFalsy();
  });

  it('missing attached: Make home disabled with title "Folder not found"', () => {
    const items = buildFolderMenuItems(sec({ missing: true }), handlers());
    const make = items.find((i) => i.label === 'Make home');
    expect(make?.disabled).toBe(true);
    expect(make?.title).toBe('Folder not found');
    expect(items.find((i) => i.label === 'Remove from session')?.disabled).toBeFalsy();
  });

  it('each item calls its handler', () => {
    const h = handlers();
    const items = buildFolderMenuItems(sec(), h);
    for (const i of items) i.onClick();
    expect(h.makeHome).toHaveBeenCalledTimes(1);
    expect(h.reveal).toHaveBeenCalledTimes(1);
    expect(h.copyPath).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledTimes(1);
  });
});
