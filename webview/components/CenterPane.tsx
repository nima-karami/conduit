import { useState } from 'react';
import { Block, Span, VMMessage } from '../viewModel';
import { IconPin, IconClose, IconPlus, IconArrowUp, IconSparkle } from '../icons';

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.t === 'code') return <code key={i} className="ic">{s.v}</code>;
        if (s.t === 'strong') return <strong key={i}>{s.v}</strong>;
        if (s.t === 'link') return <a key={i} className="lnk" href="#">{s.v}</a>;
        return <span key={i}>{s.v}</span>;
      })}
    </>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.type) {
    case 'h2':
      return <h2 className="md-h2">{b.text}</h2>;
    case 'h3':
      return <h3 className="md-h3">{b.text}</h3>;
    case 'p':
      return <p className="md-p"><Spans spans={b.spans} /></p>;
    case 'ul':
      return (
        <ul className="md-ul">
          {b.items.map((it, i) => <li key={i}><Spans spans={it} /></li>)}
        </ul>
      );
    case 'code':
      return (
        <div className="codeblock">
          <div className="codeblock__bar"><span>{b.lang}</span></div>
          <pre>
            {b.lines.map((ln, i) => (
              <div className="codeblock__ln" key={i}>
                <span className="codeblock__num">{i + 1}</span>
                <span className="codeblock__src">{ln}</span>
              </div>
            ))}
          </pre>
        </div>
      );
  }
}

export function CenterPane({ title, conversation }: { title: string; conversation: VMMessage[] }) {
  const [draft, setDraft] = useState('');
  return (
    <main className="center">
      <div className="tabbar">
        <div className="tab tab--active">
          <IconSparkle size={13} className="tab__spark" />
          <span>{title}</span>
        </div>
        <div className="tabbar__actions">
          <button className="iconbtn iconbtn--sm"><IconPin size={14} /></button>
          <button className="iconbtn iconbtn--sm"><IconClose size={14} /></button>
        </div>
      </div>

      <div className="transcript">
        {conversation.map((m, i) => (
          <article className={`msg msg--${m.role}`} key={i}>
            {m.blocks.map((b, j) => <BlockView b={b} key={j} />)}
          </article>
        ))}
      </div>

      <div className="composer">
        <div className="composer__box">
          <textarea
            className="composer__input"
            placeholder="Run local tasks with Claude, type # for context…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
          />
          <div className="composer__row">
            <button className="composer__add"><IconPlus size={14} /></button>
            <span className="composer__model"><IconSparkle size={12} /> Claude Haiku 4.5</span>
            <span className="composer__spacer" />
            <button className="composer__send" disabled={!draft.trim()}>
              <IconArrowUp size={15} />
            </button>
          </div>
        </div>
        <div className="composer__foot">
          <span><IconSparkle size={11} /> Claude</span>
          <span className="composer__dot">·</span>
          <span>Edit automatically</span>
        </div>
      </div>
    </main>
  );
}
