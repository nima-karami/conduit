import { useEffect, useState } from 'react';
import { useSettings } from '../settings';
import { THEMES, UI_FONTS, MONO_FONTS } from '../themes';
import { SHORTCUT_ACTIONS, comboFromEvent, effectiveCombo, formatCombo } from '../shortcuts';
import { IconClose } from '../icons';
import type { AppSettings, Background, BgIntensity, CardField, Density } from '../../src/settings';
import type { AgentDefinition } from '../../src/types';
import { CARD_FIELD_LABELS } from '../cardFields';
import { DEFAULT_CUSTOM, validateShader } from '../shaderSource';

type Tab = 'general' | 'appearance' | 'shortcuts';

const CARD_ROLES: { key: 'cardTitle' | 'cardSubtitle' | 'cardDetail'; label: string }[] = [
  { key: 'cardTitle', label: 'Title' },
  { key: 'cardSubtitle', label: 'Subtitle' },
  { key: 'cardDetail', label: 'Detail' },
];
// Sample values for the preview card.
const SAMPLE: Record<CardField, string> = {
  name: 'Portfolio Redesign', agent: 'PowerShell 7', folder: 'nextjs-portfolio',
  path: 'G:/awby/projects/nextjs-portfolio', worktree: 'feature/auth', time: '4 min ago',
  status: 'running', none: '',
};

const BG_OPTS: { id: Background; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'grid', label: 'Grid' },
  { id: 'flow', label: 'Flow' },
  { id: 'shader', label: 'Shader' },
  { id: 'custom', label: 'Custom' },
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
            {tab === 'shortcuts' && <Shortcuts settings={settings} update={update} />}
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

      {settings.background !== 'none' && (
        <Section title="Background intensity" desc="How strong the backdrop appears">
          <Segmented<BgIntensity>
            value={settings.bgIntensity}
            options={[{ id: 'subtle', label: 'Subtle' }, { id: 'balanced', label: 'Balanced' }, { id: 'vivid', label: 'Vivid' }]}
            onChange={(v) => update({ bgIntensity: v })}
          />
        </Section>
      )}

      {settings.background === 'custom' && <CustomShaderEditor settings={settings} update={update} />}
    </>
  );
}

function SessionCardSection({
  settings, update,
}: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const title = SAMPLE[settings.cardTitle] || SAMPLE.name;
  const subtitle = settings.cardSubtitle !== 'none' ? SAMPLE[settings.cardSubtitle] : '';
  const detail = settings.cardDetail !== 'none' ? SAMPLE[settings.cardDetail] : '';

  return (
    <section className="set set--col">
      <div className="set__label">
        <span className="set__title">Session card</span>
        <span className="set__desc">Choose which field shows as the title, subtitle and detail</span>
      </div>
      <div className="cardcfg">
        <div className="cardcfg__toggles">
          {CARD_ROLES.map((r) => (
            <div className="cardcfg__row" key={r.key}>
              <span>{r.label}</span>
              <select
                className="modal__select"
                value={settings[r.key]}
                onChange={(e) => update({ [r.key]: e.target.value as CardField } as Partial<AppSettings>)}
              >
                {CARD_FIELD_LABELS
                  .filter((f) => f.id !== 'none' || r.key !== 'cardTitle') // title can't be none
                  .map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </div>
          ))}
        </div>
        <div className="cardcfg__preview">
          <span className="cardcfg__previewlabel">Preview</span>
          <div className="session session--active cardcfg__card">
            <span className="dot dot--active" />
            <span className="session__body">
              <span className="session__name">{title}</span>
              {subtitle && <span className="session__meta"><span className="session__metaitem">{subtitle}</span></span>}
              {detail && <span className="session__path">{detail}</span>}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function CustomShaderEditor({
  settings, update,
}: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const initial = settings.customShader || DEFAULT_CUSTOM;
  const [src, setSrc] = useState(initial);
  const [status, setStatus] = useState<{ ok: boolean; log: string }>({ ok: true, log: '' });

  // Validate (debounced) and persist valid shaders.
  useEffect(() => {
    const t = setTimeout(() => {
      const res = validateShader(src);
      setStatus(res);
      if (res.ok) update({ customShader: src });
    }, 350);
    return () => clearTimeout(t);
  }, [src]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) file.text().then(setSrc);
  };

  return (
    <section className="set set--col">
      <div className="set__label">
        <span className="set__title">Custom shader</span>
        <span className="set__desc">
          GLSL fragment shader. Available uniforms: u_res, u_time, u_c1/u_c2/u_c3 (theme colours), u_alpha.
          Drag a .glsl/.frag file onto the editor to load it.
        </span>
      </div>
      <div className="shadered">
        <textarea
          className="shadered__ta"
          spellCheck={false}
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        />
        <div className="shadered__foot">
          <span className={`shadered__status ${status.ok ? 'shadered__status--ok' : 'shadered__status--err'}`}>
            {status.ok ? '✓ compiles' : `✗ ${status.log.split('\n')[0]}`}
          </span>
          <button className="btn" onClick={() => setSrc(DEFAULT_CUSTOM)}>Reset to template</button>
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
      <ResetSection />
      <Section title="About" desc="Agent Deck — a desktop home for your CLI agents">
        <span className="set__static">Version 0.1.0</span>
      </Section>
    </>
  );
}

function ResetSection() {
  const { resetAll, resetLayout } = useSettings();
  return (
    <>
      <Section title="Reset layout" desc="Panel positions, widths and sidebar back to defaults">
        <ConfirmButton label="Reset layout" onConfirm={resetLayout} />
      </Section>
      <Section title="Reset all settings" desc="Everything (theme, fonts, shortcuts, layout…) back to defaults">
        <ConfirmButton label="Reset all" danger onConfirm={resetAll} />
      </Section>
    </>
  );
}

/** A button that requires a second click to confirm a destructive action. */
function ConfirmButton({ label, onConfirm, danger }: { label: string; onConfirm: () => void; danger?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`btn ${armed ? (danger ? 'btn--danger' : 'btn--primary') : ''}`}
      onClick={() => { if (armed) { onConfirm(); setArmed(false); } else setArmed(true); }}
    >
      {armed ? 'Click again to confirm' : label}
    </button>
  );
}

function Shortcuts({ settings, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const [recording, setRecording] = useState<string | null>(null);
  const overrides = settings.shortcuts;

  // While recording, capture the next real combo and save it as an override.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      const combo = comboFromEvent(e);
      if (!combo) return; // modifier-only, keep waiting
      update({ shortcuts: { ...overrides, [recording]: combo } });
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, overrides, update]);

  const comboFor = (id: string) => effectiveCombo(SHORTCUT_ACTIONS.find((a) => a.id === id)!, overrides);
  const conflict = (id: string) => {
    const c = comboFor(id);
    return SHORTCUT_ACTIONS.some((a) => a.id !== id && comboFor(a.id) === c);
  };
  const reset = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    update({ shortcuts: next });
  };

  const groups = [...new Set(SHORTCUT_ACTIONS.map((s) => s.group))];
  return (
    <div className="shortcuts">
      {groups.map((g) => (
        <div className="shortcuts__group" key={g}>
          <div className="shortcuts__gtitle">{g}</div>
          {SHORTCUT_ACTIONS.filter((s) => s.group === g).map((s) => (
            <div className="shortcuts__row" key={s.id}>
              <span className="shortcuts__desc">
                {s.description}
                {conflict(s.id) && <span className="shortcuts__conflict"> · conflict</span>}
              </span>
              <span className="shortcuts__keys">
                {recording === s.id
                  ? <kbd className="shortcuts__recording">Press keys…</kbd>
                  : <kbd>{formatCombo(comboFor(s.id))}</kbd>}
                <button className="shortcuts__btn" onClick={() => setRecording(s.id)}>Record</button>
                {overrides[s.id] && <button className="shortcuts__btn" onClick={() => reset(s.id)}>Reset</button>}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
