import { agentIconKindFromText } from '../../src/agent-icon';
import type { Presence } from '../../src/conduit-mcp/types';
import type { ResolvedSessionIcon } from '../../src/session-icon';
import type { AgentState } from '../../src/sidebar-state';
import { SessionGlyph } from '../icons';
import { MACHINES_STR } from '../machines-strings';
import type { RemoteSessionRow as Row } from '../remote-sessions';
import { AgentMark, type RowGuides } from './session-card';

/** Presence as the state mark's shape: busy is working, idle is a ring, exited is stopped. */
const MARK: Record<Presence, AgentState> = { busy: 'working', idle: 'idle', exited: 'stopped' };

/**
 * One remote session. It is a treeitem in both the Agents tree and under its machine, so it
 * carries the machine as text ("on win-box") and never as colour alone (plan decision 7). The
 * class is `remote-session`, not `session`, so the local row selectors never see it.
 */
export function RemoteSessionRow({
  row,
  depth,
  level,
  guides,
  lastChild,
  selected,
  tabbable,
  onSelect,
  onFocus,
}: {
  row: Row;
  /** Indent: one step under the lead (Agents) or under the machine (Machines). */
  depth: number;
  /** aria-level, one more than the lead's own row (Agents) or 2 under a machine. */
  level: number;
  guides: RowGuides;
  lastChild: boolean;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onFocus?: () => void;
}) {
  const { session } = row;
  const label = session.label || session.sessionId;
  const icon: ResolvedSessionIcon = {
    type: 'kind',
    kind: agentIconKindFromText(session.agent) ?? 'terminal',
  };
  const cls = ['remote-session', selected && 'remote-session--active'].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      role="treeitem"
      data-remote-id={row.id}
      aria-level={level}
      aria-selected={selected}
      aria-label={MACHINES_STR.remoteRowLabel({
        label,
        presence: session.presence,
        machine: row.machineName,
      })}
      tabIndex={tabbable ? 0 : -1}
      style={{ '--agent-depth': depth } as React.CSSProperties}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocus?.();
      }}
    >
      {guides.map((on, i) =>
        on ? (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: one guide per ancestor level, fixed by depth
            key={i}
            className="session__guide"
            style={{ '--guide-level': i } as React.CSSProperties}
            aria-hidden
          />
        ) : null,
      )}
      {depth > 0 && (
        <span
          className={`session__elbow${lastChild ? '' : ' session__elbow--through'}`}
          aria-hidden
        />
      )}
      <button
        type="button"
        className="session__select"
        data-agent-action="select"
        aria-label={label}
        tabIndex={-1}
        onClick={onSelect}
      >
        <SessionGlyph icon={icon} size={13} />
        <span className="session__label">
          <span className="session__name">{label}</span>
          <span className="remote-session__presence">
            {MACHINES_STR.presence(session.presence)}
          </span>
        </span>
      </button>
      <span className="machine-badge">{MACHINES_STR.badge(row.machineName)}</span>
      <AgentMark state={MARK[session.presence]} className="session__mark" />
    </div>
  );
}
