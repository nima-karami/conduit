import { describe, expect, it } from 'vitest';
import { defaultSidebarUi, type SidebarUiState } from '../../src/sidebar-state';
import {
  parseWindowLayout,
  planLayoutRestore,
  serializeWindowLayout,
} from '../../src/window-registry';
import {
  INITIAL_SIDEBAR_UI_SYNC,
  pruneSidebarUi,
  stepSidebarUi,
} from '../../webview/sidebar-tree-state';

const bounds = { x: 0, y: 0, width: 800, height: 600 };
const space = (projectId: string): SidebarUiState => ({
  ...defaultSidebarUi(),
  selection: { kind: 'space', projectId },
});

describe('window sidebar UI across a restart (plan T1.1)', () => {
  it('two restored windows keep their own selection', () => {
    const saved = serializeWindowLayout([
      { bounds, sessionIds: ['a'], sidebarUi: space('p1') },
      { bounds, sessionIds: ['b'], sidebarUi: space('p2') },
    ]);
    const plan = planLayoutRestore(parseWindowLayout(saved), ['a', 'b']);
    expect(plan.map((w) => w.sidebarUi?.selection)).toEqual([
      { kind: 'space', projectId: 'p1' },
      { kind: 'space', projectId: 'p2' },
    ]);
  });

  it('a dropped empty window loses its selection; the survivor keeps its own', () => {
    const plan = planLayoutRestore(
      [
        { bounds, sessionIds: ['gone'], sidebarUi: space('p1') },
        { bounds, sessionIds: ['b'], sidebarUi: space('p2') },
      ],
      ['b'],
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].sidebarUi?.selection).toEqual({ kind: 'space', projectId: 'p2' });
  });
});

describe('stepSidebarUi — one-shot hydration, never echoed', () => {
  it('starts unhydrated at defaults', () => {
    expect(INITIAL_SIDEBAR_UI_SYNC).toEqual({ ui: defaultSidebarUi(), hydrated: false });
  });

  it('init hydrates without asking to persist', () => {
    const r = stepSidebarUi(INITIAL_SIDEBAR_UI_SYNC, { kind: 'init', ui: space('p1') });
    expect(r).toEqual({ sync: { ui: space('p1'), hydrated: true }, persist: null });
  });

  it('an edit before init applies locally only, and init wins over it', () => {
    const early = stepSidebarUi(INITIAL_SIDEBAR_UI_SYNC, { kind: 'edit', ui: space('x') });
    expect(early).toEqual({ sync: { ui: space('x'), hydrated: false }, persist: null });
    const init = stepSidebarUi(early.sync, { kind: 'init', ui: space('p1') });
    expect(init.sync.ui).toEqual(space('p1'));
    expect(init.persist).toBeNull();
  });

  it('an edit after init persists exactly the edited value', () => {
    const { sync } = stepSidebarUi(INITIAL_SIDEBAR_UI_SYNC, { kind: 'init', ui: space('p1') });
    const next = { ...sync.ui, pinnedIds: ['a'] };
    expect(stepSidebarUi(sync, { kind: 'edit', ui: next })).toEqual({
      sync: { ui: next, hydrated: true },
      persist: next,
    });
  });

  it('a reload re-hydrates from a second init without an echo', () => {
    const one = stepSidebarUi(INITIAL_SIDEBAR_UI_SYNC, { kind: 'init', ui: space('p1') });
    const two = stepSidebarUi(one.sync, { kind: 'init', ui: space('p2') });
    expect(two).toEqual({ sync: { ui: space('p2'), hydrated: true }, persist: null });
  });

  it('an edit equal to the current value is not persisted again', () => {
    const { sync } = stepSidebarUi(INITIAL_SIDEBAR_UI_SYNC, { kind: 'init', ui: space('p1') });
    expect(stepSidebarUi(sync, { kind: 'edit', ui: space('p1') }).persist).toBeNull();
  });
});

describe('pruneSidebarUi', () => {
  const ui: SidebarUiState = {
    selection: { kind: 'space', projectId: 'p1' },
    foldedGroups: ['stopped'],
    foldedSessions: ['a', 'gone'],
    pinnedIds: ['gone', 'b'],
  };

  it('drops vanished ids and falls back to All for a removed Space', () => {
    expect(pruneSidebarUi(ui, new Set(['a', 'b']), new Set())).toEqual({
      selection: { kind: 'all' },
      foldedGroups: ['stopped'],
      foldedSessions: ['a'],
      pinnedIds: ['b'],
    });
  });

  it('returns the same object when nothing is stale', () => {
    const clean: SidebarUiState = { ...ui, foldedSessions: ['a'], pinnedIds: ['b'] };
    expect(pruneSidebarUi(clean, new Set(['a', 'b']), new Set(['p1']))).toBe(clean);
  });
});
