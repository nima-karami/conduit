import { useEffect, useRef } from 'react';
import type { Rect } from '../../src/menu-position';
import { STANDALONE_KEY } from '../../src/session-groups';
import { IconChevron, IconChevronDown, IconPlus } from '../icons';

export type HeaderDropCue = 'before' | 'into' | null;

export interface HeaderDragHandlers {
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

type MenuAt = { x: number; y: number } | { anchor: Rect; keyboard: true };

const isMenuKey = (e: React.KeyboardEvent) =>
  e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);

const stopDrag = (e: React.DragEvent) => e.stopPropagation();

/** One group header of the sessions rail (mf-sidebar spec §2.2). */
export function ProjectGroupHeader({
  groupKey,
  name,
  labelId,
  count,
  collapsed,
  attn,
  renaming,
  dropCue,
  drag,
  onToggle,
  onNew,
  onMenu,
  onStartRename,
  onRenameEnd,
}: {
  groupKey: string;
  name: string;
  labelId: string;
  count: number;
  collapsed: boolean;
  attn: boolean;
  renaming: boolean;
  dropCue: HeaderDropCue;
  drag: HeaderDragHandlers | undefined;
  onToggle: () => void;
  onNew: () => void;
  onMenu: (at: MenuAt, returnFocus: HTMLElement | null) => void;
  onStartRename: () => void;
  onRenameEnd: (draft: string | null) => void;
}) {
  const labelRef = useRef<HTMLDivElement>(null);
  const standalone = groupKey === STANDALONE_KEY;
  const addLabel = standalone ? 'New standalone session' : `New session in ${name}`;

  // Keyboard-opened menus anchor to the header, not to a pointer that isn't there.
  const keyMenu = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!isMenuKey(e) || !labelRef.current) return;
    e.preventDefault();
    const r = labelRef.current.getBoundingClientRect();
    onMenu(
      { anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, keyboard: true },
      e.currentTarget,
    );
  };

  const cls = `proj__label${dropCue === 'before' ? ' proj__label--dropbefore' : ''}${
    dropCue === 'into' ? ' proj__label--dropinto' : ''
  }`;

  return (
    <div
      ref={labelRef}
      className={cls}
      title={name}
      draggable={!!drag?.onDragStart && !renaming}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      onContextMenu={(e) => {
        // Also keeps the pane menu, which bails on defaultPrevented, from opening underneath.
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY }, null);
      }}
    >
      <button
        type="button"
        className="proj__chevron"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onKeyDown={keyMenu}
        onDragStart={stopDrag}
      >
        {collapsed ? <IconChevron size={12} /> : <IconChevronDown size={12} />}
      </button>
      {renaming ? (
        <RenameInput id={labelId} name={name} onEnd={onRenameEnd} />
      ) : (
        <span
          className="proj__name"
          id={labelId}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onStartRename();
          }}
        >
          {name}
        </span>
      )}
      <span className="proj__slot">
        <span className={`proj__count${attn ? ' proj__count--attn' : ''}`}>{count}</span>
        <button
          type="button"
          className="proj__add"
          aria-label={addLabel}
          title={addLabel}
          onClick={(e) => {
            e.stopPropagation();
            onNew();
          }}
          onKeyDown={keyMenu}
          onDragStart={stopDrag}
        >
          <IconPlus size={12} />
        </button>
      </span>
    </div>
  );
}

function RenameInput({
  id,
  name,
  onEnd,
}: {
  id: string;
  name: string;
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
      id={id}
      className="proj__rename"
      aria-label={`Rename ${name}`}
      defaultValue={name}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onDragStart={stopDrag}
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
