// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentCli } from '../../src/conduit-mcp/install-types';
import type { AgentSetupStep, MachineView } from '../../src/contracts/machines';
import { AgentSetupDialog } from '../../webview/components/agent-setup-dialog';
import { MACHINES_STR } from '../../webview/machines-strings';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const machine = (o: Partial<MachineView> = {}): MachineView => ({
  machine: 'win-box',
  machine_id: 'm-0000000b',
  target: 'user@win',
  state: 'up',
  mode: 'full',
  os: 'linux',
  arch: 'x64',
  conduit_version: '0.66.0',
  agents: ['claude'],
  sessions: 0,
  last_seen: null,
  survives_logout: null,
  ...o,
});

const ok = { ok: true as const, value: null };

type Props = Partial<Parameters<typeof AgentSetupDialog>[0]> & { machine?: MachineView };

async function render(p: Props = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      createElement(AgentSetupDialog, {
        machine: p.machine ?? machine(),
        onSetMode: p.onSetMode ?? (() => Promise.resolve(ok)),
        onOpenPane: p.onOpenPane ?? (() => Promise.resolve({ sessionId: 's1', error: null })),
        onRefresh: p.onRefresh ?? (() => Promise.resolve({ agents: ['claude'], error: null })),
        onClose: p.onClose ?? (() => {}),
      }),
    ),
  );
}

const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;
const rowOf = (name: string) =>
  [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(name)) ?? null;
const radio = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (b) => b.textContent === text,
  ) ?? null;
const click = async (el: HTMLElement | null) => act(async () => el?.click());

describe('AgentSetupDialog', () => {
  it('is a labelled dialog with a polite status region', async () => {
    await render();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain(MACHINES_STR.setupTitle('win-box'));
    expect(document.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('mode toggle calls onSetMode with light', async () => {
    const onSetMode = vi.fn((_m: 'full' | 'light') => Promise.resolve(ok));
    await render({ onSetMode });
    await click(buttonNamed(MACHINES_STR.modeLight));
    expect(onSetMode).toHaveBeenCalledWith('light');
  });

  it('Install shows for a missing CLI and Log in for an installed one', async () => {
    const onOpenPane = vi.fn((_c: string, _s: string) =>
      Promise.resolve({ sessionId: 's1', error: null }),
    );
    await render({ machine: machine({ agents: ['claude'] }), onOpenPane });
    expect(rowOf('Claude Code')?.textContent).toContain(MACHINES_STR.installed);
    expect(rowOf('Claude Code')?.textContent).toContain(MACHINES_STR.logIn);
    expect(rowOf('Codex')?.textContent).toContain(MACHINES_STR.notInstalled);
    await click(rowOf('Codex')?.querySelector('button') ?? null);
    expect(onOpenPane).toHaveBeenCalledWith('codex', 'install');
  });

  it('Refresh calls onRefresh and shows the checking state', async () => {
    let finish: (v: { agents: string[] | null; error: string | null }) => void = () => {};
    const onRefresh = vi.fn(
      () =>
        new Promise<{ agents: string[] | null; error: string | null }>((resolve) => {
          finish = resolve;
        }),
    );
    await render({ onRefresh });
    await click(buttonNamed(MACHINES_STR.refresh));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(MACHINES_STR.checking);
    await act(async () => finish({ agents: ['codex'], error: null }));
    expect(document.body.textContent).not.toContain(MACHINES_STR.checking);
    expect(rowOf('Codex')?.textContent).toContain(MACHINES_STR.logIn);
    expect(rowOf('Claude Code')?.textContent).toContain(MACHINES_STR.notInstalled);
  });

  it('light mode hides the checklist', async () => {
    await render({ machine: machine({ mode: 'light' }) });
    expect(document.querySelector('ul')).toBeNull();
    expect(document.body.textContent).toContain(MACHINES_STR.modeLightHint);
    expect(buttonNamed(MACHINES_STR.install)).toBeNull();
  });

  it('a pane error shows on its row', async () => {
    await render({
      onOpenPane: () => Promise.resolve({ sessionId: null, error: 'peer_unreachable' }),
    });
    await click(buttonNamed(MACHINES_STR.logIn));
    expect(rowOf('Claude Code')?.textContent).toContain(MACHINES_STR.paneError('peer_unreachable'));
    expect(rowOf('Codex')?.textContent).not.toContain(MACHINES_STR.paneError('peer_unreachable'));
  });

  it('a pending pane request says Opening a terminal on its row', async () => {
    let finish: (v: { sessionId: string | null; error: string | null }) => void = () => {};
    await render({
      onOpenPane: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await click(buttonNamed(MACHINES_STR.logIn));
    expect(rowOf('Claude Code')?.textContent).toContain(MACHINES_STR.openingTerminal);
    await act(async () => finish({ sessionId: 's1', error: null }));
    expect(rowOf('Claude Code')?.textContent).not.toContain(MACHINES_STR.openingTerminal);
  });

  it('the Close button closes the dialog', async () => {
    const onClose = vi.fn();
    await render({ onClose });
    await click(buttonNamed(MACHINES_STR.close));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("a failed mode change reverts to the machine's mode", async () => {
    await render({
      machine: machine({ mode: 'full' }),
      onSetMode: () =>
        Promise.resolve({ ok: false, error: { code: 'ssh_unreachable', detail: {} } }),
    });
    await click(buttonNamed(MACHINES_STR.modeLight));
    expect(radio(MACHINES_STR.modeFull)?.getAttribute('aria-checked')).toBe('true');
    expect(radio(MACHINES_STR.modeLight)?.getAttribute('aria-checked')).toBe('false');
    expect(document.body.textContent).toContain(
      MACHINES_STR.errorText({ code: 'ssh_unreachable', detail: {} }),
    );
  });

  it('the mode control is disabled while a change is pending', async () => {
    const onSetMode = vi.fn(() => new Promise<typeof ok>(() => {}));
    await render({ onSetMode });
    await click(buttonNamed(MACHINES_STR.modeLight));
    expect(radio(MACHINES_STR.modeFull)?.disabled).toBe(true);
    expect(radio(MACHINES_STR.modeLight)?.disabled).toBe(true);
    await click(radio(MACHINES_STR.modeFull));
    expect(onSetMode).toHaveBeenCalledTimes(1);
  });

  it('the selected mode takes focus on open', async () => {
    await render({ machine: machine({ mode: 'light' }) });
    expect(document.activeElement).toBe(radio(MACHINES_STR.modeLight));
  });

  it('retrying a row clears its error', async () => {
    let finish: (v: { sessionId: string | null; error: string | null }) => void = () => {};
    const onOpenPane = vi
      .fn<
        (
          c: AgentCli,
          s: AgentSetupStep,
        ) => Promise<{ sessionId: string | null; error: string | null }>
      >()
      .mockResolvedValueOnce({ sessionId: null, error: 'peer_unreachable' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    await render({ onOpenPane });
    await click(buttonNamed(MACHINES_STR.logIn));
    expect(rowOf('Claude Code')?.textContent).toContain(MACHINES_STR.paneError('peer_unreachable'));
    await click(buttonNamed(MACHINES_STR.logIn));
    expect(rowOf('Claude Code')?.textContent).not.toContain(
      MACHINES_STR.paneError('peer_unreachable'),
    );
    await act(async () => finish({ sessionId: 's2', error: null }));
  });

  it('a timed-out pane request shows the timeout line on its row', async () => {
    await render({
      onOpenPane: () => Promise.resolve({ sessionId: null, error: 'timeout' }),
    });
    await click(buttonNamed(MACHINES_STR.logIn));
    expect(rowOf('Claude Code')?.textContent).toContain(MACHINES_STR.paneError('timeout'));
  });

  it('clicking Install twice sends one request', async () => {
    const onOpenPane = vi.fn(
      (_c: AgentCli, _s: AgentSetupStep) =>
        new Promise<{ sessionId: string | null; error: string | null }>(() => {}),
    );
    await render({ machine: machine({ agents: [] }), onOpenPane });
    const install = rowOf('Codex')?.querySelector('button') ?? null;
    await act(async () => {
      install?.click();
      install?.click();
    });
    expect(onOpenPane).toHaveBeenCalledTimes(1);
    expect(onOpenPane).toHaveBeenCalledWith('codex', 'install');
  });

  it('Escape calls onClose', async () => {
    const onClose = vi.fn();
    await render({ onClose });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
