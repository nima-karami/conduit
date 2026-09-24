import { useEffect, useState, useSyncExternalStore } from 'react';
import { sessionRowClass } from '../../src/session-dot';
import {
  type ResolvedSessionIcon,
  resolveSessionIcon,
  SESSION_STATE_WORD,
  sessionIconState,
} from '../../src/session-icon';
import type { CardField } from '../../src/settings';
import type { Session } from '../../src/types';
import { fieldValue } from '../card-fields';
import { IconClock, IconClose, SessionGlyph } from '../icons';
import { getTimerSnapshot, subscribeTimers, waitingCountFor } from '../timer-store';

export interface CardRoles {
  title: CardField;
  subtitle: CardField;
  detail: CardField;
}

export interface SessionDragProps {
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

/**
 * One session card in the rail (the 9b card, mf-sidebar spec §2.3): glyph, name, the
 * subtitle/detail fields, the status pill and a hover ×. Every state carries the glyph AND
 * a word, so no state is colour alone. The only per-state extras are the ones that are
 * actions: Go to / Snooze while it needs you, ↻ while stale, and the timer chip.
 */
export function SessionCard({
  session,
  agentLabel,
  resolvedIcon,
  active,
  onSelect,
  onKill,
  onRename,
  onRelaunch,
  onContextMenu,
  onSnooze,
  editing,
  onEditStart,
  onEditEnd,
  roles,
  drag,
  dropTarget,
}: {
  session: Session;
  agentLabel: string;
  resolvedIcon: ResolvedSessionIcon;
  active: boolean;
  onSelect: () => void;
  onKill: () => void;
  onRename: (name: string) => void;
  onRelaunch: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onSnooze: () => void;
  editing: boolean;
  onEditStart: () => void;
  onEditEnd: () => void;
  roles: CardRoles;
  drag?: SessionDragProps;
  dropTarget?: boolean;
}) {
  const [draft, setDraft] = useState(session.name);
  useEffect(() => {
    if (editing) setDraft(session.name);
  }, [editing, session.name]);
  const commit = () => {
    if (draft.trim() && draft.trim() !== session.name) onRename(draft.trim());
    onEditEnd();
  };

  const state = sessionIconState(session);
  const titleText = fieldValue(session, agentLabel, roles.title) || session.name;
  const subtitle = roles.subtitle !== 'none' ? fieldValue(session, agentLabel, roles.subtitle) : '';
  const detail = roles.detail !== 'none' ? fieldValue(session, agentLabel, roles.detail) : '';
  const timerSnap = useSyncExternalStore(subscribeTimers, getTimerSnapshot, getTimerSnapshot);
  const waitingTimers = waitingCountFor(timerSnap, session.id);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      className={sessionRowClass({ selected: active, state, dropTarget: !!dropTarget })}
      data-sessionid={session.id}
      onClick={() => !editing && onSelect()}
      onContextMenu={onContextMenu}
      draggable={!!drag && !editing}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      <div className="session__head">
        <SessionGlyph icon={resolvedIcon} size={15} />
        {editing ? (
          <input
            className="session__edit"
            autoFocus
            value={draft}
            onClick={stop}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') onEditEnd();
            }}
          />
        ) : (
          <span
            className="session__name"
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEditStart();
            }}
          >
            {titleText}
          </span>
        )}
        {!editing && <span className="session__state">{SESSION_STATE_WORD[state]}</span>}
        {!editing && waitingTimers > 0 && (
          <>
            {/* The glyph is decorative; the accessible name is carried in text, because the card
                row is a div and an aria-label on it would not be exposed (§9). */}
            <span
              className="session__timer"
              aria-hidden
              title={`${waitingTimers} timed message${waitingTimers === 1 ? '' : 's'} waiting`}
            >
              <IconClock size={11} />
              {waitingTimers}
            </span>
            <span className="sr-only">
              {`${waitingTimers} timed message${waitingTimers === 1 ? '' : 's'} waiting`}
            </span>
          </>
        )}
        {/* Row actions keep their slot at all times and only fade in — revealing them by
            display would reflow the name on every hover. */}
        {session.status === 'stale' && (
          <button
            type="button"
            className="session__relaunch"
            title="Relaunch"
            onClick={(e) => {
              stop(e);
              onRelaunch();
            }}
          >
            ↻
          </button>
        )}
        {!editing && (
          <button
            type="button"
            className="session__kill"
            title="Close session"
            aria-label="Close session"
            onClick={(e) => {
              stop(e);
              onKill();
            }}
          >
            <IconClose size={12} />
          </button>
        )}
      </div>

      {subtitle && (
        <span className="session__meta" title={subtitle}>
          <span className="session__metaitem">{subtitle}</span>
        </span>
      )}
      {detail && (
        <span className="session__path" title={session.cwd ?? session.home}>
          {detail}
        </span>
      )}

      {state === 'attention' && (
        <div className="session__actions">
          <button
            type="button"
            className="session__btn session__btn--primary"
            onClick={(e) => {
              stop(e);
              onSelect();
            }}
          >
            Go to
          </button>
          {/* Snooze silences the card for 10 minutes (D16). It never answers or kills the
              prompt — the agent is still waiting, you have just said "not now". */}
          <button
            type="button"
            className="session__btn"
            title="Silence this session for 10 minutes"
            onClick={(e) => {
              stop(e);
              onSnooze();
            }}
          >
            Snooze
          </button>
        </div>
      )}
    </div>
  );
}

const PREVIEW_AGENT_LABEL = 'PowerShell 7';

/** The Settings "Session card" preview: a real SessionCard over a fixed sample session (AC 13). */
export function SessionCardPreview({ roles }: { roles: CardRoles }) {
  const [sample] = useState<Session>(() => {
    const now = Date.now();
    return {
      id: 'preview',
      name: 'Portfolio Redesign',
      agentId: 'preview',
      home: 'G:/awby/projects/nextjs-portfolio',
      roots: [],
      status: 'running',
      createdAt: now - 4 * 60_000,
      lastActiveAt: now - 2 * 60_000,
      lastLine: 'Edit webview/styles.css',
      worktree: 'feature/auth',
    };
  });
  const noop = () => {};
  return (
    <div className="cardcfg__card" inert>
      <SessionCard
        session={sample}
        agentLabel={PREVIEW_AGENT_LABEL}
        resolvedIcon={resolveSessionIcon(sample, [])}
        active
        onSelect={noop}
        onKill={noop}
        onRename={noop}
        onRelaunch={noop}
        onSnooze={noop}
        editing={false}
        onEditStart={noop}
        onEditEnd={noop}
        roles={roles}
      />
    </div>
  );
}
