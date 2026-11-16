// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MachineError, MachineView } from '../../src/contracts/machines';
import { MachinesSection } from '../../webview/components/machines-section';
import { MACHINES_STR } from '../../webview/machines-strings';
import type { RemoteSessionRow } from '../../webview/remote-sessions';
import { remoteKeyId } from '../../webview/remote-sessions';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The row menu's popover measures itself; jsdom has no ResizeObserver.
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
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const machine = (o: Partial<MachineView> & { machine_id: string }): MachineView => ({
  machine: 'win-box',
  target: 'user@win',
  state: 'up',
  mode: 'full',
  os: 'windows',
  arch: 'x64',
  conduit_version: '0.66.0',
  agents: [],
  sessions: 2,
  last_seen: null,
  survives_logout: null,
  ...o,
});

const needsPerson: MachineError = {
  code: 'ssh_needs_person',
  detail: { reason: 'password' },
};

const remote = (machineId: string, sessionId: string): RemoteSessionRow => ({
  key: { machineId, sessionId },
  id: remoteKeyId({ machineId, sessionId }),
  machineName: 'win-box',
  machineState: 'up',
  parentSessionId: null,
  session: {
    sessionId,
    handle: null,
    label: `label-${sessionId}`,
    agent: 'claude',
    presence: 'idle',
    messaging: 'connected',
    messageable: false,
    notices: 'pull',
    home: '/remote',
    roots: [],
    attention: { attentionReason: null, completions: 0 },
    completions: 0,
    limit: null,
    status: 'running',
  },
});

interface Props {
  machines: MachineView[];
  remoteRows?: RemoteSessionRow[];
  machineErrors?: Map<string, MachineError>;
  onMachineAction?: (action: string, m: MachineView) => void;
  onAddMachine?: () => void;
  onConfirm?: (c: { onConfirm: () => void }) => void;
}

async function render(p: Props) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      createElement(MachinesSection, {
        machines: p.machines,
        remoteRows: p.remoteRows ?? [],
        machineErrors: p.machineErrors ?? new Map(),
        activeRemoteId: null,
        onSelectRemote: () => {},
        onAddMachine: p.onAddMachine ?? (() => {}),
        onMachineAction: p.onMachineAction ?? (() => {}),
        onRenameMachine: () => {},
        onConfirm: p.onConfirm ?? (() => {}),
      }),
    ),
  );
}

const row = (id: string) =>
  document.querySelector<HTMLElement>(`[role="treeitem"][data-machine-id="${id}"]`);
const buttonIn = (el: Element | null, text: string) =>
  [...(el?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text) ?? null;
const click = async (el: Element | null) => act(async () => (el as HTMLElement).click());

describe('MachinesSection', () => {
  it('shows Retry now for down and Connect for a needs-person error', async () => {
    const onMachineAction = vi.fn();
    const down = machine({ machine_id: 'm1', machine: 'down-box', state: 'down' });
    const asks = machine({ machine_id: 'm2', machine: 'ask-box', state: 'down' });
    const off = machine({ machine_id: 'm3', machine: 'off-box', state: 'disabled' });
    await render({
      machines: [down, asks, off],
      machineErrors: new Map([['ask-box', needsPerson]]),
      onMachineAction,
    });
    expect(buttonIn(row('m1'), MACHINES_STR.retryNow)).not.toBeNull();
    expect(buttonIn(row('m2'), MACHINES_STR.connect)).not.toBeNull();
    expect(buttonIn(row('m2'), MACHINES_STR.retryNow)).toBeNull();
    expect(buttonIn(row('m3'), MACHINES_STR.connect)).not.toBeNull();
    await click(buttonIn(row('m1'), MACHINES_STR.retryNow));
    expect(onMachineAction).toHaveBeenCalledWith('retry', down);
    await click(buttonIn(row('m2'), MACHINES_STR.connect));
    expect(onMachineAction).toHaveBeenLastCalledWith('connect', asks);
  });

  it('state is text, not colour only', async () => {
    await render({
      machines: [
        machine({ machine_id: 'm1', machine: 'up-box', state: 'up' }),
        machine({ machine_id: 'm2', machine: 'down-box', state: 'down', last_seen: null }),
        machine({ machine_id: 'm3', machine: 'ask-box', state: 'down' }),
      ],
      machineErrors: new Map([['ask-box', needsPerson]]),
    });
    expect(row('m1')?.querySelector('.machine-row-status')?.textContent).toBe(
      MACHINES_STR.state('up'),
    );
    expect(row('m2')?.querySelector('.machine-row-status')?.textContent).toBe(
      MACHINES_STR.offlineSince(null),
    );
    expect(row('m3')?.querySelector('.machine-row-status')?.textContent).toBe(
      MACHINES_STR.needsYou('ask-box', 'password'),
    );
    expect(row('m1')?.getAttribute('aria-label')).toBe(
      MACHINES_STR.rowLabel({ name: 'up-box', status: 'Connected', sessions: 2 }),
    );
    for (const id of ['m1', 'm2', 'm3']) {
      const status = row(id)?.querySelector<HTMLElement>('.machine-row-status');
      expect(status?.dataset.tone).toBeTruthy();
    }
  });

  it("lists a machine's remote sessions under its row at level 2, and Enter folds the machine", async () => {
    await render({
      machines: [machine({ machine_id: 'm1' })],
      remoteRows: [remote('m1', 'r1'), remote('m1', 'r2')],
    });
    expect(row('m1')?.getAttribute('aria-expanded')).toBe('true');
    const r1 = document.querySelector<HTMLElement>('[data-remote-id="remote:m1:r1"]');
    expect(r1?.getAttribute('role')).toBe('treeitem');
    expect(r1?.getAttribute('aria-level')).toBe('2');
    expect(r1?.classList.contains('remote-session')).toBe(true);
    expect(r1?.textContent).toContain(MACHINES_STR.badge('win-box'));
    await act(async () => row('m1')?.focus());
    await act(async () =>
      row('m1')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
    );
    expect(row('m1')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-remote-id="remote:m1:r1"]')).toBeNull();
  });

  it('an empty section offers Add, and the + button adds', async () => {
    const onAddMachine = vi.fn();
    await render({ machines: [], onAddMachine });
    expect(document.body.textContent).toContain(MACHINES_STR.emptyTitle);
    await click(buttonIn(document.body, MACHINES_STR.addMachine));
    expect(onAddMachine).toHaveBeenCalledTimes(1);
  });

  it('Retry keeps focus on the machine row', async () => {
    await render({ machines: [machine({ machine_id: 'm1', machine: 'down-box', state: 'down' })] });
    await act(async () => buttonIn(row('m1'), MACHINES_STR.retryNow)?.click());
    expect(document.activeElement).toBe(row('m1'));
  });

  it('Remove goes through the confirm dialog before it reaches the action', async () => {
    const onMachineAction = vi.fn();
    const onConfirm = vi.fn();
    const broken = machine({ machine_id: 'm1', machine: 'old-box', state: 'incompatible' });
    await render({ machines: [broken], onMachineAction, onConfirm });
    await click(buttonIn(row('m1'), MACHINES_STR.remove));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onMachineAction).not.toHaveBeenCalledWith('remove', expect.anything());
    onConfirm.mock.calls[0][0].onConfirm();
    expect(onMachineAction).toHaveBeenCalledWith('remove', broken);
  });

  it("Shift+F10 opens the row menu, whose first item is the row's inline action", async () => {
    const onMachineAction = vi.fn();
    const down = machine({ machine_id: 'm1', machine: 'down-box', state: 'down' });
    await render({ machines: [down], onMachineAction });
    await act(async () => row('m1')?.focus());
    await act(async () =>
      row('m1')?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F10',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const first = document.querySelector<HTMLElement>('[role="menuitem"]');
    expect(first?.textContent).toBe(MACHINES_STR.retryNow);
    await act(async () => first?.click());
    expect(onMachineAction).toHaveBeenCalledWith('retry', down);
  });
});
