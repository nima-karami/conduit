import { LayoutGrid } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { SpaceRowModel } from '../../src/agent-tree';
import type { Rect } from '../../src/menu-position';
import type { AgentGroup } from '../../src/sidebar-state';
import { IconChevron, IconChevronDown } from '../icons';
import { SIDEBAR_STR } from '../sidebar-strings';
import { AgentMark } from './session-card';

export interface SpaceDropHandlers {
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

export type MenuAt = { x: number; y: number } | { anchor: Rect; keyboard: true };

const isMenuKey = (e: React.KeyboardEvent) =>
  e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);

/**
 * One row of the Spaces list (spec §3): a filter button, never a container of other buttons.
 * Branch and count describe it; the accessible name is exactly the Space's name.
 */
export function SpaceRow({
  row,
  name,
  detail,
  selected,
  renaming,
  dropCue,
  drop,
  onPick,
  onMenu,
  onRenameEnd,
  onStartRename,
}: {
  row: SpaceRowModel;
  /** The display name: All / No space come from the strings module, a Space's is verbatim. */
  name: string;
  /** Branch for a Space, "N agents" for All; null when unknown. */
  detail: string | null;
  selected: boolean;
  renaming: boolean;
  dropCue: boolean;
  drop: SpaceDropHandlers | undefined;
  onPick: () => void;
  onMenu: (at: MenuAt, returnFocus: HTMLElement | null) => void;
  onRenameEnd: (draft: string | null) => void;
  onStartRename: () => void;
}) {
  const descId = `space-desc-${row.key}`;
  const cls = ['space', `space--${row.hue}`, selected && 'space--on', dropCue && 'space--drop']
    .filter(Boolean)
    .join(' ');
  // Keyboard-opened menus anchor to the row, not to a pointer that isn't there.
  const keyMenu = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!isMenuKey(e)) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    onMenu(
      { anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, keyboard: true },
      e.currentTarget,
    );
  };
  const tile =
    row.key === 'all' ? (
      <span className="space__tile" aria-hidden>
        <LayoutGrid size={12} />
      </span>
    ) : (
      <span className="space__tile" aria-hidden>
        {row.letter}
      </span>
    );
  if (renaming)
    return (
      <div className={cls}>
        {tile}
        <RenameInput name={name} onEnd={onRenameEnd} />
      </div>
    );
  return (
    <button
      type="button"
      className={cls}
      data-space-id={row.key}
      aria-pressed={selected}
      aria-label={name}
      aria-describedby={detail ? descId : undefined}
      title={detail ? `${name}\n${detail}` : name}
      onClick={onPick}
      onKeyDown={keyMenu}
      onDoubleClick={row.projectId !== null ? onStartRename : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY }, null);
      }}
      onDragOver={drop?.onDragOver}
      onDragLeave={drop?.onDragLeave}
      onDrop={drop?.onDrop}
    >
      {tile}
      <span className="space__name">{name}</span>
      {detail && (
        <span className="space__detail" id={descId} dir="auto">
          {detail}
        </span>
      )}
      {row.state !== null && <AgentMark state={row.state} className="space__mark" still />}
    </button>
  );
}

/**
 * A status group's header (spec §4): the .proj__label band, now a fold button. The count is of
 * roots, never descendants.
 */
export function AgentGroupHeader({
  group,
  roots,
  folded,
  controls,
  onToggle,
}: {
  group: AgentGroup;
  roots: number;
  folded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`proj__label${group === 'blocked' ? ' proj__label--attn' : ''}`}
      data-agent-group={group}
      aria-expanded={!folded}
      aria-controls={controls}
      aria-label={SIDEBAR_STR.groupLabel(group, roots)}
      onClick={onToggle}
    >
      <span className="proj__chevron" aria-hidden>
        {folded ? <IconChevron size={9} /> : <IconChevronDown size={9} />}
      </span>
      <span className="proj__name">{SIDEBAR_STR.group(group)}</span>
      <span className="proj__count">{roots}</span>
    </button>
  );
}

/** Rename a Space in place, or name a new one (spec §3 Space menu). */
export function RenameInput({
  name,
  label,
  onEnd,
}: {
  name: string;
  label?: string;
  onEnd: (draft: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Enter unmounts the input, and a blur may follow; the first end wins.
  const ended = useRef(false);
  const end = (draft: string | null) => {
    if (ended.current) return;
    ended.current = true;
    onEnd(draft);
  };
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="proj__rename"
      aria-label={label ?? SIDEBAR_STR.renameSpaceLabel(name)}
      defaultValue={name}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => end(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          end(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          end(null);
        }
      }}
    />
  );
}
