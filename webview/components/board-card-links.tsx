import type { BoardTicket } from '../../src/board';
import { linkedRowLabel, linkedRowName, linkedRowState } from '../../src/board-linkage';
import type { Session } from '../../src/types';

// `title` is set unconditionally: truncation is a layout fact the markup can't know (plan
// 2026-09-23-mf-board, Spec staleness §7).

/** A card's read-only tracker row (spec 2026-09-23-mf-board §3.1); null without a ticket. */
export function TicketHeader({ ticket }: { ticket: BoardTicket | undefined }) {
  if (!ticket) return null;
  return (
    <div className="bcard__ticket">
      {ticket.key && (
        <span className="bcard__tkey" dir="auto" title={ticket.key}>
          {ticket.key}
        </span>
      )}
      {ticket.source && (
        <span className="bcard__tsource" dir="auto" title={ticket.source}>
          {ticket.source}
        </span>
      )}
      {ticket.status && (
        <span className="bcard__tstatus" dir="auto" title={ticket.status}>
          {ticket.status}
        </span>
      )}
    </div>
  );
}

export function LinkedSessions({
  sessions,
  agentLabel,
  onActivate,
}: {
  sessions: readonly Session[];
  agentLabel: (agentId: string) => string;
  onActivate: (sessionId: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <ul className="bcard__sessions" aria-label="Linked sessions">
      {sessions.map((s) => {
        const label = agentLabel(s.agentId);
        const name = linkedRowName(s);
        return (
          <li key={s.id} className="bcard__sessionitem">
            <button
              type="button"
              className={`bcard__session bcard__session--${linkedRowState(s)}`}
              aria-label={linkedRowLabel(s, label)}
              onClick={(e) => {
                e.stopPropagation();
                onActivate(s.id);
              }}
            >
              <span className="bcard__sdot" aria-hidden="true" />
              <span className="bcard__sname" dir="auto" title={name}>
                {name}
              </span>
              <span className="bcard__sagent" dir="auto" title={label}>
                {label}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
