import { afterEach, describe, expect, it, vi } from 'vitest';
import { compose, emptySnapshot } from '../../server/compose';
import type { ShellCore } from '../../server/lifecycle/shell';
import { type Peer, PipeTransport, RpcFault } from '../../server/transport/pipe';

const SECRET = 'a'.repeat(43);
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function setup() {
  const transport = new PipeTransport('unused-endpoint', 'posix');
  const core: ShellCore = {
    start: () => new Promise(() => {}),
    beginStopping: vi.fn(async () => {}),
    killSessions: vi.fn(async () => 0),
    persist: vi.fn(async () => {}),
    idleState: async () => ({ liveTerminals: 0, pendingTimers: false, busyTokens: false }),
    snapshot: emptySnapshot,
  };
  const shell = compose({
    transport,
    core,
    version: '0.52.0',
    instance: 'abc',
    logPath: '/log',
    exit: vi.fn(),
    writeLog: vi.fn(),
    secret: SECRET,
  });
  disposers.push(() => shell.lifecycle.dispose());
  const peer: Peer = { subscribed: false };
  const call = (method: string, params: object) =>
    Promise.resolve().then(() => shell.handle({ method, params }, peer));
  return { call, peer };
}

const hello = { appVersion: '0.52.0', generation: 1 };

describe('C2 hello auth gate', () => {
  it.each([
    ['no auth', {}],
    ['a wrong auth', { auth: 'b'.repeat(43) }],
    ['a wrong-length auth', { auth: 'short' }],
  ])('a method before an authed hello is refused (%s)', async (_label, extra) => {
    const { call } = setup();
    expect(await call('hello', { ...hello, ...extra })).toMatchObject({
      result: { serverVersion: '0.52.0' },
    });
    const refused = await call('events.subscribe', {}).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RpcFault);
    expect(refused).toMatchObject({ kind: 'refused', message: 'auth required' });
  });

  it('hello with the right auth unlocks methods', async () => {
    const { call } = setup();
    await call('hello', { ...hello, auth: SECRET });
    expect(await call('events.subscribe', {})).toMatchObject({
      result: { seq: 0, sessions: [] },
    });
  });
});
