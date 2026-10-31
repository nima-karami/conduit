// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_KINDS, TOOL_NAMES } from '../../src/conduit-mcp/tool-policy';
import type { WebviewToHost } from '../../src/protocol';
import { SettingsModal } from '../../webview/components/settings-modal';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import { SettingsProvider } from '../../webview/settings';

const bridge = vi.hoisted(() => ({
  post: vi.fn<(m: unknown) => void>(),
  mcpInstallStatus: vi.fn(async () => ({ clis: [] })),
}));
vi.mock('../../webview/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webview/bridge')>()),
  ...bridge,
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <SettingsProvider>
        <SettingsModal
          agents={[]}
          initialTab="mcp"
          onClose={() => {}}
          onSetChangesView={() => {}}
        />
      </SettingsProvider>,
    ),
  );
}

function masterSwitch(): HTMLButtonElement {
  for (const row of document.body.querySelectorAll('.set')) {
    if (row.querySelector('.set__title')?.textContent === MCP_STR.settingsToggle) {
      const s = row.querySelector<HTMLButtonElement>('[role="switch"]');
      if (s) return s;
    }
  }
  throw new Error('master switch not found');
}

const tablist = () =>
  document.body.querySelector<HTMLElement>(
    `.policycli[role="tablist"][aria-label="${MCP_STR.tools.defaultsFor}"]`,
  );
const tab = (cli: string) =>
  tablist()?.querySelector<HTMLButtonElement>(`[role="tab"][data-cli="${cli}"]`) ?? null;
const group = (tool: string) =>
  document.body.querySelector<HTMLElement>(
    `[role="radiogroup"][aria-label="${MCP_STR.tools.accessLabel(tool)}"]`,
  );
const radio = (tool: string, label: string) =>
  group(tool)?.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${label}"]`) ?? null;
const checked = (tool: string) =>
  group(tool)?.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('aria-label');
const click = (el: HTMLElement | null) =>
  act(async () => {
    if (!el) throw new Error('nothing to click');
    el.click();
  });
const key = (k: string) =>
  act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
const flush = () =>
  act(async () => {
    vi.advanceTimersByTime(300);
  });

const posted = (): Extract<WebviewToHost, { type: 'updateSettings' }>[] =>
  bridge.post.mock.calls
    .map(([m]) => m as WebviewToHost)
    .filter(
      (m): m is Extract<WebviewToHost, { type: 'updateSettings' }> => m.type === 'updateSettings',
    );

const ALL = MCP_STR.tools.layerName.global;

describe('Settings → MCP tools', () => {
  it('shows the global layer by default under a CLI tablist', async () => {
    await mount();
    const tabs = [...(tablist()?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    expect(tabs.map((t) => t.dataset.cli)).toEqual(['all', ...CLI_KINDS]);
    expect(tabs.map((t) => t.textContent)).toEqual([
      ALL,
      ...CLI_KINDS.map((k) => MCP_STR.tools.cliName[k]),
    ]);
    expect(tab('all')?.getAttribute('aria-selected')).toBe('true');
    expect(tab('codex')?.getAttribute('aria-selected')).toBe('false');
    expect(tab('all')?.tabIndex).toBe(0);
    expect(tab('codex')?.tabIndex).toBe(-1);
    const panel = document.getElementById(tab('all')?.getAttribute('aria-controls') ?? '');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.contains(group('open_session'))).toBe(true);
    for (const t of TOOL_NAMES) expect(group(t)).not.toBeNull();
    expect(checked('open_session')).toBe('Ask');
    expect(checked('open_file')).toBe('On');
    expect(checked('open_terminal')).toBe('Off');
    expect(document.body.textContent).toContain(MCP_STR.tools.overrideNote);
    expect(document.body.textContent).not.toContain(MCP_STR.tools.cliLayerNote);
  });

  it('All CLIs: On for open_terminal posts mcpToolPolicy.open_terminal.access on', async () => {
    await mount();
    await click(radio('open_terminal', 'On'));
    expect(checked('open_terminal')).toBe('On');
    await flush();
    const last = posted().at(-1);
    expect(last?.settings.mcpToolPolicy.open_terminal).toEqual({
      access: 'on',
      when: 'viewing',
      move: 'yes',
    });
    expect(last?.settings.mcpToolPolicy.open_session.access).toBe('ask');
    expect(last?.settings.mcpToolPolicyByCli).toEqual({});
  });

  it('Codex tab: Off for open_file posts mcpToolPolicyByCli.codex.open_file.access off', async () => {
    await mount();
    await click(tab('codex'));
    expect(tab('codex')?.getAttribute('aria-selected')).toBe('true');
    expect(document.body.textContent).toContain(MCP_STR.tools.cliLayerNote);
    expect(checked('open_file')).toBe(`Inherit (On · from ${ALL})`);
    await click(radio('open_file', 'Off'));
    expect(checked('open_file')).toBe('Off');
    await flush();
    const last = posted().at(-1);
    expect(last?.settings.mcpToolPolicyByCli).toEqual({ codex: { open_file: { access: 'off' } } });
    // The global layer is untouched by a CLI-layer edit.
    expect(last?.settings.mcpToolPolicy.open_file.access).toBe('on');
  });

  it('Codex tab: Inherit drops an empty kind', async () => {
    await mount();
    await click(tab('codex'));
    await click(radio('open_file', 'Off'));
    await click(radio('open_file', `Inherit (On · from ${ALL})`));
    await flush();
    expect(posted().at(-1)?.settings.mcpToolPolicyByCli).toStrictEqual({});
  });

  it('arrows move between CLI tabs and select', async () => {
    await mount();
    tab('all')?.focus();
    await key('ArrowRight');
    expect(document.activeElement).toBe(tab('claude'));
    expect(tab('claude')?.getAttribute('aria-selected')).toBe('true');
    await key('ArrowLeft');
    await key('ArrowLeft');
    expect(document.activeElement).toBe(tab('agent'));
    expect(tab('agent')?.textContent).toBe(MCP_STR.tools.cliName.agent);
    await key('Home');
    expect(tab('all')?.getAttribute('aria-selected')).toBe('true');
  });

  it('master off disables every control', async () => {
    await mount();
    expect(document.body.textContent).not.toContain(MCP_STR.tools.masterOffHint);
    for (const t of TOOL_NAMES) expect(group(t)?.getAttribute('aria-disabled')).toBeNull();
    await click(masterSwitch());
    for (const t of TOOL_NAMES) {
      expect(group(t)?.getAttribute('aria-disabled')).toBe('true');
      for (const b of group(t)?.querySelectorAll('button') ?? []) expect(b.disabled).toBe(true);
    }
    expect(document.body.textContent).toContain(MCP_STR.tools.masterOffHint);
    // The hint names the master switch by the label the user actually sees.
    expect(MCP_STR.tools.masterOffHint).toContain(MCP_STR.settingsToggle);
  });
});
