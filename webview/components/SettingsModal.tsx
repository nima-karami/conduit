import { useEffect, useState } from 'react';
import { useSettings } from '../settings';
import { THEMES, UI_FONTS, MONO_FONTS } from '../themes';
import { SHORTCUTS } from '../shortcuts';
import { IconClose } from '../icons';
import type { AppSettings, Background, Density, SessionCard } from '../../src/settings';

type Tab = 'general' | 'appearance' | 'shortcuts';

const CARD_OPTS: { id: SessionCard; label: string; hint: string }[] = [
  { id: 'comfortable', label: 'Comfortable', hint: 'Name, agent, time' },
  { id: 'compact', label: 'Compact', hint: 'Name + status only' },
  { id: 'detailed', label: 'Detailed', hint: 'Adds folder & path' },
];

const BG_OPTS: { id: Background; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'grid', label: 'Grid' },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, update } = useSettings();
  const [tab, setTab] = useState<Tab>('appearance');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head settings__head">
          <div>
            <span className="modal__title">Settings</span>
            <span className="modal__sub">Tune the look and behaviour of Agent Deck</span>
          </div>
          <button className="iconbtn" aria-label="Close settings" onClick={onClose}><IconClose size={15} /></button>
        </div>

        <div className="settings__body">
          <nav className="settings__nav">
            {(['general', 'appearance', 'shortcuts'] as Tab[]).map((t) => (
              <button
                key={t}
                className={`settings__navitem ${tab === t ? 'settings__navitem--active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </nav>

          <div className="settings__pane">
            {tab === 'appearance' && <Appearance settings={settings} update={update} />}
            {tab === 'general' && <General />}
            {tab === 'shortcuts' && <Shortcuts />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="set">
      <div className="set__label">
        <span className="set__title">{title}</span>
        {desc && <span className="set__desc">{desc}</span>}
      </div>
      <div className="set__control">{children}</div>
    </section>
  );
}

function Appearance({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  return (
    <>
      <Section title="Theme" desc="Colour palette for the whole app">
        <div className="swatches">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`swatch ${settings.theme === t.id ? 'swatch--active' : ''}`}
              onClick={() => update({ theme: t.id })}
              title={t.label}
            >
              <span className="swatch__chips">
                {t.swatch.map((c, i) => <span key={i} style={{ background: c }} />)}
              </span>
              <span className="swatch__name">{t.label}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Interface font">
        <select className="modal__select" value={settings.fontUi} onChange={(e) => update({ fontUi: e.target.value })}>
          {UI_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </Section>

      <Section title="Monospace font" desc="Code, paths, terminal labels">
        <select className="modal__select" value={settings.fontMono} onChange={(e) => update({ fontMono: e.target.value })}>
          {MONO_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </Section>

      <Section title="Density">
        <Segmented<Density>
          value={settings.density}
          options={[{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }]}
          onChange={(v) => update({ density: v })}
        />
      </Section>

      <Section title="Session card" desc="How much each session row shows">
        <Segmented<SessionCard>
          value={settings.sessionCard}
          options={CARD_OPTS.map((c) => ({ id: c.id, label: c.label }))}
          onChange={(v) => update({ sessionCard: v })}
        />
      </Section>

      <Section title="Background" desc="Animated backdrop behind the panels">
        <Segmented<Background>
          value={settings.background}
          options={BG_OPTS}
          onChange={(v) => update({ background: v })}
        />
      </Section>
    </>
  );
}

function Segmented<T extends string>({
  value, options, onChange,
}: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.id} className={`seg__btn ${value === o.id ? 'seg__btn--active' : ''}`} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function General() {
  return (
    <>
      <Section title="About" desc="Agent Deck — a desktop home for your CLI agents">
        <span className="set__static">Version 0.1.0</span>
      </Section>
      <Section title="Configuration" desc="Custom agents live in agents.json in your user data folder">
        <span className="set__static">Settings persist automatically</span>
      </Section>
    </>
  );
}

function Shortcuts() {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <div className="shortcuts">
      {groups.map((g) => (
        <div className="shortcuts__group" key={g}>
          <div className="shortcuts__gtitle">{g}</div>
          {SHORTCUTS.filter((s) => s.group === g).map((s) => (
            <div className="shortcuts__row" key={s.id}>
              <span className="shortcuts__desc">{s.description}</span>
              <span className="shortcuts__keys">
                {s.keys.map((k) => <kbd key={k}>{k}</kbd>)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
