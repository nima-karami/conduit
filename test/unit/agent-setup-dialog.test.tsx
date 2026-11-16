// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MachineView } from '../../src/contracts/machines';
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
});
