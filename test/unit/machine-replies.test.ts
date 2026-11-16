import { describe, expect, it, vi } from 'vitest';
import {
  disconnectOutcome,
  MACHINE_OK,
  machineActionReply,
  machineFault,
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
