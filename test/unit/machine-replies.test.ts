import { describe, expect, it, vi } from 'vitest';
import {
  disconnectOutcome,
  MACHINE_OK,
  machineActionReply,
  machineFault,
  openSetupPaneReply,
  probeAgentsReply,
} from '../../electron/machine-replies';
import { ServerCallError } from '../../electron/server-client';
import type {
  ConnectMachineOk,
  DisconnectMachineResult,
  MachineActionResult,
} from '../../src/contracts/machines';

const connectOk: ConnectMachineOk = {
  machine: 'box',
  machine_id: 'm1',
  state: 'up',
  os: 'linux',
  arch: 'x64',
  mode: 'full',
  conduit_version: '0.52.0',
  reused: false,
  installed: true,
  upgraded: false,
};

describe('machineFault', () => {
  it('maps not_found to machine_unknown', () => {
    expect(machineFault(new ServerCallError('not_found', 'x'))).toEqual({
      code: 'machine_unknown',
      detail: { reason: 'not_found' },
    });
  });

  it('maps any other fault to ssh_unreachable with its code as the reason', () => {
    expect(machineFault(new ServerCallError('peer_unreachable', 'x'))).toEqual({
      code: 'ssh_unreachable',
      detail: { reason: 'peer_unreachable' },
    });
  });

  it('a non-fault error has no code, so the reason is failed', () => {
    expect(machineFault(new Error('boom'))).toEqual({
      code: 'ssh_unreachable',
      detail: { reason: 'failed' },
    });
  });
});

describe('disconnectOutcome', () => {
  it('an ok disconnect carries no value', () => {
    const r: DisconnectMachineResult = { ok: true, value: { machine: 'box', state: 'down' } };
    expect(disconnectOutcome(r)).toEqual({ ok: true, value: null });
  });

  it('a failed disconnect passes its error through', () => {
    const error = { code: 'ssh_unreachable' as const, detail: { reason: 'x' } };
    expect(disconnectOutcome({ ok: false, error })).toEqual({ ok: false, error });
  });
});

describe('machineActionReply', () => {
  it('a thrown not_found replies machine_unknown and logs the fault', async () => {
    const warn = vi.fn();
    const reply = await machineActionReply(
      5,
      'rename',
      async () => {
        throw new ServerCallError('not_found', 'no such machine');
      },
      warn,
    );

    expect(reply).toEqual({
      type: 'machines:result',
      requestId: 5,
      result: { ok: false, error: { code: 'machine_unknown', detail: { reason: 'not_found' } } },
    });
    expect(warn).toHaveBeenCalledWith('rename failed', {
      err: expect.stringContaining('no such machine'),
    });
  });

  it('a connect ok:false result passes through unchanged', async () => {
    const result: MachineActionResult = {
      ok: false,
      error: { code: 'ssh_needs_person', detail: { target: 'user@box' }, candidates: ['a'] },
    };
    const warn = vi.fn();
    const reply = await machineActionReply(1, 'connect', async () => result, warn);

    expect(reply.result).toBe(result);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a connect ok result carries the ConnectMachineOk value', async () => {
    const reply = await machineActionReply(
      2,
      'connect',
      async () => ({ ok: true, value: connectOk }),
      vi.fn(),
    );

    expect(reply.result).toEqual({ ok: true, value: connectOk });
  });

  it('a successful rename or remove replies MACHINE_OK', async () => {
    const reply = await machineActionReply(3, 'remove', async () => MACHINE_OK, vi.fn());

    expect(reply).toEqual({
      type: 'machines:result',
      requestId: 3,
      result: { ok: true, value: null },
    });
  });
});

describe('openSetupPaneReply', () => {
  it('an opened pane replies its session id with no error', async () => {
    const reply = await openSetupPaneReply(7, async () => ({ sessionId: 's-9' }), vi.fn());

    expect(reply).toEqual({
      type: 'machines:paneOpened',
      requestId: 7,
      sessionId: 's-9',
      error: null,
    });
  });

  it('a C2 fault replies its code with no session id and logs it', async () => {
    const warn = vi.fn();
    const reply = await openSetupPaneReply(
      8,
      async () => {
        throw new ServerCallError('peer_unreachable', 'box is down');
      },
      warn,
    );

    expect(reply).toEqual({
      type: 'machines:paneOpened',
      requestId: 8,
      sessionId: null,
      error: 'peer_unreachable',
    });
    expect(warn).toHaveBeenCalledWith('openSetupPane failed', {
      err: expect.stringContaining('box is down'),
    });
  });

  it('a non-fault error replies failed', async () => {
    const reply = await openSetupPaneReply(
      9,
      async () => {
        throw new Error('boom');
      },
      vi.fn(),
    );

    expect(reply).toEqual({
      type: 'machines:paneOpened',
      requestId: 9,
      sessionId: null,
      error: 'failed',
    });
  });
});

describe('probeAgentsReply', () => {
  it('a probe replies the CLI list with no error', async () => {
    const reply = await probeAgentsReply(
      10,
      async () => ({ agents: ['claude', 'codex'] }),
      vi.fn(),
    );

    expect(reply).toEqual({
      type: 'machines:agents',
      requestId: 10,
      agents: ['claude', 'codex'],
      error: null,
    });
  });

  it('a C2 fault replies its code with no list and logs it', async () => {
    const warn = vi.fn();
    const reply = await probeAgentsReply(
      11,
      async () => {
        throw new ServerCallError('peer_unreachable', 'timed out');
      },
      warn,
    );

    expect(reply).toEqual({
      type: 'machines:agents',
      requestId: 11,
      agents: null,
      error: 'peer_unreachable',
    });
    expect(warn).toHaveBeenCalledWith('probeAgents failed', {
      err: expect.stringContaining('timed out'),
    });
  });
});
