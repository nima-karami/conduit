import { describe, expect, it, vi } from 'vitest';
import type { ArchNode } from '../../src/architecture';
import {
  type ArchNodeMenuContext,
  buildArchNodeMenuItems,
  resolveArchNodeTargets,
} from '../../webview/components/architecture-view';

// Menu-array coverage for the architecture node menu — see
// docs/specs/2026-08-16-selection-aware-context-menus.md §5 and §14 B/D.

const LEAF: ArchNode = { id: 'n1', title: 'Gateway', kind: 'gateway', x: 100, y: 40 };
const PARENT: ArchNode = { ...LEAF, id: 'n2', title: 'Billing', childGraph: 'g2' };

function ctx(over: Partial<ArchNodeMenuContext> = {}): ArchNodeMenuContext {
  return {
    model: LEAF,
    targets: [LEAF.id],
    onDrill: () => undefined,
    onAddConnected: () => undefined,
    onAddPort: () => undefined,
    onGroup: () => undefined,
    onEncapsulate: () => undefined,
    onRename: () => undefined,
    onEditDescription: () => undefined,
    onSetIcon: () => undefined,
    onDuplicate: () => undefined,
    onExplode: () => undefined,
    onCopyName: () => undefined,
    onDelete: () => undefined,
    ...over,
  };
}

const THREE = ['n1', 'n7', 'n9'];
const labels = (c: ArchNodeMenuContext) => buildArchNodeMenuItems(c).map((i) => i.label);
const find = (c: ArchNodeMenuContext, label: string) =>
  buildArchNodeMenuItems(c).find((i) => i.label === label);

// The decidable no-regression baseline for §8 — today's menu, verbatim.
const LEAF_LABELS = [
  'Create nested canvas',
  'Add connected node',
  'Add input port',
  'Add output port',
  'Rename…',
  'Edit description…',
  'Set icon…',
  'Duplicate',
  'Copy name',
  'Delete component',
];
const PARENT_LABELS = [
  'Open nested canvas',
  'Add connected node',
  'Add input port',
  'Add output port',
  'Rename…',
  'Edit description…',
  'Set icon…',
  'Duplicate',
  'Explode component',
  'Copy name',
  'Delete component',
];

describe('buildArchNodeMenuItems — single target', () => {
  it('builds a leaf component menu in its established order', () => {
    expect(labels(ctx())).toEqual(LEAF_LABELS);
  });

  it('offers the nested-canvas and explode items once the component has a child graph', () => {
    expect(labels(ctx({ model: PARENT, targets: [PARENT.id] }))).toEqual(PARENT_LABELS);
  });

  it('reads Delete component without a count', () => {
    const items = buildArchNodeMenuItems(ctx());
    const last = items[items.length - 1];
    expect(last.label).toBe('Delete component');
    expect(last.danger).toBe(true);
    expect(last.separatorBefore).toBe(true);
  });

  it('disables nothing', () => {
    expect(buildArchNodeMenuItems(ctx()).filter((i) => i.disabled)).toEqual([]);
  });

  it('omits the selection-scoped grouping items', () => {
    expect(find(ctx(), 'Group selection')).toBeUndefined();
    expect(find(ctx(), 'Encapsulate selection into component')).toBeUndefined();
  });

  it('keeps the separator layout it has today', () => {
    const separated = buildArchNodeMenuItems(ctx())
      .filter((i) => i.separatorBefore)
      .map((i) => i.label);
    expect(separated).toEqual(['Add connected node', 'Rename…', 'Copy name', 'Delete component']);
  });
});

describe('buildArchNodeMenuItems — multi target', () => {
  const multi = ctx({ model: PARENT, targets: [PARENT.id, 'n7', 'n9'] });

  it('counts the destructive item and keeps it last, danger and separated', () => {
    const items = buildArchNodeMenuItems(multi);
    const last = items[items.length - 1];
    expect(last.label).toBe('Delete 3 components');
    expect(last.danger).toBe(true);
    expect(last.separatorBefore).toBe(true);
  });

  it('disables every single-only item', () => {
    const disabled = buildArchNodeMenuItems(multi)
      .filter((i) => i.disabled)
      .map((i) => i.label);
    expect(disabled).toEqual([
      'Open nested canvas',
      'Add connected node',
      'Add input port',
      'Add output port',
      'Rename…',
      'Edit description…',
      'Set icon…',
      'Duplicate',
      'Explode component',
      'Copy name',
    ]);
  });

  it('offers Group selection and Encapsulate, both enabled', () => {
    for (const label of ['Group selection', 'Encapsulate selection into component']) {
      expect(find(multi, label)?.disabled).toBeFalsy();
    }
  });

  it('deletes every target in one call', () => {
    const onDelete = vi.fn();
    const c = ctx({ targets: THREE, onDelete });
    find(c, 'Delete 3 components')?.onClick();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(THREE);
  });

  it('acts on the clicked component for the single-only items', () => {
    const onRename = vi.fn();
    const onCopyName = vi.fn();
    const c = ctx({ targets: THREE, onRename, onCopyName });
    find(c, 'Rename…')?.onClick();
    find(c, 'Copy name')?.onClick();
    expect(onRename).toHaveBeenCalledWith(LEAF.id);
    expect(onCopyName).toHaveBeenCalledWith(LEAF.title);
  });

  it('changes scope and enabled-ness only — never the established item order', () => {
    const single = labels(ctx({ model: PARENT, targets: [PARENT.id] }));
    const many = labels(multi).filter(
      (l) => l !== 'Group selection' && l !== 'Encapsulate selection into component',
    );
    expect(many.map((l) => l.replace(/^Delete 3 components$/, 'Delete component'))).toEqual(single);
  });
});

describe('resolveArchNodeTargets', () => {
  const LIVE = ['n1', 'n7', 'n9'];

  it('keeps the whole selection when the clicked node is in it', () => {
    expect(resolveArchNodeTargets(['n1', 'n7'], LIVE, 'n1')).toEqual({
      targets: ['n1', 'n7'],
      collapse: false,
    });
  });

  it('collapses onto a clicked node outside the selection', () => {
    expect(resolveArchNodeTargets(['n1', 'n7'], LIVE, 'n9')).toEqual({
      targets: ['n9'],
      collapse: true,
    });
  });

  it('collapses when nothing is selected', () => {
    expect(resolveArchNodeTargets([], LIVE, 'n1')).toEqual({ targets: ['n1'], collapse: true });
  });

  it('drops a selected id the current graph no longer holds', () => {
    expect(resolveArchNodeTargets(['n1', 'gone', 'n7'], LIVE, 'n1')).toEqual({
      targets: ['n1', 'n7'],
      collapse: false,
    });
  });

  it('collapses when every selected id is stale', () => {
    expect(resolveArchNodeTargets(['gone'], LIVE, 'n1')).toEqual({
      targets: ['n1'],
      collapse: true,
    });
  });
});

// Cross-menu invariants from docs/specs/archive/2026-06-23-context-menu-consistency.md §7.
describe('context-menu invariants', () => {
  const all = [
    ctx(),
    ctx({ model: PARENT, targets: [PARENT.id] }),
    ctx({ targets: THREE }),
    ctx({ model: PARENT, targets: [PARENT.id, 'n7'] }),
  ];

  it('never puts a separator before the first item', () => {
    for (const c of all) expect(buildArchNodeMenuItems(c)[0].separatorBefore).toBeFalsy();
  });

  it('keeps every danger item last in its menu', () => {
    for (const c of all) {
      const items = buildArchNodeMenuItems(c);
      const dangerAt = items.map((it, i) => (it.danger ? i : -1)).filter((i) => i >= 0);
      expect(dangerAt).toEqual([items.length - 1]);
    }
  });
});
