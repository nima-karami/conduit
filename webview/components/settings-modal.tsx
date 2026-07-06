import { useEffect, useState } from 'react';
import type { LogLevel } from '../../src/logging';
import type { AboutInfo } from '../../src/protocol';
import type {
  AppSettings,
  Background,
  BgIntensity,
  CardField,
  Density,
  FontSize,
  IconPack,
} from '../../src/settings';
import type { SkillDestination, SkillInfo, SkillStatus } from '../../src/skills';
import type { AgentDefinition } from '../../src/types';
import { APPEARANCE_SECTIONS, type AppearanceControlId } from '../appearance-sections';
import {
  copyDiagnostics,
  installSkill,
  listSkills,
  openExternal,
  readLogTail,
  revealLogs,
} from '../bridge';
import { CARD_FIELD_LABELS } from '../card-fields';
import { IconCheck, IconClose, IconDownload, IconRefreshCw } from '../icons';
import { useSettings } from '../settings';
import { DEFAULT_CUSTOM, validateShader } from '../shader-source';
import { comboFromEvent, effectiveCombo, formatCombo, SHORTCUT_ACTIONS } from '../shortcuts';
import { MONO_FONTS, THEMES, UI_FONTS } from '../themes';
import { useEscapeKey } from '../use-escape-key';
import type { UpdateStatus } from './update-card';

type Tab = 'general' | 'appearance' | 'shortcuts' | 'skills' | 'about';

const CARD_ROLES: { key: 'cardTitle' | 'cardSubtitle' | 'cardDetail'; label: string }[] = [
  { key: 'cardTitle', label: 'Title' },
  { key: 'cardSubtitle', label: 'Subtitle' },
  { key: 'cardDetail', label: 'Detail' },
];
// Sample values for the preview card.
const SAMPLE: Record<CardField, string> = {
  name: 'Portfolio Redesign',
  agent: 'PowerShell 7',
  folder: 'nextjs-portfolio',
  path: 'G:/awby/projects/nextjs-portfolio',
  worktree: 'feature/auth',
  time: '4 min ago',
  active: '2 mins ago',
  status: 'running',
  none: '',
};

const BG_OPTS: { id: Background; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'grid', label: 'Grid' },
  { id: 'flow', label: 'Flow' },
  { id: 'shader', label: 'Shader' },
];

export function SettingsModal({
  agents,
  initialTab = 'general',
  about,
  projectPath = null,
  onClose,
  onCheckUpdate,
  onRelaunch,
  updateStatus,
}: {
  agents: AgentDefinition[];
  initialTab?: Tab;
  about?: AboutInfo;
  projectPath?: string | null;
  onClose: () => void;
  onCheckUpdate?: () => void;
  onRelaunch?: () => void;
  updateStatus?: UpdateStatus | null;
}) {
  const { settings, update } = useSettings();
  const [tab, setTab] = useState<Tab>(initialTab);

  useEscapeKey(onClose);

  const TAB_LABELS: { id: Tab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'skills', label: 'Skills' },
    { id: 'about', label: 'About' },
  ];

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head settings__head">
          <div>
            <span className="modal__title">Settings</span>
            <span className="modal__sub">Tune the look and behaviour of Conduit</span>
          </div>
          <button className="iconbtn" aria-label="Close settings" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>

        <div className="settings__body">
          <nav className="settings__nav">
            {TAB_LABELS.map(({ id, label }) => (
              <button
                key={id}
                className={`settings__navitem ${tab === id ? 'settings__navitem--active' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="settings__pane">
            {tab === 'appearance' && <Appearance settings={settings} update={update} />}
            {tab === 'general' && <General settings={settings} update={update} agents={agents} />}
            {tab === 'shortcuts' && <Shortcuts settings={settings} update={update} />}
            {tab === 'skills' && <Skills projectPath={projectPath} />}
            {tab === 'about' && (
              <About
                about={about}
                updateStatus={updateStatus ?? null}
                onCheckUpdate={onCheckUpdate ?? (() => {})}
                onRelaunch={onRelaunch ?? (() => {})}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
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

/** A heading + a bordered block of related controls within a settings tab. */
function SetGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="setgroup">
      <h3 className="setgroup__title">{title}</h3>
      <div className="setgroup__body">{children}</div>
    </section>
  );
}

function installLabel(status: SkillStatus, bundledVersion: string): string {
  if (status === 'not-installed') return 'Install';
  if (status === 'update') return `Update to ${bundledVersion}`;
  return 'Reinstall';
}

/** The Skills tab: install Conduit's bundled agent skills into the open project or user-global. */
function Skills({ projectPath }: { projectPath: string | null }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // `${id}:${dest}` in flight
  const [msg, setMsg] = useState<{ id: string; text: string; error: boolean } | null>(null);

  const refresh = () => listSkills(projectPath).then(setSkills);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-list when the active project changes
  useEffect(() => {
    refresh();
  }, [projectPath]);

  const run = async (skill: SkillInfo, dest: SkillDestination) => {
    setBusy(`${skill.id}:${dest}`);
    setMsg(null);
    const res = await installSkill(skill.id, dest, projectPath);
    setBusy(null);
    if (res.ok) {
      const where = dest === 'project' ? 'this project' : 'your user profile';
      setMsg({ id: skill.id, text: `Installed to ${where}.`, error: false });
      await refresh();
    } else {
      setMsg({ id: skill.id, text: res.error, error: true });
    }
  };

  return (
    <div className="settings__tab">
      <SetGroup title="Agent skills">
        <p className="skills__intro">
          Install Conduit's skills so an agent working in a project knows how to read and update its{' '}
          <code>.conduit</code> artifacts. Choose where each skill lives — just this project, or
          your whole user profile.
        </p>
        {skills === null ? (
          <p className="skills__empty">Loading…</p>
        ) : skills.length === 0 ? (
          <p className="skills__empty">No bundled skills found.</p>
        ) : (
          <ul className="skills__list">
            {skills.map((s) => (
              <li key={s.id} className="skillrow">
                <div className="skillrow__info">
                  <div className="skillrow__head">
                    <span className="skillrow__name">{s.name}</span>
                    <span className="skillrow__ver">v{s.version}</span>
                  </div>
                  <p className="skillrow__desc">{s.description}</p>
                  {msg?.id === s.id && (
                    <p className={`skillrow__msg${msg.error ? ' skillrow__msg--error' : ''}`}>
                      {msg.text}
                    </p>
                  )}
                </div>
                <div className="skillrow__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={!projectPath || busy !== null}
                    title={projectPath ? undefined : 'Open a folder to install here'}
                    onClick={() => run(s, 'project')}
                  >
                    {busy === `${s.id}:project`
                      ? 'Installing…'
                      : `${installLabel(s.project.status, s.version)} → project`}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy !== null}
                    onClick={() => run(s, 'global')}
                  >
                    {busy === `${s.id}:global`
                      ? 'Installing…'
                      : `${installLabel(s.global.status, s.version)} → user`}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SetGroup>
    </div>
  );
}

function Appearance({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
}) {
  // Routes a control id into its section; the controls keep their own labels/bindings.
  const renderControl = (id: AppearanceControlId): React.ReactNode => {
    switch (id) {
      case 'theme':
        return (
          <Section key={id} title="Theme" desc="Colour palette for the whole app">
            <div className="swatches">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`swatch ${settings.theme === t.id ? 'swatch--active' : ''}`}
                  onClick={() => update({ theme: t.id })}
                  title={t.label}
                >
                  <span className="swatch__chips">
                    {t.swatch.map((c) => (
                      <span key={c} style={{ background: c }} />
                    ))}
                  </span>
                  <span className="swatch__name">{t.label}</span>
                </button>
              ))}
            </div>
          </Section>
        );
      case 'fontUi':
        return (
          <Section key={id} title="Interface font">
            <select
              className="modal__select"
              value={settings.fontUi}
              onChange={(e) => update({ fontUi: e.target.value })}
            >
              {UI_FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </Section>
        );
      case 'fontMono':
        return (
          <Section key={id} title="Monospace font" desc="Code, paths, terminal labels">
            <select
              className="modal__select"
              value={settings.fontMono}
              onChange={(e) => update({ fontMono: e.target.value })}
            >
              {MONO_FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </Section>
        );
      case 'fontSize':
        return (
          <Section
            key={id}
            title="Font size"
            desc="Scales interface text; the code editor keeps its own size"
          >
            <Segmented<FontSize>
              value={settings.fontSize}
              options={[
                { id: 'small', label: 'Small' },
                { id: 'medium', label: 'Medium' },
                { id: 'large', label: 'Large' },
                { id: 'xlarge', label: 'X-Large' },
              ]}
              onChange={(v) => update({ fontSize: v })}
            />
          </Section>
        );
      case 'density':
        return (
          <Section key={id} title="Density">
            <Segmented<Density>
              value={settings.density}
              options={[
                { id: 'comfortable', label: 'Comfortable' },
                { id: 'compact', label: 'Compact' },
              ]}
              onChange={(v) => update({ density: v })}
            />
          </Section>
        );
      case 'background':
        return (
          <Section key={id} title="Background">
            <Segmented<Background>
              value={settings.background}
              options={BG_OPTS}
              onChange={(v) => update({ background: v })}
            />
          </Section>
        );
      case 'bgIntensity':
        if (settings.background === 'none') return null;
        return (
          <Section key={id} title="Background intensity" desc="How strong the backdrop appears">
            <Segmented<BgIntensity>
              value={settings.bgIntensity}
              options={[
                { id: 'subtle', label: 'Subtle' },
                { id: 'balanced', label: 'Balanced' },
                { id: 'vivid', label: 'Vivid' },
              ]}
              onChange={(v) => update({ bgIntensity: v })}
            />
          </Section>
        );
      case 'surfaceOpacity':
        if (settings.background === 'none') return null;
        return (
          <Section
            key={id}
            title="Surface opacity"
            desc="How opaque the panels & terminal are — lower lets more of the backdrop show through (0% is fully transparent)"
          >
            <Slider
              min={0}
              max={100}
              step={1}
              value={Math.round(settings.surfaceOpacity * 100)}
              format={(n) => `${n}%`}
              onChange={(n) => update({ surfaceOpacity: n / 100 })}
            />
          </Section>
        );
      case 'bgBlur':
        if (settings.background === 'none') return null;
        return (
          <Section
            key={id}
            title="Background blur"
            desc="Frosted-glass blur behind the surfaces — 0 keeps the backdrop crisp"
          >
            <Slider
              min={0}
              max={24}
              step={1}
              value={settings.bgBlur}
              format={(n) => `${n}px`}
              onChange={(n) => update({ bgBlur: n })}
            />
          </Section>
        );
      case 'customShader':
        if (settings.background !== 'shader') return null;
        return <CustomShaderEditor key={id} settings={settings} update={update} />;
      case 'wordWrap':
        return (
          <Section
            key={id}
            title="Word wrap"
            desc="Soft-wrap long lines in the code editor instead of scrolling horizontally (toggle in-editor with Alt+Z)"
          >
            <Toggle value={settings.wordWrap} onChange={(v) => update({ wordWrap: v })} />
          </Section>
        );
      case 'surfaceColor':
        return (
          <Section
            key={id}
            title="Code & terminal background"
            desc="One colour behind both code blocks (Markdown & the editor) and the terminal, so they always match — independent of the panel"
          >
            <ColorField
              value={settings.surfaceColor}
              onChange={(v) => update({ surfaceColor: v })}
            />
          </Section>
        );
      case 'codeOpacity':
        return (
          <Section
            key={id}
            title="Code block opacity"
            desc="How opaque code-block backgrounds are — lower lets the panel/backdrop show through"
          >
            <Slider
              min={0}
              max={100}
              step={1}
              value={Math.round(settings.codeOpacity * 100)}
              format={(n) => `${n}%`}
              onChange={(n) => update({ codeOpacity: n / 100 })}
            />
          </Section>
        );
      case 'iconPack':
        return (
          <Section
            key={id}
            title="File icons"
            desc="Icons next to files in the Explorer: none, minimal monochrome line icons, or coloured per file type"
          >
            <Segmented<IconPack>
              value={settings.iconPack}
              options={[
                { id: 'none', label: 'None' },
                { id: 'minimal', label: 'Minimal' },
                { id: 'colored', label: 'Colored' },
              ]}
              onChange={(v) => update({ iconPack: v })}
            />
          </Section>
        );
      case 'sessionCard':
        return <SessionCardSection key={id} settings={settings} update={update} />;
    }
  };

  return (
    <>
      {APPEARANCE_SECTIONS.map((sec) => (
        <SetGroup key={sec.id} title={sec.title}>
          {sec.controls.map(renderControl)}
        </SetGroup>
      ))}
    </>
  );
}

/** Native colour picker + the hex value, kept in sync. Emits `#rrggbb` (lowercase). */
function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="colorfield">
      <input
        className="colorfield__swatch"
        type="color"
        value={value}
        aria-label="Code block background colour"
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="colorfield__hex">{value.toUpperCase()}</span>
    </div>
  );
}

function SessionCardSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
}) {
  const title = SAMPLE[settings.cardTitle] || SAMPLE.name;
  const subtitle = settings.cardSubtitle !== 'none' ? SAMPLE[settings.cardSubtitle] : '';
  const detail = settings.cardDetail !== 'none' ? SAMPLE[settings.cardDetail] : '';

  return (
    <section className="set set--col">
      <div className="set__label">
        <span className="set__title">Session card</span>
        <span className="set__desc">
          Choose which field shows as the title, subtitle and detail
        </span>
      </div>
      <div className="cardcfg">
        <div className="cardcfg__toggles">
          {CARD_ROLES.map((r) => (
            <div className="cardcfg__row" key={r.key}>
              <span>{r.label}</span>
              <select
                className="modal__select"
                value={settings[r.key]}
                onChange={(e) =>
                  update({ [r.key]: e.target.value as CardField } as Partial<AppSettings>)
                }
              >
                {CARD_FIELD_LABELS.filter((f) => f.id !== 'none' || r.key !== 'cardTitle') // title can't be none
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
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
              {subtitle && (
                <span className="session__meta">
                  <span className="session__metaitem">{subtitle}</span>
                </span>
              )}
              {detail && <span className="session__path">{detail}</span>}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function CustomShaderEditor({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
}) {
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
  }, [src, update]);

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
          GLSL fragment shader. Available uniforms: u_res, u_time, u_c1/u_c2/u_c3 (theme colours),
          u_alpha. Drag a .glsl/.frag file onto the editor to load it.
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
          <span
            className={`shadered__status ${status.ok ? 'shadered__status--ok' : 'shadered__status--err'}`}
          >
            {status.ok ? '✓ compiles' : `✗ ${status.log.split('\n')[0]}`}
          </span>
          <button className="btn" onClick={() => setSrc(DEFAULT_CUSTOM)}>
            Reset to template
          </button>
        </div>
      </div>
    </section>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.id}
          className={`seg__btn ${value === o.id ? 'seg__btn--active' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div className="slider">
      <input
        className="slider__range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider__val">{format(value)}</span>
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
  settings,
  update,
  agents,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
  agents: AgentDefinition[];
}) {
  return (
    <>
      <SetGroup title="Sessions">
        <Section
          title="Default terminal"
          desc="Pre-selected when opening a folder with no remembered shell"
        >
          <select
            className="modal__select"
            value={settings.defaultAgentId}
            onChange={(e) => update({ defaultAgentId: e.target.value })}
          >
            <option value="">Ask each time</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Section>
        <Section
          title="Restore sessions on launch"
          desc="Reopen previous sessions (as stale) when the app starts"
        >
          <Toggle
            value={settings.restoreSessions}
            onChange={(v) => update({ restoreSessions: v })}
          />
        </Section>
        <Section
          title="Relaunch unfinished sessions on startup"
          desc="Automatically restart stale sessions when the app opens. Re-runs each session's command — only enable if that is safe for your workflow."
        >
          <Toggle
            value={settings.autoRelaunchStale}
            onChange={(v) => update({ autoRelaunchStale: v })}
          />
        </Section>
        <Section title="Auto-switch to new session" desc="Focus a session as soon as it's created">
          <Toggle
            value={settings.autoSwitchSession}
            onChange={(v) => update({ autoSwitchSession: v })}
          />
        </Section>
        <Section
          title="Confirm before closing a running session"
          desc="Ask before terminating a live terminal"
        >
          <Toggle
            value={settings.confirmCloseRunning}
            onChange={(v) => update({ confirmCloseRunning: v })}
          />
        </Section>
      </SetGroup>

      <SetGroup title="Workspace">
        <Section
          title="Track live working directory"
          desc="Re-root the Files and Changes views when the terminal reports a new working directory via OSC escape sequences"
        >
          <Toggle value={settings.trackCwd} onChange={(v) => update({ trackCwd: v })} />
        </Section>
        <Section
          title="Show git branch indicator"
          desc="Show the current git branch, worktree, and uncommitted-changes status in a strip at the top of each terminal tab"
        >
          <Toggle
            value={settings.showGitIndicator}
            onChange={(v) => update({ showGitIndicator: v })}
          />
        </Section>
        <Section
          title="Multi-repo picker"
          desc="When the opened folder contains several git repos, show a picker that scopes the git surfaces to one active repo (follows your context; pin to hold one). Hidden for single-repo projects"
        >
          <Toggle
            value={settings.multiRepoPicker}
            onChange={(v) => update({ multiRepoPicker: v })}
          />
        </Section>
      </SetGroup>

      <SetGroup title="Notifications">
        <Section
          title="OS notifications when a background session finishes"
          desc="Taskbar flash and system notification when a session completes while the window is not focused"
        >
          <Toggle value={settings.osAttention} onChange={(v) => update({ osAttention: v })} />
        </Section>
      </SetGroup>

      <SetGroup title="Accessibility">
        <Section title="Reduce motion" desc="Disable the animated background and other motion">
          <Toggle value={settings.reduceMotion} onChange={(v) => update({ reduceMotion: v })} />
        </Section>
      </SetGroup>

      <LoggingSection settings={settings} update={update} />
      <ResetSection />
    </>
  );
}

const LOG_LEVEL_OPTIONS: { id: LogLevel; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'error', label: 'Error' },
  { id: 'warn', label: 'Warn' },
  { id: 'info', label: 'Info' },
  { id: 'debug', label: 'Debug' },
  { id: 'trace', label: 'Trace' },
];

function LoggingSection({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
}) {
  return (
    <SetGroup title="Logging">
      <Section
        title="Enable logging"
        desc="Write a diagnostic log file you can turn on, dial up, and hand over when reporting an issue"
      >
        <Toggle value={settings.logging} onChange={(v) => update({ logging: v })} />
      </Section>
      <Section title="Log level" desc="How much detail is captured — Off silences the log entirely">
        <select
          className="modal__select"
          value={settings.logLevel}
          disabled={!settings.logging}
          onChange={(e) => update({ logLevel: e.target.value as LogLevel })}
        >
          {LOG_LEVEL_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Section>
      <Section title="Reveal logs" desc="Open the folder where Conduit's log files are stored">
        <button type="button" className="btn" onClick={() => revealLogs()}>
          Reveal logs
        </button>
      </Section>
      <Section
        title="Copy diagnostics"
        desc="Bundle recent logs + app/OS versions into a file and reveal it for a bug report"
      >
        <button type="button" className="btn" onClick={() => void copyDiagnostics()}>
          Copy diagnostics
        </button>
      </Section>
    </SetGroup>
  );
}

function ResetSection() {
  const { resetAll, resetLayout } = useSettings();
  return (
    <SetGroup title="Reset">
      <Section title="Reset layout" desc="Panel positions, widths and sidebar back to defaults">
        <ConfirmButton label="Reset layout" onConfirm={resetLayout} />
      </Section>
      <Section
        title="Reset all settings"
        desc="Everything (theme, fonts, shortcuts, layout…) back to defaults"
      >
        <ConfirmButton label="Reset all" danger onConfirm={resetAll} />
      </Section>
    </SetGroup>
  );
}

/** A button that requires a second click to confirm a destructive action. */
function ConfirmButton({
  label,
  onConfirm,
  danger,
}: {
  label: string;
  onConfirm: () => void;
  danger?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`btn ${armed ? (danger ? 'btn--danger' : 'btn--primary') : ''}`}
      onClick={() => {
        if (armed) {
          onConfirm();
          setArmed(false);
        } else setArmed(true);
      }}
    >
      {armed ? 'Click again to confirm' : label}
    </button>
  );
}

function Shortcuts({
  settings,
  update,
}: {
  settings: AppSettings;
  update: (p: Partial<AppSettings>) => void;
}) {
  const [recording, setRecording] = useState<string | null>(null);
  const overrides = settings.shortcuts;

  // While recording, capture the next real combo and save it as an override.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // modifier-only, keep waiting
      update({ shortcuts: { ...overrides, [recording]: combo } });
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, overrides, update]);

  const comboFor = (id: string) => {
    const action = SHORTCUT_ACTIONS.find((a) => a.id === id);
    if (!action) throw new Error(`Unknown shortcut action: ${id}`);
    return effectiveCombo(action, overrides);
  };
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
                {recording === s.id ? (
                  <kbd className="shortcuts__recording">Press keys…</kbd>
                ) : (
                  <kbd>{formatCombo(comboFor(s.id))}</kbd>
                )}
                <button className="shortcuts__btn" onClick={() => setRecording(s.id)}>
                  Record
                </button>
                {overrides[s.id] && (
                  <button className="shortcuts__btn" onClick={() => reset(s.id)}>
                    Reset
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const GITHUB_URL = 'https://github.com/nimakarami/conduit';

function AboutLink({ href, children }: { href: string; children: React.ReactNode }) {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const handled = openExternal(href);
    // Fallback for the browser preview: open in a new tab.
    if (!handled) window.open(href, '_blank', 'noopener,noreferrer');
  };
  return (
    <a className="about__link" href={href} onClick={handleClick}>
      {children}
    </a>
  );
}

/**
 * The Updates row control. Reflects the full update lifecycle inline (rather than via a
 * transient toast): an idle "Check now" button, a spinner while checking, an "Up to date"
 * confirmation, download progress, and a "Relaunch" action once an update is staged.
 */
function UpdatesControl({
  status,
  onCheck,
  onRelaunch,
}: {
  status: UpdateStatus | null;
  onCheck: () => void;
  onRelaunch: () => void;
}) {
  const s = status?.status;

  if (s === 'ready') {
    return (
      <div className="about__updatectl">
        <span className="about__updatestatus about__updatestatus--ready">
          <IconRefreshCw size={13} />v{status?.version ?? '?'} ready
        </span>
        <button
          type="button"
          className="about__checkbtn about__checkbtn--accent"
          onClick={onRelaunch}
        >
          Relaunch
        </button>
      </div>
    );
  }

  if (s === 'available' || s === 'downloading') {
    return (
      <div className="about__updatectl">
        <span className="about__updatestatus">
          <IconDownload size={13} />
          {s === 'downloading' ? `Downloading… ${status?.percent ?? 0}%` : 'Update available'}
        </span>
      </div>
    );
  }

  const checking = s === 'checking';
  return (
    <div className="about__updatectl">
      {s === 'up-to-date' && (
        <span className="about__updatestatus about__updatestatus--ok">
          <IconCheck size={13} />
          Up to date
        </span>
      )}
      {s === 'error' && (
        <span className="about__updatestatus about__updatestatus--err">Check failed</span>
      )}
      <button type="button" className="about__checkbtn" onClick={onCheck} disabled={checking}>
        {checking ? 'Checking…' : s === 'error' ? 'Retry' : 'Check now'}
      </button>
    </div>
  );
}

function About({
  about,
  updateStatus,
  onCheckUpdate,
  onRelaunch,
}: {
  about?: AboutInfo;
  updateStatus: UpdateStatus | null;
  onCheckUpdate: () => void;
  onRelaunch: () => void;
}) {
  return (
    <div className="about">
      <div className="about__hero">
        <img className="about__logo" src="./icon.png" alt="Conduit logo" />
        <div className="about__herotext">
          <span className="about__name">Conduit</span>
          <span className="about__version">v{about?.version ?? '—'}</span>
        </div>
      </div>

      <p className="about__story">
        Conduit is an agent-orchestration center for the agent era — orchestrate agents, review
        their work, accept it. A code editing, viewing and reviewing home where humans own the
        merge.
      </p>

      <div className="about__rows">
        <div className="about__row">
          <span className="about__rowlabel">Author</span>
          <span className="about__rowval">{about?.author ?? 'Nima Karami'}</span>
        </div>
        <div className="about__row">
          <span className="about__rowlabel">License</span>
          <span className="about__rowval">MIT</span>
        </div>
        <div className="about__row">
          <span className="about__rowlabel">Repository</span>
          <AboutLink href={GITHUB_URL}>github.com/nimakarami/conduit</AboutLink>
        </div>
        <div className="about__row">
          <span className="about__rowlabel">Updates</span>
          <UpdatesControl status={updateStatus} onCheck={onCheckUpdate} onRelaunch={onRelaunch} />
        </div>
      </div>

      <div className="about__runtimes">
        <span className="about__runtimestitle">Runtime</span>
        <div className="about__runtimegrid">
          <span className="about__rtlabel">Electron</span>
          <span className="about__rtval">{about?.electronVersion ?? '—'}</span>
          <span className="about__rtlabel">Node</span>
          <span className="about__rtval">{about?.nodeVersion ?? '—'}</span>
          <span className="about__rtlabel">Chromium</span>
          <span className="about__rtval">{about?.chromeVersion ?? '—'}</span>
        </div>
      </div>

      <LogTail />
    </div>
  );
}

/**
 * Recent log tail (Slice B): the last lines of the active log, surfaced read-only with a Copy
 * affordance for quick bug reports. The host returns already-redacted content; when logging is
 * off it reports `off` and we show a friendly note instead of an empty block. Refetched on
 * mount (the About tab only renders when open) and via an explicit Refresh.
 */
function LogTail() {
  const [state, setState] = useState<{ off: boolean; tail: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    void readLogTail(100).then(setState);
  };
  useEffect(() => {
    void readLogTail(100).then(setState);
  }, []);

  const copy = () => {
    if (!state?.tail) return;
    void navigator.clipboard.writeText(state.tail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="about__runtimes">
      <div className="about__logtailhead">
        <span className="about__runtimestitle">Recent log</span>
        <div className="about__logtailactions">
          <button type="button" className="about__checkbtn" onClick={load}>
            Refresh
          </button>
          <button
            type="button"
            className="about__checkbtn"
            onClick={copy}
            disabled={!state || state.off || !state.tail}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      {state?.off ? (
        <p className="about__logtailnote">Logging is off — enable it in General → Logging.</p>
      ) : (
        <pre className="about__logtail">{state?.tail || 'No recent log entries.'}</pre>
      )}
    </div>
  );
}
