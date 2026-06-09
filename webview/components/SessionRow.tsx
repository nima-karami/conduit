import { useState } from 'react';
import type { Session } from '../../src/types';
import type { WebviewToHost } from '../../src/protocol';

export function SessionRow({
  session,
  post,
}: {
  session: Session;
  post: (m: WebviewToHost) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);

  const commit = () => {
    const name = draft.trim();
    if (name && name !== session.name) {
      post({ type: 'rename', id: session.id, name });
    }
    setEditing(false);
  };

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(session.name);
    setEditing(true);
  };

  return (
    <div
      className={`row row--${session.status}`}
      onClick={() => !editing && post({ type: 'focus', id: session.id })}
    >
      {editing ? (
        <input
          className="row__edit"
          autoFocus
          value={draft}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <>
          <span className="row__name">{session.name}</span>
          <button className="row__edit-btn" title="Rename session" onClick={startEditing}>
            ✎
          </button>
        </>
      )}
      <span className={`badge badge--${session.status}`}>{session.status}</span>
      {session.status === 'stale' && (
        <button
          className="row__relaunch"
          title="Relaunch session"
          onClick={(e) => {
            e.stopPropagation();
            post({ type: 'relaunch', id: session.id });
          }}
        >
          ↻ Relaunch
        </button>
      )}
      <button
        className="row__kill"
        title="Kill session"
        onClick={(e) => {
          e.stopPropagation();
          post({ type: 'kill', id: session.id });
        }}
      >
        ✕
      </button>
    </div>
  );
}
