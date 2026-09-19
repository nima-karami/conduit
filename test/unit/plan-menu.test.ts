import { describe, expect, it, vi } from 'vitest';
import {
  commentMenu,
  flowEdgeMenu,
  flowNodeMenu,
  flowPaneMenu,
  planBlockMenu,
} from '../../webview/plan-menu';

const noop = () => {};

const nodeArgs = () => ({
  onRename: vi.fn(),
  onConnect: vi.fn(),
  onMoveTo: vi.fn(),
  onDelete: vi.fn(),
});

describe('flowNodeMenu', () => {
  it('node menu order is Rename, Connect to…, Move to subgraph…, Delete with Delete danger', () => {
    const items = flowNodeMenu(nodeArgs());
    expect(items.map((i) => i.label)).toEqual([
      'Rename',
      'Connect to…',
      'Move to subgraph…',
      'Delete',
    ]);
    expect(items[items.length - 1].label).toBe('Delete');
    expect(items[items.length - 1].danger).toBe(true);
    expect(items.filter((i) => i.danger).map((i) => i.label)).toEqual(['Delete']);
  });

  it('wires each row to its own callback', () => {
    const a = nodeArgs();
    for (const item of flowNodeMenu(a)) item.onClick();
    expect(a.onRename).toHaveBeenCalledTimes(1);
    expect(a.onConnect).toHaveBeenCalledTimes(1);
    expect(a.onMoveTo).toHaveBeenCalledTimes(1);
    expect(a.onDelete).toHaveBeenCalledTimes(1);
  });

  it('separates the destructive row from the edits and never leads with a separator', () => {
    const items = flowNodeMenu(nodeArgs());
    expect(items[0].separatorBefore).toBeFalsy();
    expect(items.filter((i) => i.separatorBefore).map((i) => i.label)).toEqual(['Delete']);
  });
});

describe('flowEdgeMenu', () => {
  it('offers Relabel then Delete, with Delete last and danger', () => {
    const items = flowEdgeMenu({ onRelabel: noop, onDelete: noop });
    expect(items.map((i) => i.label)).toEqual(['Relabel', 'Delete']);
    expect(items[items.length - 1].danger).toBe(true);
  });
});

describe('flowPaneMenu', () => {
  it('pane menu has Add node first', () => {
    const items = flowPaneMenu({
      onAddNode: noop,
      onAddSubgraph: noop,
      onFit: noop,
      onEditAsText: noop,
    });
    expect(items[0].label).toBe('Add node');
    expect(items.map((i) => i.label)).toEqual(['Add node', 'Add subgraph', 'Fit', 'Edit as text']);
    expect(items.some((i) => i.danger)).toBe(false);
  });

  it('wires each row to its own callback', () => {
    const args = {
      onAddNode: vi.fn(),
      onAddSubgraph: vi.fn(),
      onFit: vi.fn(),
      onEditAsText: vi.fn(),
    };
    for (const item of flowPaneMenu(args)) item.onClick();
    expect(args.onAddNode).toHaveBeenCalledTimes(1);
    expect(args.onAddSubgraph).toHaveBeenCalledTimes(1);
    expect(args.onFit).toHaveBeenCalledTimes(1);
    expect(args.onEditAsText).toHaveBeenCalledTimes(1);
  });
});

describe('planBlockMenu', () => {
  it('offers Comment then Copy', () => {
    const items = planBlockMenu({ onComment: noop, onCopy: noop });
    expect(items.map((i) => i.label)).toEqual(['Comment', 'Copy as markdown']);
    expect(items.some((i) => i.danger)).toBe(false);
  });
});

describe('commentMenu', () => {
  it('comment menu omits Re-attach when null', () => {
    const labels = commentMenu({
      onReply: noop,
      onResolve: noop,
      onReattach: null,
      onDelete: noop,
    }).map((i) => i.label);
    expect(labels).not.toContain('Re-attach to…');
    expect(labels).toEqual(['Reply', 'Resolve', 'Delete']);
  });

  it('includes Re-attach when a handler is given, still with Delete last and danger', () => {
    const items = commentMenu({
      onReply: noop,
      onResolve: noop,
      onReattach: noop,
      onDelete: noop,
    });
    expect(items.map((i) => i.label)).toEqual(['Reply', 'Resolve', 'Re-attach to…', 'Delete']);
    expect(items[items.length - 1].label).toBe('Delete');
    expect(items[items.length - 1].danger).toBe(true);
  });

  it('calls the re-attach handler that was passed, not another row', () => {
    const onReattach = vi.fn();
    const onDelete = vi.fn();
    const items = commentMenu({ onReply: noop, onResolve: noop, onReattach, onDelete });
    items.find((i) => i.label === 'Re-attach to…')?.onClick();
    expect(onReattach).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
