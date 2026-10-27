// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCli, McpInstallResult } from '../../src/conduit-mcp/install-types';
import type { McpNotConnected } from '../../src/conduit-mcp/ui-types';
import type { WebviewToHost } from '../../src/protocol';
import { type AppSettings, DEFAULT_SETTINGS } from '../../src/settings';
import type { Session } from '../../src/types';
import { McpSetupBanner } from '../../webview/components/mcp-setup-banner';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import {
  type BannerLedger,
  bannerKey,
  createBannerLedger,
  shouldOfferBanner,
} from '../../webview/mcp-setup-banner-model';
import { SettingsProvider } from '../../webview/settings';

const S = MCP_STR.install;

const bridge = vi.hoisted(() => ({
  post: vi.fn<(m: unknown) => void>(),
  mcpInstallAct: vi.fn<(req: unknown) => Promise<McpInstallResult>>(),
}));
const box = vi.hoisted(() => ({ settings: undefined as AppSettings | undefined }));
vi.mock('../../webview/bridge', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../webview/bridge')>();
  return {
    ...orig,
    ...bridge,
    get initialSettings() {
      return box.settings ?? orig.initialSettings;
    },
  };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement;
let ledger: BannerLedger;
const onOpenMcpSettings = vi.fn<(cli: AgentCli) => void>();

beforeEach(() => {
  vi.useFakeTimers();
  ledger = createBannerLedger();
  box.settings = { ...DEFAULT_SETTINGS };
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

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  name: 'shell',
  agentId: 'shell',
  home: '/h',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  ...over,
});

const nc = (over: Partial<McpNotConnected> = {}): McpNotConnected => ({
  cli: 'codex',
  install: 'not-installed',
  launch: 1,
  reason: 'no-initialize',
  ...over,
});

interface Props {
  session: Session;
  nc: McpNotConnected | undefined;
  messagingOn: boolean;
}

function el(p: Props) {
  return (
    <SettingsProvider>
      <McpSetupBanner
        session={p.session}
        nc={p.nc}
        messagingOn={p.messagingOn}
        onOpenMcpSettings={onOpenMcpSettings}
        ledger={ledger}
      />
    </SettingsProvider>
  );
}

async function mount(p: Props) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(el(p)));
}

async function rerender(p: Props) {
  await act(async () => root?.render(el(p)));
}

const banner = () => document.body.querySelector<HTMLElement>('.mcp-banner');
const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('.mcp-banner button')].find(
    (b) => b.textContent === text,
  );
const closeButton = () =>
  document.body.querySelector<HTMLButtonElement>(
    `.mcp-banner button[aria-label="${S.bannerClose}"]`,
  );
const liveText = () =>
  [...document.body.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent).join('|');

const base = { session: session(), nc: nc(), messagingOn: true };

describe('shouldOfferBanner', () => {
  const ok = {
    nc: nc(),
    messagingOn: true,
    suggest: true,
    dismissed: {},
    otherBannerShowing: false,
    seen: false,
  };
  it('AC12 shows iff every condition holds (model)', () => {
    expect(shouldOfferBanner(ok)).toBe(true);
    expect(shouldOfferBanner({ ...ok, nc: undefined })).toBe(false);
    expect(shouldOfferBanner({ ...ok, messagingOn: false })).toBe(false);
    expect(shouldOfferBanner({ ...ok, suggest: false })).toBe(false);
    expect(shouldOfferBanner({ ...ok, dismissed: { codex: true } })).toBe(false);
    expect(shouldOfferBanner({ ...ok, dismissed: { claude: true } })).toBe(true);
    expect(shouldOfferBanner({ ...ok, nc: nc({ install: 'installed' }) })).toBe(false);
    expect(shouldOfferBanner({ ...ok, otherBannerShowing: true })).toBe(false);
    expect(shouldOfferBanner({ ...ok, seen: true })).toBe(false);
  });

  it('keys by session, CLI and launch', () => {
    expect(bannerKey('s1', nc({ launch: 3 }))).toBe('s1:codex:3');
    const l = createBannerLedger();
    expect(l.has('a')).toBe(false);
    l.mark('a');
    expect(l.has('a')).toBe(true);
    expect(createBannerLedger().has('a')).toBe(false);
  });
});

describe('McpSetupBanner', () => {
  it('AC12 shows iff every condition holds', async () => {
    await mount(base);
    expect(banner()).not.toBeNull();
    expect(banner()?.textContent).toContain(S.bannerBody('codex'));
    expect(button(S.bannerInstall('codex'))).toBeDefined();
  });

  const negatives: [string, () => void, Partial<Props>][] = [
    ['messaging off', () => {}, { messagingOn: false }],
    [
      'suggest off',
      () => {
        box.settings = { ...DEFAULT_SETTINGS, mcpInstallSuggest: false };
      },
      {},
    ],
    [
      'dismissed',
      () => {
        box.settings = { ...DEFAULT_SETTINGS, mcpInstallPromptDismissed: { codex: true } };
      },
      {},
    ],
    ['install ≠ not-installed', () => {}, { nc: nc({ install: 'installed' }) }],
    [
      'agentScope present',
      () => {},
      { session: session({ agentScope: { unseen: ['/x'], stillSeen: [], typeable: [] } }) },
    ],
    [
      'already seen',
      () => {
        ledger.mark(bannerKey('s1', nc()));
      },
      {},
    ],
    ['no not-connected entry', () => {}, { nc: undefined }],
  ];
  for (const [name, setup, over] of negatives) {
    it(`AC12 not shown when ${name}`, async () => {
      setup();
      await mount({ ...base, ...over });
      expect(banner()).toBeNull();
    });
  }

  it('AC12 another banner showing drops it for that launch (not queued)', async () => {
    const scoped = session({ agentScope: { unseen: ['/x'], stillSeen: [], typeable: [] } });
    await mount({ ...base, session: scoped });
    expect(banner()).toBeNull();
    await rerender({ ...base, session: session() });
    expect(banner()).toBeNull();
    await rerender({ ...base, session: session(), nc: nc({ launch: 2 }) });
    expect(banner()).not.toBeNull();
  });

  it('close × hides it for that key only', async () => {
    await mount(base);
    await act(async () => closeButton()?.click());
    expect(banner()).toBeNull();
    await rerender({ ...base, nc: nc() });
    expect(banner()).toBeNull();
    await rerender({ ...base, nc: nc({ launch: 2 }) });
    expect(banner()).not.toBeNull();
    // Nothing persisted: × is not "Don't suggest again".
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(
      bridge.post.mock.calls.some(([m]) => (m as WebviewToHost).type === 'updateSettings'),
    ).toBe(false);
  });

  it("AC12 Don't suggest again writes mcpInstallPromptDismissed[cli] = true", async () => {
    box.settings = { ...DEFAULT_SETTINGS, mcpInstallPromptDismissed: { claude: true } };
    await mount(base);
    await act(async () => button(S.bannerDismiss)?.click());
    expect(banner()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const last = bridge.post.mock.calls
      .map(([m]) => m as WebviewToHost)
      .filter((m) => m.type === 'updateSettings')
      .at(-1);
    expect(last?.type === 'updateSettings' && last.settings.mcpInstallPromptDismissed).toEqual({
      claude: true,
      codex: true,
    });
  });

  it('Install success → restart copy, kept after nc.install flips to installed', async () => {
    let resolve: (r: McpInstallResult) => void = () => {};
    bridge.mcpInstallAct.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await mount(base);
    await act(async () => button(S.bannerInstall('codex'))?.click());
    expect(bridge.mcpInstallAct).toHaveBeenCalledWith({
      cli: 'codex',
      scope: 'user',
      action: 'install',
    });
    expect(banner()?.textContent).toContain(S.bannerInstalling);
    for (const b of document.body.querySelectorAll<HTMLButtonElement>(
      '.mcp-banner__actions button',
    ))
      if (b !== closeButton()) expect(b.disabled).toBe(true);
    await act(async () =>
      resolve({
        ok: true,
        status: {
          cli: 'codex',
          found: true,
          user: { state: 'installed', path: '/h/.codex/config.toml' },
          project: null,
        },
      }),
    );
    expect(banner()?.textContent).toContain(S.bannerInstalled('codex'));
    expect(liveText()).toContain(S.bannerInstalled('codex'));
    await rerender({ ...base, nc: nc({ install: 'installed' }) });
    expect(banner()?.textContent).toContain(S.bannerInstalled('codex'));
  });

  it('Install failure → actionFailed + Open MCP settings calls onOpenMcpSettings(cli)', async () => {
    bridge.mcpInstallAct.mockResolvedValue({
      ok: false,
      errorCode: 'EACCES',
      status: {
        cli: 'codex',
        found: true,
        user: { state: 'error', path: '/h/.codex/config.toml', errorCode: 'EACCES' },
        project: null,
      },
    });
    await mount(base);
    await act(async () => button(S.bannerInstall('codex'))?.click());
    const failed = S.actionFailed('/h/.codex/config.toml', 'EACCES');
    expect(banner()?.textContent).toContain(failed);
    expect(liveText()).toContain(failed);
    await act(async () => button(S.bannerOpenSettings)?.click());
    expect(onOpenMcpSettings).toHaveBeenCalledWith('codex');
  });

  it('a rejected install invoke counts as a failure', async () => {
    bridge.mcpInstallAct.mockRejectedValue(new Error('boom'));
    await mount(base);
    await act(async () => button(S.bannerInstall('codex'))?.click());
    expect(banner()?.textContent).toContain(S.actionFailed('', 'EINVAL'));
    expect(button(S.bannerOpenSettings)).toBeDefined();
  });

  it('region role, label "Conduit setup", polite announcement "Conduit setup suggestion for Codex"', async () => {
    await mount(base);
    const region = document.body.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('Conduit setup');
    expect(region?.classList.contains('mcp-banner')).toBe(true);
    expect(liveText()).toContain('Conduit setup suggestion for Codex');
    expect(document.activeElement).toBe(document.body);
  });

  it('cursor-not-connected uses the same banner with Install for Cursor', async () => {
    await mount({
      ...base,
      nc: nc({ cli: 'cursor', reason: 'cursor-not-connected' }),
    });
    expect(banner()?.textContent).toContain(S.bannerBody('cursor'));
    expect(button('Install for Cursor')).toBeDefined();
  });
});
