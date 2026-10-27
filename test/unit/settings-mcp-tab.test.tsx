// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCli, McpInstallStatus } from '../../src/conduit-mcp/install-types';
import type { WebviewToHost } from '../../src/protocol';
import { type AppSettings, DEFAULT_SETTINGS } from '../../src/settings';
import { SettingsModal } from '../../webview/components/settings-modal';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import { SettingsProvider } from '../../webview/settings';

const S = MCP_STR.install;
const status = (project: boolean): McpInstallStatus => ({
  clis: (['claude', 'codex', 'cursor', 'opencode'] as const).map((cli) => ({
    cli,
    found: true,
    user: { state: 'not-installed', path: `/h/${cli}` },
    project: project
      ? { entries: [], installable: cli !== 'cursor', installPath: `/p/${cli}` }
      : null,
  })),
});

const bridge = vi.hoisted(() => ({
  post: vi.fn<(m: unknown) => void>(),
  mcpInstallStatus: vi.fn<(p: string | null) => Promise<McpInstallStatus>>(),
  mcpInstallAct: vi.fn(),
}));
const seed = vi.hoisted(() => ({ settings: undefined as AppSettings | undefined }));
vi.mock('../../webview/bridge', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../webview/bridge')>();
  return {
    ...orig,
    ...bridge,
    get initialSettings() {
      return seed.settings ?? orig.initialSettings;
    },
  };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  bridge.mcpInstallStatus.mockImplementation(async (p) => status(p !== null));
});
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.clearAllMocks();
  seed.settings = undefined;
});

async function mount(
  o: { tab?: 'general' | 'mcp'; projectPath?: string | null; initialCli?: AgentCli } = {},
) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <SettingsProvider>
        <SettingsModal
          agents={[]}
          initialTab={o.tab ?? 'mcp'}
          projectPath={o.projectPath ?? null}
          initialCli={o.initialCli}
          onClose={() => {}}
          onSetChangesView={() => {}}
        />
      </SettingsProvider>,
    ),
  );
}

const navLabels = () =>
  [...document.body.querySelectorAll('.settings__navitem')].map((b) => b.textContent);
const groupTitles = () =>
  [...document.body.querySelectorAll('.setgroup__title')].map((h) => h.textContent);
const settingSwitch = (title: string) => {
  for (const row of document.body.querySelectorAll('.set')) {
    if (row.querySelector('.set__title')?.textContent === title)
      return row.querySelector<HTMLButtonElement>('[role="switch"]');
  }
  return null;
};
const posted = () =>
  bridge.post.mock.calls
    .map(([m]) => m as WebviewToHost)
    .filter(
      (m): m is Extract<WebviewToHost, { type: 'updateSettings' }> => m.type === 'updateSettings',
    );

describe('Settings → MCP tab', () => {
  it('MCP nav item sits after General', async () => {
    await mount();
    expect(navLabels().slice(0, 2)).toEqual(['General', S.tab]);
  });

  it('groups in order: Messaging, Agent CLIs, Tools, Suggestions', async () => {
    await mount();
    expect(groupTitles()).toEqual([
      MCP_STR.settingsTitle,
      S.clisTitle,
      S.toolsTitle,
      S.suggestTitle,
    ]);
  });

  it('four rows in fixed order Claude Code, Codex, Cursor, OpenCode', async () => {
    await mount();
    const names = [...document.body.querySelectorAll('.mcp-install-row__name')].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(['Claude Code', 'Codex', 'Cursor', 'OpenCode']);
    expect(bridge.mcpInstallStatus).toHaveBeenCalledWith(null);
  });

  it('project section hidden without a project, shown with one', async () => {
    await mount();
    expect(document.body.querySelector('.mcp-project')).toBeNull();
    await act(async () => root?.unmount());
    root = null;
    await mount({ projectPath: '/work/app' });
    expect(bridge.mcpInstallStatus).toHaveBeenLastCalledWith('/work/app');
    expect(document.body.querySelector('.mcp-project')).not.toBeNull();
  });

  it('master off: rows usable, hint shown', async () => {
    await mount();
    expect(document.body.textContent).not.toContain(S.masterOffHint);
    await act(async () => settingSwitch(MCP_STR.settingsToggle)?.click());
    expect(document.body.textContent).toContain(S.masterOffHint);
    const install = document.body.querySelector<HTMLButtonElement>(
      `button[aria-label="${S.installAria('codex')}"]`,
    );
    expect(install?.disabled).toBe(false);
  });

  it('turning Suggestions on clears dismissals in the same update (AC12)', async () => {
    seed.settings = {
      ...DEFAULT_SETTINGS,
      mcpInstallSuggest: false,
      mcpInstallPromptDismissed: { codex: true },
    };
    await mount();
    expect(settingSwitch(S.suggestToggle)?.getAttribute('aria-checked')).toBe('false');
    await act(async () => settingSwitch(S.suggestToggle)?.click());
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const sent = posted();
    expect(sent).toHaveLength(1);
    expect(sent[0].settings.mcpInstallSuggest).toBe(true);
    expect(sent[0].settings.mcpInstallPromptDismissed).toEqual({});
  });

  it('initialCli focuses that row’s first button', async () => {
    await mount({ initialCli: 'cursor' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe(S.installAria('cursor'));
  });

  it('General no longer contains the messaging master switch', async () => {
    await mount({ tab: 'general' });
    expect(settingSwitch(MCP_STR.settingsToggle)).toBeNull();
    expect(groupTitles()).not.toContain(MCP_STR.settingsTitle);
  });
});
