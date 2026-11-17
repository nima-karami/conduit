// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicyUiState } from '../../src/conduit-mcp/policy-types';
import {
  CLI_KINDS,
  type CliPolicyLayers,
  type PolicyLayer,
  TOOL_NAMES,
} from '../../src/conduit-mcp/tool-policy';
import {
  emptyPolicyUi,
  type McpUiState,
  type RemotePolicyUi,
} from '../../src/conduit-mcp/ui-types';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import { SettingsModal } from '../../webview/components/settings-modal';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import { SettingsProvider } from '../../webview/settings';

const bridge = vi.hoisted(() => ({
  listeners: new Set<(m: HostToWebview) => void>(),
  post: vi.fn<(m: unknown) => void>(),
  mcpInstallStatus: vi.fn(async () => ({ clis: [] })),
}));
vi.mock('../../webview/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webview/bridge')>()),
  post: bridge.post,
  mcpInstallStatus: bridge.mcpInstallStatus,
  subscribe: (cb: (m: HostToWebview) => void) => {
    bridge.listeners.add(cb);
    return () => {
      bridge.listeners.delete(cb);
    };
  },
}));

const emit = (m: HostToWebview) => {
  act(() => {
    for (const l of [...bridge.listeners]) l(m);
  });
};

type Legacy = PolicyUiState['legacy'];

function mcpState(legacy: Legacy, machines: RemotePolicyUi[] = []): McpUiState {
  return {
    enabled: true,
    storeError: null,
    loading: false,
    sessions: {},
    threads: [],
    attention: [],
    youUnread: 0,
    youUrgent: 0,
    youUnreadByThread: [],
    switchable: [],
    notConnected: {},
    awaitingApproval: [],
    waitingAsks: 0,
    policy: { ...emptyPolicyUi(), legacy, machines },
    requests: {
      open: [],
      ended: [],
      presence: { state: 'here', since: '2026-11-14T09:00:00.000Z', until: null, lastAway: null },
    },
  };
}

const broadcast = (legacy: Legacy, machines: RemotePolicyUi[] = []) =>
  emit({ type: 'mcp:state', state: mcpState(legacy, machines) });

const layersOf = (p: { global?: PolicyLayer; byCli?: CliPolicyLayers } = {}): Legacy => ({
  global: p.global ?? {},
  byCli: p.byCli ?? {},
  sessions: {},
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The machine picker is a SelectField, which opens a Popover that measures itself.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
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

async function mount(legacy: Legacy = layersOf(), machines: RemotePolicyUi[] = []) {
  emit({ type: 'mcp:state', state: mcpState(legacy, machines) });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <SettingsProvider>
        <SettingsModal
          agents={[]}
          initialTab="mcp"
          serverConnected
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

type PointPolicy = Extract<WebviewToHost, { type: 'mcp:setPointPolicy' }>;
const pointPosts = (): PointPolicy[] =>
  bridge.post.mock.calls
    .map(([m]) => m as WebviewToHost)
    .filter((m): m is PointPolicy => m.type === 'mcp:setPointPolicy');
const lastPointPost = (): PointPolicy => {
  const last = pointPosts().at(-1);
  if (!last) throw new Error('no mcp:setPointPolicy posted');
  return last;
};
const replyPolicy = (requestId: number, error?: string) =>
  emit(
    error === undefined
      ? { type: 'mcp:policyResult', requestId, ok: true }
      : { type: 'mcp:policyResult', requestId, ok: false, error },
  );
const errorOf = (tool: string) =>
  document.body.querySelector(`.policyrow[data-tool="${tool}"] .policyrow__error`);

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

  it('All CLIs: On for open_terminal posts setPointPolicy to the default point', async () => {
    await mount();
    await click(radio('open_terminal', 'On'));
    expect(checked('open_terminal')).toBe('On');
    await flush();
    expect(lastPointPost()).toEqual({
      type: 'mcp:setPointPolicy',
      requestId: expect.any(Number),
      point: { kind: 'default' },
      tool: 'open_terminal',
      patch: { access: 'on' },
    });
    expect(pointPosts()).toHaveLength(1);
    expect(bridge.post.mock.calls.map(([m]) => (m as WebviewToHost).type)).not.toContain(
      'updateServerSettings',
    );
  });

  it('Codex tab: Off for open_file posts setPointPolicy to that CLI', async () => {
    await mount();
    await click(tab('codex'));
    expect(tab('codex')?.getAttribute('aria-selected')).toBe('true');
    expect(document.body.textContent).toContain(MCP_STR.tools.cliLayerNote);
    expect(checked('open_file')).toBe(`Inherit (On · from ${ALL})`);
    await click(radio('open_file', 'Off'));
    expect(checked('open_file')).toBe('Off');
    await flush();
    expect(lastPointPost()).toEqual({
      type: 'mcp:setPointPolicy',
      requestId: expect.any(Number),
      point: { kind: 'cli', cli: 'codex' },
      tool: 'open_file',
      patch: { access: 'off' },
    });
  });

  it('Codex tab: Inherit posts an inherit patch for that CLI', async () => {
    await mount();
    await click(tab('codex'));
    await click(radio('open_file', 'Off'));
    await click(radio('open_file', `Inherit (On · from ${ALL})`));
    await flush();
    expect(lastPointPost()).toMatchObject({
      point: { kind: 'cli', cli: 'codex' },
      tool: 'open_file',
      patch: { access: 'inherit' },
    });
  });

  it('shows the global and CLI layers from policy.legacy', async () => {
    await mount(
      layersOf({
        global: { open_file: { access: 'off' } },
        byCli: { codex: { open_file: { access: 'on' } } },
      }),
    );
    expect(checked('open_file')).toBe('Off');
    await click(tab('codex'));
    expect(checked('open_file')).toBe('On');
  });

  it('a save the host refuses as read-only shows saveFailed and reverts', async () => {
    await mount(layersOf({ global: { open_file: { access: 'on', when: 'always' } } }));
    await click(radio('open_file', 'Off'));
    expect(checked('open_file')).toBe('Off');
    replyPolicy(lastPointPost().requestId, 'read-only');
    await flush();
    expect(checked('open_file')).toBe('On');
    expect(errorOf('open_file')?.textContent).toBe(MCP_STR.tools.saveFailed);
  });

  it('a refused pick reverts to the last confirmed value, not the persisted one', async () => {
    await mount();
    await click(radio('open_file', 'Off'));
    replyPolicy(lastPointPost().requestId);
    await flush();
    await click(radio('open_file', 'Ask'));
    replyPolicy(lastPointPost().requestId, 'read-only');
    await flush();
    expect(checked('open_file')).toBe('Off');
    expect(errorOf('open_file')?.textContent).toBe(MCP_STR.tools.saveFailed);
  });

  it('a broadcast after a confirmed pick shows the broadcast value', async () => {
    await mount();
    await click(tab('codex'));
    await click(radio('open_file', 'Off'));
    replyPolicy(lastPointPost().requestId);
    await flush();
    expect(checked('open_file')).toBe('Off');
    broadcast(layersOf());
    expect(checked('open_file')).toBe(`Inherit (On · from ${ALL})`);
  });

  it('a broadcast that lands while a pick is in flight keeps the optimistic value', async () => {
    await mount();
    await click(tab('codex'));
    await click(radio('open_file', 'Off'));
    broadcast(layersOf());
    expect(checked('open_file')).toBe('Off');
    replyPolicy(lastPointPost().requestId);
    await flush();
    expect(checked('open_file')).toBe('Off');
  });

  it('after a broadcast with no pick in flight, a refused pick reverts to that broadcast', async () => {
    await mount();
    await click(radio('open_file', 'Off'));
    replyPolicy(lastPointPost().requestId);
    await flush();
    broadcast(layersOf({ global: { open_file: { access: 'ask' } } }));
    expect(checked('open_file')).toBe('Ask');
    await click(radio('open_file', 'On'));
    replyPolicy(lastPointPost().requestId, 'read-only');
    await flush();
    expect(checked('open_file')).toBe('Ask');
    expect(errorOf('open_file')?.textContent).toBe(MCP_STR.tools.saveFailed);
  });

  it('a refusal after a broadcast reverts to that broadcast, not to a confirmed value it superseded', async () => {
    await mount();
    await click(radio('open_file', 'Off'));
    replyPolicy(lastPointPost().requestId);
    await flush();
    await click(radio('open_file', 'On'));
    broadcast(layersOf({ global: { open_file: { access: 'ask' } } }));
    expect(checked('open_file')).toBe('On');
    replyPolicy(lastPointPost().requestId, 'read-only');
    await flush();
    expect(checked('open_file')).toBe('Ask');
    expect(errorOf('open_file')?.textContent).toBe(MCP_STR.tools.saveFailed);
  });

  it('a scoped refusal on a CLI tab shows saveFailed on that tab', async () => {
    await mount();
    await click(tab('codex'));
    await click(radio('open_file', 'Off'));
    replyPolicy(lastPointPost().requestId, 'scoped');
    await flush();
    expect(checked('open_file')).toBe(`Inherit (On · from ${ALL})`);
    expect(errorOf('open_file')?.textContent).toBe(MCP_STR.tools.saveFailed);
    await click(tab('all'));
    expect(errorOf('open_file')).toBeNull();
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

const remoteOf = (
  over: Pick<RemotePolicyUi, 'machineId' | 'name'> & Partial<RemotePolicyUi>,
): RemotePolicyUi => ({
  link: 'up',
  rev: 4,
  status: 'applied',
  refusal: null,
  policy: {
    profiles: [],
    assignments: [],
    sessions: {},
    grants: [],
    legacy: layersOf({ global: { open_file: { access: 'off' } } }),
    readOnly: false,
  },
  conflict: null,
  grants: [],
  ...over,
});

const machinePicker = () =>
  document.body.querySelector<HTMLButtonElement>('.selectfield[aria-label="Machine to edit"]');
const menuItem = (label: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (b) => b.textContent?.trim() === label,
  ) ?? null;
const pickMachine = async (label: string) => {
  await click(machinePicker());
  await click(menuItem(label));
};
const buttonNamed = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text,
  ) ?? null;
const remotePosts = () =>
  bridge.post.mock.calls
    .map(([m]) => m as WebviewToHost)
    .filter(
      (m): m is Extract<WebviewToHost, { type: 'mcp:remotePolicy' }> =>
        m.type === 'mcp:remotePolicy',
    );
const BOB = { machineId: 'b', name: 'Bob' };

describe('Settings → MCP tools: machine picker', () => {
  it('is hidden when there are no machines', async () => {
    await mount();
    expect(machinePicker()).toBeNull();
    expect(document.body.textContent).not.toContain('This machine');
  });

  it('lists this machine and every machine in policy.machines', async () => {
    await mount(layersOf(), [remoteOf(BOB), remoteOf({ machineId: 'c', name: 'Cy' })]);
    await click(machinePicker());
    expect(
      [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((i) =>
        i.textContent?.trim(),
      ),
    ).toEqual(['This machine', 'Bob', 'Cy']);
  });

  it('selecting a machine renders its rows, and an edit sends that machine', async () => {
    await mount(layersOf({ global: { open_file: { access: 'on' } } }), [remoteOf(BOB)]);
    expect(checked('open_file')).toBe('On');
    await pickMachine('Bob');
    expect(checked('open_file')).toBe('Off');
    await click(radio('open_file', 'On'));
    await flush();
    expect(lastPointPost()).toMatchObject({
      point: { kind: 'default' },
      tool: 'open_file',
      patch: { access: 'on' },
      machine: 'b',
    });
  });

  it('going back to This machine renders the local rows and sends no machine', async () => {
    await mount(layersOf({ global: { open_file: { access: 'on' } } }), [remoteOf(BOB)]);
    await pickMachine('Bob');
    await pickMachine('This machine');
    expect(checked('open_file')).toBe('On');
    await click(radio('open_file', 'Off'));
    await flush();
    expect(lastPointPost().machine).toBeUndefined();
  });

  it('shows applied, waiting, pushing and refused lines for the selected machine only', async () => {
    await mount(layersOf(), [remoteOf({ ...BOB, status: 'applied' })]);
    expect(document.body.textContent).not.toContain('Applied on Bob');
    await pickMachine('Bob');
    expect(document.body.textContent).toContain('Applied on Bob');
    broadcast(layersOf(), [remoteOf({ ...BOB, status: 'waiting' })]);
    expect(document.body.textContent).toContain('Waiting for Bob: applies when it reconnects');
    broadcast(layersOf(), [remoteOf({ ...BOB, status: 'pushing' })]);
    expect(document.body.textContent).toContain('Sending to Bob…');
    broadcast(layersOf(), [remoteOf({ ...BOB, status: 'refused', refusal: 'bad rules' })]);
    expect(document.body.textContent).toContain('Bob refused: bad rules');
  });

  it('a conflict shows the notice and the two buttons, which send discard and reapply', async () => {
    await mount(layersOf(), [
      remoteOf({ ...BOB, status: 'conflict', conflict: remoteOf(BOB).policy }),
    ]);
    await pickMachine('Bob');
    expect(document.body.textContent).toContain("Bob's rules changed since your edit");
    expect(buttonNamed("Use Bob's rules")).not.toBeNull();
    expect(buttonNamed('Apply mine on top')).not.toBeNull();
    await click(buttonNamed("Use Bob's rules"));
    expect(remotePosts().at(-1)).toEqual({
      type: 'mcp:remotePolicy',
      machine: 'b',
      action: 'discard',
    });
    await click(buttonNamed('Apply mine on top'));
    expect(remotePosts().at(-1)).toEqual({
      type: 'mcp:remotePolicy',
      machine: 'b',
      action: 'reapply',
    });
  });

  it('the conflict buttons only appear on a conflict', async () => {
    await mount(layersOf(), [remoteOf({ ...BOB, status: 'applied' })]);
    await pickMachine('Bob');
    expect(buttonNamed("Use Bob's rules")).toBeNull();
    expect(buttonNamed('Apply mine on top')).toBeNull();
  });
});
