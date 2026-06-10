import { useEffect, useState } from 'react';
import { useSettings } from '../settings';
import { THEMES, UI_FONTS, MONO_FONTS } from '../themes';
import { SHORTCUTS } from '../shortcuts';
import { IconClose } from '../icons';
import type { AppSettings, Background, Density } from '../../src/settings';
import type { AgentDefinition } from '../../src/types';

type Tab = 'general' | 'appearance' | 'shortcuts';

const CARD_FIELDS: { key: keyof AppSettings; label: string }[] = [
  { key: 'cardAgent', label: 'Agent' },
  { key: 'cardTime', label: 'Timestamp' },
  { key: 'cardStatusText', label: 'Status text' },
  { key: 'cardPath', label: 'Project path' },
  { key: 'cardWorktree', label: 'Worktree' },
];

const BG_OPTS: { id: Background; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'grid', label: 'Grid' },
];

export function SettingsModal({ agents, initialTab = 'general', onClose }: { agents: AgentDefinition[]; initialTab?: Tab; onClose: () => void }) {
  const { settings, update } = useSettings();
  const [tab, setTab] = useState<Tab>(initialTab);

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
            {tab === 'general' && <General settings={settings} update={update} agents={agents} />}
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

      <SessionCardSection settings={settings} update={update} />

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

function SessionCardSection({
  settings, update,
}: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const meta: string[] = [];
  if (settings.cardAgent) meta.push('PowerShell 7');
  if (settings.cardTime) meta.push('4 min ago');
  if (settings.cardStatusText) meta.push('running');
  if (settings.cardWorktree) meta.push('feature/auth');

  return (
    <section className="set set--col">
      <div className="set__label">
        <span className="set__title">Session card</span>
        <span className="set__desc">Choose exactly what each session row shows</span>
      </div>
      <div className="cardcfg">
        <div className="cardcfg__toggles">
          {CARD_FIELDS.map((f) => (
            <div className="cardcfg__row" key={f.key as string}>
              <span>{f.label}</span>
              <Toggle
                value={settings[f.key] as boolean}
                onChange={(v) => update({ [f.key]: v } as Partial<AppSettings>)}
              />
            </div>
          ))}
        </div>
        <div className="cardcfg__preview">
          <span className="cardcfg__previewlabel">Preview</span>
          <div className="session session--active cardcfg__card">
            <span className="dot dot--active" />
            <span className="session__body">
              <span className="session__name">Portfolio Redesign</span>
              {meta.length > 0 && (
                <span className="session__meta">
                  {meta.map((m, i) => (
                    <span key={i}>
                      {i > 0 && <span className="session__dotsep">·</span>}
                      <span className="session__metaitem">{m}</span>
                    </span>
                  ))}
                </span>
              )}
              {settings.cardPath && <span className="session__path">nextjs-portfolio</span>}
            </span>
          </div>
        </div>
      </div>
    </section>
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

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`toggle ${value ? 'toggle--on' : ''}`}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    >
      <span className="toggle__knob" />
    </button>
  );
}

function General({
  settings, update, agents,
}: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; agents: AgentDefinition[] }) {
  return (
    <>
      <Section title="Default terminal" desc="Pre-selected when opening a folder with no remembered shell">
        <select className="modal__select" value={settings.defaultAgentId} onChange={(e) => update({ defaultAgentId: e.target.value })}>
          <option value="">Ask each time</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </Section>
      <Section title="Restore sessions on launch" desc="Reopen previous sessions (as stale) when the app starts">
        <Toggle value={settings.restoreSessions} onChange={(v) => update({ restoreSessions: v })} />
      </Section>
      <Section title="Auto-switch to new session" desc="Focus a session as soon as it's created">
        <Toggle value={settings.autoSwitchSession} onChange={(v) => update({ autoSwitchSession: v })} />
      </Section>
      <Section title="Confirm before closing a running session" desc="Ask before terminating a live terminal">
        <Toggle value={settings.confirmCloseRunning} onChange={(v) => update({ confirmCloseRunning: v })} />
      </Section>
      <Section title="Reduce motion" desc="Disable the animated background and other motion">
        <Toggle value={settings.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
      </Section>
      <Section title="About" desc="Agent Deck — a desktop home for your CLI agents">
        <span className="set__static">Version 0.1.0</span>
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
