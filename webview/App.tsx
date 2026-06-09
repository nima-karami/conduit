import type { HostToWebview, WebviewToHost } from '../src/protocol';
import { NewSessionBar } from './components/NewSessionBar';
import { SessionRow } from './components/SessionRow';

type State = Extract<HostToWebview, { type: 'state' }>;

export function App({
  state,
  error,
  post,
}: {
  state: State | null;
  error?: string;
  post: (m: WebviewToHost) => void;
}) {
  const groups = state?.groups ?? [];
  return (
    <div className="deck">
      <header className="deck__header">
        <h1>Agent Deck</h1>
      </header>
      {error && <div className="deck__error">{error}</div>}
      <NewSessionBar agents={state?.agents ?? []} post={post} />
      <main className="deck__groups">
        {groups.length === 0 && <p className="deck__empty">No sessions yet.</p>}
        {groups.map((g) => (
          <section key={g.projectPath} className="group">
            <h2 className="group__title">{g.projectPath}</h2>
            {g.sessions.map((s) => (
              <SessionRow key={s.id} session={s} post={post} />
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
