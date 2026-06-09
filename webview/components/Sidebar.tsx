import { useState } from 'react';
import { VMProject, VMCustomization } from '../viewModel';
import { IconPlus, IconSearch, IconSwap, IconFolder, IconChevron, customIcon } from '../icons';

export function Sidebar({
  projects,
  customizations,
  activeId,
  onSelect,
}: {
  projects: VMProject[];
  customizations: VMCustomization[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const [custOpen, setCustOpen] = useState(true);

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <span className="sidebar__title">Sessions</span>
        <div className="sidebar__head-actions">
          <button className="newbtn">
            <IconPlus size={13} /> New <kbd>⌘N</kbd>
          </button>
          <button className="iconbtn iconbtn--sm"><IconSwap size={14} /></button>
          <button className="iconbtn iconbtn--sm"><IconSearch size={14} /></button>
        </div>
      </div>

      <div className="sidebar__scroll">
        {projects.map((p) => (
          <div className="proj" key={p.name}>
            <div className="proj__label">{p.name}</div>
            {p.sessions.map((s) => (
              <button
                key={s.id}
                className={`session ${s.id === activeId ? 'session--active' : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <span className={`dot dot--${s.status}`} />
                <span className="session__body">
                  <span className="session__name">{s.name}</span>
                  <span className="session__meta">
                    <IconFolder size={12} className="session__folder" />
                    {typeof s.added === 'number' && (
                      <span className="diffstat">
                        <span className="diffstat--add">+{s.added}</span>{' '}
                        <span className="diffstat--del">-{s.removed}</span>
                      </span>
                    )}
                    <span className="session__time">{s.updatedAt}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="cust">
        <button className="cust__head" onClick={() => setCustOpen((v) => !v)}>
          <span>Customizations</span>
          <IconChevron size={14} className={`cust__chev ${custOpen ? 'cust__chev--open' : ''}`} />
        </button>
        {custOpen && (
          <div className="cust__list">
            {customizations.map((c) => {
              const Ico = customIcon[c.icon];
              return (
                <button className="cust__item" key={c.id}>
                  <Ico size={15} className="cust__icon" />
                  <span className="cust__label">{c.label}</span>
                  {typeof c.count === 'number' && <span className="cust__count">{c.count}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
