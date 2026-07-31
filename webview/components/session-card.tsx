import { useEffect, useState } from 'react';
import { dotClass, dotTitle, sessionRowClass } from '../../src/session-dot';
import {
  type ResolvedSessionIcon,
  SESSION_STATE_WORD,
  sessionIconState,
} from '../../src/session-icon';
import type { CardField } from '../../src/settings';
import type { Session } from '../../src/types';
import { fieldValue } from '../card-fields';
import { SessionGlyph } from '../icons';
import { shortAge } from '../relative-time';

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
 * One session card in the rail — the whole status system in a component.
 *
 * Every state carries a glyph AND a word (`.dot` + `.session__state`): the design's
 * accessibility story is that no state is expressed by colour alone, so there is no
 * separate a11y path to keep in sync. What each state adds below the subtitle is its
 * "so what": Busy gets the indeterminate meter, Needs you gets the prompt plus Go to /
 * Snooze, Review gets the diffstat and a way into Review changes.
 *
 * The meter is deliberately indeterminate (D7). The frames show a percentage; a CLI agent
 * emits no progress signal, and a number we made up would be a lie in the one place the
 * user is trusting the UI to tell them what an agent is doing.
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
  onOpenReview,
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
  onOpenReview?: () => void;
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
  // The age answers "how long has this been sitting there?" — only meaningful for the two
  // states that ARE sitting there. Busy/Needs you/Review are about now, by definition.
  const age = state === 'idle' || state === 'stale' ? shortAge(session.lastActiveAt) : '';
  const changed = session.git?.dirtyFiles ?? 0;

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
        <span className={dotClass(state)} title={dotTitle(state)} />
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
        {!editing && age && <span className="session__age">{age}</span>}
        {!editing && <span className="session__state">{SESSION_STATE_WORD[state]}</span>}
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
            onClick={(e) => {
              stop(e);
              onKill();
            }}
          >
            ✕
          </button>
        )}
      </div>

      {subtitle && (
        <span className="session__meta" title={subtitle}>
          <span className="session__metaitem">{subtitle}</span>
        </span>
      )}
      {detail && (
        <span className="session__path" title={session.cwd ?? session.projectPath}>
          {detail}
        </span>
      )}

      {state === 'busy' && (
        <span
          className="session__meter"
          role="progressbar"
          aria-label="Working"
          title="Working — no progress signal from a CLI agent, so the meter does not claim one"
        >
          <span className="session__meterfill" />
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

      {state === 'review' && (
        <button
          type="button"
          className="session__diffstat"
          title="Review changes"
          onClick={(e) => {
            stop(e);
            onOpenReview?.();
          }}
        >
          {changed > 0 ? `${changed} file${changed === 1 ? '' : 's'} changed` : 'Changes to review'}
        </button>
      )}
    </div>
  );
}
