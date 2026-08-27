/**
 * Pure builder for the Explorer file-tree row menu. Mirrors editor-menu.ts / term-menu.ts:
 * decides WHICH items appear, what they act on and their enabled state from already-resolved
 * context, with no React state or tree lookups of its own — so the selection-scoping rules are
 * unit-testable as arrays. See docs/specs/2026-08-16-selection-aware-context-menus.md §4.1-§4.2.
 */

import { topLevelPaths } from '../src/drop-intent';
import { countLabel, type MenuTargets, resolveMenuTargets } from '../src/menu-selection';
import type { MenuItem } from './components/context-menu';
import {
  IconCopy,
  IconDoc,
  IconExternal,
  IconFolder,
  IconPencil,
  IconPlus,
  IconTerminal,
  IconTrash,
} from './icons';

/**
 * The shared rule, plus the Explorer's own nested-target de-dupe. The de-dupe runs on the
 * TARGETS, never on the membership test: a row inside a selected folder is still a selected row,
 * so right-clicking it must preserve the selection (§2 rule 1) even though `topLevelPaths` drops
 * it from what the menu acts on. Spec §4.1's snippet de-dupes first, which collapses that case.
 */
export function resolveExplorerTargets(
  orderedSelection: readonly string[],
  path: string,
): MenuTargets<string> {
  const { targets, collapse } = resolveMenuTargets(orderedSelection, path);
  return { targets: topLevelPaths(targets), collapse };
}

export interface ExplorerMenuContext {
  /** The right-clicked row. Its kind picks the variant (file vs folder); §16 #6. */
  node: { path: string; kind: 'dir' | 'file' };
  /** What the selection-scoped items act on: tree-ordered, top-level de-duped (§4.1). */
  targets: string[];
  /** Where create/paste land: a folder row targets itself, a file row its parent. */
  targetDir: string;
  /** The in-app cut/copy clipboard holds paths — gates Paste into folder. */
  hasClipboard: boolean;
  relativePath: (absPath: string) => string;
  /** Files open, folders expand — the caller fans out per kind, as Enter already does. */
  onOpen: (paths: string[]) => void;
  onOpenExternally: (path: string) => void;
  onOpenWith: (path: string) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRename: (node: { path: string; kind: 'dir' | 'file' }) => void;
  onCut: (paths: string[]) => void;
  onCopy: (paths: string[]) => void;
  onPaste: (dir: string) => void;
  onCopyText: (text: string) => void;
  onReveal: (path: string) => void;
  onOpenAsSession: (dir: string) => void;
  onDelete: (paths: string[]) => void;
}

export function buildExplorerMenuItems(ctx: ExplorerMenuContext): MenuItem[] {
  const { node, targets, targetDir } = ctx;
  const n = targets.length;
  // §2: an item that cannot meaningfully act on N>1 is visibly disabled, never silently narrowed.
  const many = n > 1;
  const items: MenuItem[] = [];

  if (node.kind === 'file') {
    items.push(
      { label: 'Open', icon: <IconDoc size={14} />, onClick: () => ctx.onOpen(targets) },
      {
        label: 'Open externally',
        icon: <IconExternal size={14} />,
        disabled: many,
        onClick: () => ctx.onOpenExternally(node.path),
      },
      {
        label: 'Open with…',
        icon: <IconExternal size={14} />,
        disabled: many,
        onClick: () => ctx.onOpenWith(node.path),
      },
      {
        label: 'New file…',
        icon: <IconPlus size={14} />,
        separatorBefore: true,
        disabled: many,
        onClick: () => ctx.onNewFile(targetDir),
      },
    );
  } else {
    items.push(
      {
        label: 'New file…',
        icon: <IconPlus size={14} />,
        disabled: many,
        onClick: () => ctx.onNewFile(targetDir),
      },
      {
        label: 'New folder…',
        icon: <IconFolder size={14} />,
        disabled: many,
        onClick: () => ctx.onNewFolder(targetDir),
      },
    );
  }

  items.push(
    {
      label: 'Rename…',
      icon: <IconPencil size={14} />,
      disabled: many,
      onClick: () => ctx.onRename(node),
    },
    { label: 'Cut', icon: <IconCopy size={14} />, onClick: () => ctx.onCut(targets) },
    { label: 'Copy', icon: <IconCopy size={14} />, onClick: () => ctx.onCopy(targets) },
    {
      label: 'Paste into folder',
      icon: <IconCopy size={14} />,
      disabled: many || !ctx.hasClipboard,
      onClick: () => ctx.onPaste(targetDir),
    },
    {
      label: 'Copy path',
      icon: <IconCopy size={14} />,
      separatorBefore: true,
      onClick: () => ctx.onCopyText(targets.join('\n')),
    },
    {
      label: 'Copy relative path',
      icon: <IconCopy size={14} />,
      onClick: () => ctx.onCopyText(targets.map(ctx.relativePath).join('\n')),
    },
    {
      label: 'Reveal in Explorer',
      icon: <IconExternal size={14} />,
      disabled: many,
      onClick: () => ctx.onReveal(node.path),
    },
  );

  if (node.kind === 'dir') {
    items.push({
      label: 'Open as new session',
      icon: <IconTerminal size={14} />,
      separatorBefore: true,
      disabled: many,
      title: many ? 'Select a single folder' : undefined,
      onClick: () => ctx.onOpenAsSession(node.path),
    });
  }

  items.push({
    label: countLabel('Delete', n, { verb: 'Delete', noun: 'items' }),
    icon: <IconTrash size={14} />,
    danger: true,
    separatorBefore: true,
    onClick: () => ctx.onDelete(targets),
  });

  return items;
}
