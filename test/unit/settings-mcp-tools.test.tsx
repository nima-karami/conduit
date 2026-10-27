// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_TOOL_NAMES,
  MESSAGING_TOOL_NAMES,
  TOOL_NAMES,
} from '../../src/conduit-mcp/tool-switches';
import type { WebviewToHost } from '../../src/protocol';
import { SettingsModal } from '../../webview/components/settings-modal';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import { SettingsProvider } from '../../webview/settings';

const bridge = vi.hoisted(() => ({
  post: vi.fn<(m: unknown) => void>(),
  readCursorConnection: vi.fn(async () => ({ state: 'disconnected', path: '/h/.cursor/mcp.json' })),
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
        <SettingsModal agents={[]} onClose={() => {}} onSetChangesView={() => {}} />
      </SettingsProvider>,
    ),
  );
}

/** A switch by the text of the element its aria-labelledby names. */
function switchFor(name: string): HTMLButtonElement | null {
  for (const el of document.body.querySelectorAll<HTMLButtonElement>('[role="switch"]')) {
    const id = el.getAttribute('aria-labelledby');
    if (id && document.getElementById(id)?.textContent === name) return el;
  }
  return null;
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

const posted = (): Extract<WebviewToHost, { type: 'updateSettings' }>[] =>
  bridge.post.mock.calls
    .map(([m]) => m as WebviewToHost)
    .filter(
      (m): m is Extract<WebviewToHost, { type: 'updateSettings' }> => m.type === 'updateSettings',
    );

describe('Settings → MCP tools', () => {
  it('fresh settings show control switches off', async () => {
    await mount();
    for (const t of MESSAGING_TOOL_NAMES)
      expect(switchFor(t)?.getAttribute('aria-checked')).toBe('true');
    for (const t of CONTROL_TOOL_NAMES)
      expect(switchFor(t)?.getAttribute('aria-checked')).toBe('false');
    const s = switchFor('open_terminal');
    const desc = document.getElementById(s?.getAttribute('aria-describedby') ?? '');
    expect(desc?.textContent).toBe(MCP_STR.tools.description.open_terminal);
    expect(document.body.textContent).toContain(MCP_STR.tools.overrideNote);
  });

  it('toggling open_session posts updateSettings with mcpTools.open_session true', async () => {
    await mount();
    await act(async () => switchFor('open_session')?.click());
    expect(switchFor('open_session')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const last = posted().at(-1);
    expect(last?.settings.mcpTools.open_session).toBe(true);
    expect(last?.settings.mcpTools.open_terminal).toBe(false);
    expect(last?.settings.mcpTools.send_message).toBe(true);
  });

  it('master off disables tool switches', async () => {
    await mount();
    expect(document.body.textContent).not.toContain(MCP_STR.tools.masterOffHint);
    for (const t of TOOL_NAMES) expect(switchFor(t)?.disabled).toBe(false);
    await act(async () => masterSwitch().click());
    for (const t of TOOL_NAMES) expect(switchFor(t)?.disabled).toBe(true);
    expect(document.body.textContent).toContain(MCP_STR.tools.masterOffHint);
    // The hint names the master switch by the label the user actually sees.
    expect(MCP_STR.tools.masterOffHint).toContain(MCP_STR.settingsToggle);
  });

  // Ids built from copy would break the IDREF once a translation contains a space.
  it('tool group headings are keyed on stable ids, not their copy', async () => {
    await mount();
    const groups = [...document.body.querySelectorAll('.settools[role="group"]')];
    expect(groups).toHaveLength(2);
    for (const [g, key, title] of [
      [groups[0], 'messaging', MCP_STR.tools.groupMessaging],
      [groups[1], 'control', MCP_STR.tools.groupControl],
    ] as const) {
      const id = g.getAttribute('aria-labelledby') ?? '';
      expect(id.endsWith(`-${key}`)).toBe(true);
      expect(document.getElementById(id)?.textContent).toBe(title);
    }
  });
});
