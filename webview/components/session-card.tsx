import { useEffect, useRef, useState } from 'react';
import type { AgentTreeRow } from '../../src/agent-tree';
import type { ResolvedSessionIcon } from '../../src/session-icon';
import { type AgentState, formatStateAge } from '../../src/sidebar-state';
import { canRelaunch } from '../../src/stale-sessions';
import type { Session } from '../../src/types';
import { IconChevron, IconClose, IconPin, SessionGlyph } from '../icons';
import { SIDEBAR_STR } from '../sidebar-strings';

interface AgentRowDragProps {
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

/**
 * A status mark: shape plus accessible state text, so no state is colour or motion alone
 * (spec §6). Working spins; reduced motion stills it in CSS.
 */
/** A Space row shows its most urgent member as a still dot, Working included (mockup). */
export function AgentMark({
  state,
  className,
  still = false,
}: {
  state: AgentState;
  className?: string;
  still?: boolean;
}) {
  return (
    <span
      className={`agentmark${className ? ` ${className}` : ''}`}
      title={SIDEBAR_STR.markTip(state)}
      aria-hidden
    >
      {state === 'working' && !still ? (
        <svg className="agentmark__spin" width="12" height="12" viewBox="0 0 16 16">
          <circle className="agentmark__track" cx="8" cy="8" r="6" />
          <path className="agentmark__arc" d="M8 2a6 6 0 0 1 6 6" />
        </svg>
      ) : (
        <span className={`agentmark__dot agentmark__dot--${state}`} />
      )}
    </span>
  );
}

/** One indent guide per ancestor level: does the vertical stroke carry on past this row? */
export type RowGuides = readonly boolean[];

export type AgentRowModel = Pick<
  AgentTreeRow,
  | 'depth'
  | 'state'
  | 'effectiveState'
  | 'stateSince'
  | 'childIds'
  | 'descendantCount'
  | 'childState'
  | 'folded'
>;

/**
 * One agent row of the tree (spec §6). It is the treeitem itself; the select button and the
 * action buttons are siblings inside it, never nested, and none of them takes a tab stop — the
 * tree's roving focus lands on the row and the menu reaches every action.
 */
export function AgentRow({
  session,
  row,
  icon,
  label,
  tooltip,
  space,
  now,
  selected,
  multiSelected = false,
  tabbable,
  pinned,
  guides,
  lastChild,
  editing,
  onEditStart,
  onEditEnd,
  onRename,
  onSelect,
  onPin,
  onClose,
  onRelaunch,
  onFold,
  onContextMenu,
  onFocus,
  drag,
}: {
  session: Session;
  row: AgentRowModel;
  icon: ResolvedSessionIcon;
  label: string;
  tooltip: string;
  /** Shown dim after the name, only under All. */
  space?: string;
  now: number;
  selected: boolean;
  /** Part of the Ctrl/Shift multi-selection (CON-167); independent of the active row. */
  multiSelected?: boolean;
  tabbable: boolean;
  pinned: boolean;
  guides: RowGuides;
  lastChild: boolean;
  editing: boolean;
  onEditStart: () => void;
  onEditEnd: () => void;
  onRename: (name: string) => void;
  onSelect: (e: React.MouseEvent) => void;
  onPin: () => void;
  onClose: () => void;
  onRelaunch: () => void;
  onFold: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onFocus?: () => void;
  drag?: AgentRowDragProps;
}) {
  const endRename = (draft: string | null) => {
    const next = draft?.trim();
    if (next && next !== session.name) onRename(next);
    onEditEnd();
  };

  const hasKids = row.childIds.length > 0;
  const child = row.depth > 0;
  const attention = row.effectiveState === 'blocked';
  const relaunchable = session.status !== 'running' && canRelaunch(session);
  const cls = [
    'session',
    child ? 'session--child' : 'session--root',
    selected && 'session--active',
    multiSelected && !selected && 'session--picked',
    // Selection wins over the attention wash outright (spec §6), so the two never compete in CSS.
    attention && !selected && !multiSelected && 'session--attention',
    row.state === 'stopped' && 'session--stopped',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      role="treeitem"
      data-sessionid={session.id}
      // Level 1 is the status group header: the tree is one flat list (see Sidebar).
      aria-level={row.depth + 2}
      aria-selected={selected || multiSelected}
      aria-expanded={hasKids ? !row.folded : undefined}
      aria-label={label}
      title={tooltip}
      tabIndex={tabbable ? 0 : -1}
      style={{ '--agent-depth': row.depth } as React.CSSProperties}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocus?.();
      }}
      onContextMenu={onContextMenu}
      draggable={!!drag && !editing}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
    >
      {guides.map((on, level) =>
        on ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: one guide per ancestor level, fixed by depth
            key={level}
            className="session__guide"
            style={{ '--guide-level': level } as React.CSSProperties}
            aria-hidden
          />
        ) : null,
      )}
      {child && (
        <span
          className={`session__elbow${lastChild ? '' : ' session__elbow--through'}`}
          aria-hidden
        />
      )}
      {editing ? (
        <span className="session__select">
          <SessionGlyph icon={icon} size={child ? 13 : 15} />
          <RenameInput
            name={session.name}
            label={SIDEBAR_STR.menu.rename}
            className="session__edit"
            onEnd={endRename}
          />
        </span>
      ) : (
        <button
          type="button"
          className="session__select"
          data-agent-action="select"
          aria-label={SIDEBAR_STR.goTo(session.name)}
          tabIndex={-1}
          onClick={onSelect}
        >
          <SessionGlyph icon={icon} size={child ? 13 : 15} />
          <span className="session__label">
            <span
              className="session__name"
              onDoubleClick={(e) => {
                e.stopPropagation();
                onEditStart();
              }}
            >
              {session.name}
            </span>
            {space !== undefined && <span className="session__space">{` · ${space}`}</span>}
          </span>
        </button>
      )}
      {hasKids && (
        <button
          type="button"
          className="session__fold"
          data-agent-action="fold"
          aria-expanded={!row.folded}
          aria-label={row.folded ? SIDEBAR_STR.showKids : SIDEBAR_STR.hideKids}
          title={row.folded ? SIDEBAR_STR.hiddenKids(row.descendantCount) : SIDEBAR_STR.hideKids}
          tabIndex={-1}
          onClick={onFold}
        >
          {row.folded && (
            <span className={`session__kids session__kids--${row.childState ?? 'idle'}`}>
              {row.descendantCount}
            </span>
          )}
          <IconChevron
            size={9}
            className={`session__chev${row.folded ? '' : ' session__chev--open'}`}
          />
        </button>
      )}
      {!editing && (
        <span className="session__trail">
          <span className="session__age" aria-hidden>
            {formatStateAge(row.stateSince, now)}
          </span>
          <span className="session__acts">
            {relaunchable && (
              <button
                type="button"
                className="session__relaunch"
                data-agent-action="relaunch"
                aria-label={SIDEBAR_STR.relaunch(session.name)}
                title={SIDEBAR_STR.relaunch(session.name)}
                tabIndex={-1}
                onClick={onRelaunch}
              >
                ↻
              </button>
            )}
            <button
              type="button"
              className={`session__pin${pinned ? ' session__pin--on' : ''}`}
              data-agent-action="pin"
              aria-label={pinned ? SIDEBAR_STR.unpin : SIDEBAR_STR.pin}
              title={pinned ? SIDEBAR_STR.unpin : SIDEBAR_STR.pin}
              tabIndex={-1}
              onClick={onPin}
            >
              <IconPin size={12} />
            </button>
            <button
              type="button"
              className="session__kill"
              data-agent-action="close"
              aria-label={SIDEBAR_STR.close(session.name)}
              title={SIDEBAR_STR.close(session.name)}
              tabIndex={-1}
              onClick={onClose}
            >
              <IconClose size={12} />
            </button>
          </span>
        </span>
      )}
      <AgentMark state={row.state} className="session__mark" />
    </div>
  );
}

const PREVIEW_ROW: AgentRowModel = {
  depth: 0,
  state: 'working',
  effectiveState: 'working',
  stateSince: 0,
  childIds: [],
  descendantCount: 0,
  childState: null,
  folded: false,
};

/** The Settings preview: a real AgentRow over a fixed sample session (spec §6). */
export function AgentRowPreview() {
  const [sample] = useState(() => {
    const now = Date.now();
    const session: Session = {
      id: 'preview',
      name: 'Portfolio Redesign',
      agentId: 'preview',
      home: 'G:/awby/projects/nextjs-portfolio',
      roots: [],
      status: 'running',
      busy: true,
      createdAt: now - 4 * 60_000,
      lastActiveAt: now - 2 * 60_000,
    };
    return { session, now, row: { ...PREVIEW_ROW, stateSince: now - 2 * 60_000 } };
  });
  const noop = () => {};
  return (
    <div className="cardcfg__card" inert>
      <AgentRow
        session={sample.session}
        row={sample.row}
        icon={{ type: 'kind', kind: 'claude' }}
        label={SIDEBAR_STR.rowLabel({
          name: sample.session.name,
          state: 'working',
          descendantNeedsYou: false,
        })}
        tooltip=""
        now={sample.now}
        selected
        tabbable={false}
        pinned={false}
        guides={[]}
        lastChild
        editing={false}
        onEditStart={noop}
        onEditEnd={noop}
        onRename={noop}
        onSelect={noop}
        onPin={noop}
        onClose={noop}
        onRelaunch={noop}
        onFold={noop}
      />
    </div>
  );
}

/** Rename in place: a Space, a new Space's name, or an agent row (spec §3, §6). */
export function RenameInput({
  name,
  label,
  className = 'proj__rename',
  onEnd,
}: {
  name: string;
  label?: string;
  className?: string;
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
      className={className}
      aria-label={label ?? SIDEBAR_STR.renameSpaceLabel(name)}
      defaultValue={name}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => end(e.currentTarget.value)}
      onKeyDown={(e) => {
        // The tree's own keys must not see typing.
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          end(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          end(null);
        }
      }}
    />
  );
}
