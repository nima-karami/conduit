import type { Session } from '../../src/types';
import type { WebviewToHost } from '../../src/protocol';

export function SessionRow({
  session,
  post,
}: {
  session: Session;
  post: (m: WebviewToHost) => void;
}) {
  return (
    <div
      className={`row row--${session.status}`}
      onClick={() => post({ type: 'focus', id: session.id })}
    >
      <span className="row__name">{session.name}</span>
      <span className={`badge badge--${session.status}`}>{session.status}</span>
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
