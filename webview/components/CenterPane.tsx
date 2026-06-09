import { TerminalPane } from './TerminalPane';
import { IconClose, IconPin, IconSparkle } from '../icons';

export function CenterPane({ sessionId, title, agent }: { sessionId: string; title: string; agent: string }) {
  return (
    <main className="center">
      <div className="tabbar">
        <div className="tab tab--active">
          <IconSparkle size={13} className="tab__spark" />
          <span>{title}</span>
          <span className="tab__agent">{agent}</span>
        </div>
        <div className="tabbar__actions">
          <button className="iconbtn iconbtn--sm"><IconPin size={14} /></button>
          <button className="iconbtn iconbtn--sm"><IconClose size={14} /></button>
        </div>
      </div>
      <div className="termwrap">
        {/* key forces a fresh terminal per session */}
        <TerminalPane key={sessionId} sessionId={sessionId} />
      </div>
    </main>
  );
}
