/**
 * Pure builders for the plan document's context menus.
 *
 * Unlike markdown-menu.ts / html-menu.ts, these return `MenuItem[]` directly rather than an
 * action-tagged spec: every row's effect is a closure the caller already holds (a reducer over
 * the graph, a comment patch), so an intermediate action enum would only be a lookup table the
 * caller has to unwrap again. The import is type-only, so this stays DOM-free and node-testable.
 */

import type { MenuItem } from './components/context-menu';

export function planBlockMenu(a: { onComment: () => void; onCopy: () => void }): MenuItem[] {
  return [
    { label: 'Comment', onClick: a.onComment },
    { label: 'Copy as markdown', onClick: a.onCopy },
  ];
}

export function flowNodeMenu(a: {
  onRename: () => void;
  onConnect: () => void;
  onMoveTo: () => void;
  onDelete: () => void;
}): MenuItem[] {
  return [
    { label: 'Rename', onClick: a.onRename, hint: 'Enter' },
    { label: 'Connect to…', onClick: a.onConnect, hint: 'Shift+C' },
    { label: 'Move to subgraph…', onClick: a.onMoveTo, hint: 'Shift+G' },
    { label: 'Delete', onClick: a.onDelete, danger: true, separatorBefore: true, hint: 'Del' },
  ];
}

export function flowEdgeMenu(a: { onRelabel: () => void; onDelete: () => void }): MenuItem[] {
  return [
    { label: 'Relabel', onClick: a.onRelabel, hint: 'Enter' },
    { label: 'Delete', onClick: a.onDelete, danger: true, separatorBefore: true, hint: 'Del' },
  ];
}

export function flowPaneMenu(a: {
  onAddNode: () => void;
  onAddSubgraph: () => void;
  onFit: () => void;
  onEditAsText: () => void;
}): MenuItem[] {
  return [
    { label: 'Add node', onClick: a.onAddNode },
    { label: 'Add subgraph', onClick: a.onAddSubgraph },
    { label: 'Fit', onClick: a.onFit, separatorBefore: true },
    { label: 'Edit as text', onClick: a.onEditAsText },
  ];
}

export function commentMenu(a: {
  onReply: () => void;
  onResolve: () => void;
  onReattach: (() => void) | null;
  onDelete: () => void;
}): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Reply', onClick: a.onReply },
    { label: 'Resolve', onClick: a.onResolve, hint: 'R' },
  ];
  if (a.onReattach) items.push({ label: 'Re-attach to…', onClick: a.onReattach });
  items.push({ label: 'Delete', onClick: a.onDelete, danger: true, separatorBefore: true });
  return items;
}
