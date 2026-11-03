import { afterEach, describe, expect, it, vi } from 'vitest';
import { compose, emptySnapshot } from '../../server/compose';
import type { ShellCore } from '../../server/lifecycle/shell';
import { STOP_FAILED_EXIT } from '../../server/lifecycle/shell';
import type { PipeTransport } from '../../server/transport/pipe';
import { SERVER_EXIT } from '../../src/contracts/session-identity';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function setup(overrides: Partial<ShellCore> = {}) {
  const emitted: string[] = [];
  const transport = {
    emit: (type: string) => emitted.push(type),
    seq: 0,
  } as unknown as PipeTransport;
  const core: ShellCore = {
    start: () => new Promise(() => {}),
    beginStopping: vi.fn(async () => {}),
    killSessions: vi.fn(async () => 4),
    persist: vi.fn(async () => {}),
    idleState: async () => ({ liveTerminals: 0, pendingTimers: false, busyTokens: false }),
    snapshot: emptySnapshot,
    ...overrides,
  };
  const exit = vi.fn();
  const writeLog = vi.fn();
  const shell = compose({
    transport,
    core,
    version: '0.52.0',
    instance: 'abc',
    logPath: '/log',
    exit,
    writeLog,
  });
  disposers.push(() => shell.lifecycle.dispose());
  const call = (method: string, params: object = {}) =>
    shell.handle({ id: 1, method, params }, { subscribed: true, order: 'same' });
  return { shell, core, exit, emitted, writeLog, call };
}

describe('compose stopAll', () => {
  it('answers the C2 route with the killed count and exits doneCoreIdle after the reply', async () => {
    const x = setup();
    const answer = await x.call('server.stopAll');
    expect(answer).toMatchObject({ result: { killed: 4 } });
    expect(x.exit).not.toHaveBeenCalled();
    if ('afterReply' in answer) await answer.afterReply?.();
    expect(x.exit).toHaveBeenCalledWith(SERVER_EXIT.doneCoreIdle);
    expect(x.emitted).toEqual(['server.stopping']);
  });

  it('shell.stopAll is the same transition the route uses', async () => {
    const x = setup();
    const first = await x.shell.stopAll();
    const second = await x.call('server.stopAll');
    expect(first).toMatchObject({ kind: 'ok', killed: 4 });
    expect(second).toMatchObject({ result: { killed: 4 } });
    expect(x.core.killSessions).toHaveBeenCalledTimes(1);
    expect(x.emitted).toEqual(['server.stopping']);
  });

  it('reports a failed stop on both paths and exits with the failure code', async () => {
    const x = setup({
      killSessions: vi.fn(async () => {
        throw new Error('kill blew up');
      }),
    });
    const outcome = await x.shell.stopAll();
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    await outcome.afterReply();
    expect(x.exit).toHaveBeenCalledWith(STOP_FAILED_EXIT);
    expect(await x.call('server.stopAll')).toMatchObject({ error: expect.any(Error) });
    expect(x.writeLog).toHaveBeenCalledWith(expect.stringContaining('server.stopAll failed'));
  });

  it('answers late once a restart has frozen its mode, on both paths', async () => {
    let release: () => void = () => {};
    const x = setup({
      persist: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const restart = x.call('server.restart', { reason: 'user' });
    await vi.waitFor(() => expect(x.core.persist).toHaveBeenCalled());
    expect(await x.shell.stopAll()).toEqual({ kind: 'late' });
    expect(await x.call('server.stopAll')).toEqual({ reply: false });
    release();
    expect(await restart).toMatchObject({ result: {} });
  });
});
