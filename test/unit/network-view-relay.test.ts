import { describe, expect, it, vi } from 'vitest';
import { createViewRelay } from '../../server/network/view-relay';
import type { LinkFrame } from '../../src/contracts/link-protocol';

const machine = 'm-12345678';
const geometry = { cols: 80, rows: 24 };
function setup() {
  const frames: LinkFrame[] = [];
  const notifications: Array<{ peer: object; type: string; data: unknown }> = [];
  const caps = { messaging: true, monitor: true, drive: false };
  const link = {
    machineId: machine,
    state: 'up' as 'up' | 'down' | 'revoked',
    capabilities: { ...caps },
    peerCapabilities: { ...caps },
  };
  let linked = true;
  const close = vi.fn();
  let events:
    | {
        data(s: string): void;
        size(s: typeof geometry): void;
        end(reason: 'exited' | 'closed', code: number | null): void;
      }
    | undefined;
  const observe = vi.fn(async (_session: string, callbacks: NonNullable<typeof events>) => {
    events = callbacks;
    return { firstPaint: 'paint', size: geometry, close };
  });
  let room = true;
  const relay = createViewRelay({
    links: () => (linked ? [link] : []),
    sessions: () => [{ sessionId: 's1' }],
    observe,
    windowsPty: () => null,
    send: (_machine, frame) => {
      frames.push(frame);
      return room;
    },
    emitTo: (peer, type, data) => notifications.push({ peer, type, data }),
    now: () => 1000,
    newId: () => 'v1',
    log: () => {},
  });
  const open = (viewId = 'v1', sessionId = 's1') =>
    relay.onFrame(machine, { t: 'view.open', viewId, sessionId });
  return {
    relay,
    frames,
    notifications,
    link,
    observe,
    close,
    open,
    events: () => {
      if (!events) throw new Error('no observer');
      return events;
    },
    full: () => {
      room = false;
    },
    unlink: () => {
      linked = false;
    },
  };
}

describe('view relay', () => {
  it('refuses when monitor is off or the session is unknown', async () => {
    const h = setup();
    h.link.capabilities.monitor = false;
    await h.open();
    h.link.capabilities.monitor = true;
    await h.open('v2', 'unknown');
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.frames).toEqual([
      { t: 'view.end', viewId: 'v1', reason: 'refused', exitCode: null },
      { t: 'view.end', viewId: 'v2', reason: 'refused', exitCode: null },
    ]);
  });
  it.each(['off', 'revoke'] as const)('closes served views on %s', async (change) => {
    const h = setup();
    await h.open();
    if (change === 'off') h.link.capabilities.monitor = false;
    else h.link.state = 'revoked';
    h.relay.linkChanged(machine);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.frames.at(-1)).toMatchObject({ t: 'view.end', reason: 'refused' });
  });
  it('refuses the ninth view', async () => {
    const h = setup();
    for (let i = 0; i < 9; i++) await h.open(`v${i}`);
    expect(h.observe).toHaveBeenCalledTimes(8);
    expect(h.frames.at(-1)).toMatchObject({ t: 'view.end', viewId: 'v8', reason: 'refused' });
  });
  it('closes and requests resync when the send buffer is full', async () => {
    const h = setup();
    await h.open();
    h.full();
    h.events().data('output');
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.frames.at(-1)).toMatchObject({ t: 'view.end', reason: 'resync' });
  });
  it('freezes and reopens to resync then emits live and paint only to its owner', async () => {
    const h = setup();
    const peer = {};
    const attached = h.relay.attach(peer, machine, 's1');
    h.relay.onFrame(machine, {
      t: 'view.opened',
      viewId: 'v1',
      firstPaint: Buffer.from('paint').toString('base64'),
      size: geometry,
      windowsPty: null,
    });
    await expect(attached).resolves.toMatchObject({ viewId: 'v1', firstPaint: 'paint' });
    h.link.state = 'down';
    h.relay.linkChanged(machine);
    h.link.state = 'up';
    h.relay.linkChanged(machine);
    h.relay.onFrame(machine, {
      t: 'view.opened',
      viewId: 'v1',
      firstPaint: Buffer.from('new').toString('base64'),
      size: geometry,
      windowsPty: null,
    });
    expect(h.notifications.map((n) => [n.peer, n.type, n.data])).toEqual([
      [peer, 'remote.state', expect.objectContaining({ state: 'frozen' })],
      [peer, 'remote.state', expect.objectContaining({ state: 'resyncing' })],
      [peer, 'remote.state', expect.objectContaining({ state: 'live' })],
      [peer, 'remote.data', { viewId: 'v1', data: 'new' }],
    ]);
  });
  it('closes views when their C2 peer disconnects', async () => {
    const h = setup();
    const peer = {};
    const attached = h.relay.attach(peer, machine, 's1');
    h.relay.onFrame(machine, {
      t: 'view.opened',
      viewId: 'v1',
      firstPaint: '',
      size: geometry,
      windowsPty: null,
    });
    await attached;
    h.relay.disconnected(peer);
    expect(h.frames.at(-1)).toEqual({ t: 'view.close', viewId: 'v1' });
  });
});

it('does not send a paint if access is revoked while observe is pending', async () => {
  const h = setup();
  let resolve:
    | ((value: { firstPaint: string; size: typeof geometry; close: typeof h.close }) => void)
    | undefined;
  h.observe.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const opening = h.open();
  h.link.capabilities.monitor = false;
  h.relay.linkChanged(machine);
  if (!resolve) throw new Error('observe not called');
  resolve({ firstPaint: 'secret', size: geometry, close: h.close });
  await opening;
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.frames).toEqual([{ t: 'view.end', viewId: 'v1', reason: 'refused', exitCode: null }]);
});

it('does not let another C2 peer detach or receive a view', async () => {
  const h = setup();
  const owner = {};
  const other = {};
  const attached = h.relay.attach(owner, machine, 's1');
  h.relay.onFrame(machine, {
    t: 'view.opened',
    viewId: 'v1',
    firstPaint: '',
    size: geometry,
    windowsPty: null,
  });
  await attached;
  expect(() => h.relay.detach(other, 'v1')).toThrow();
  h.relay.onFrame(machine, {
    t: 'view.data',
    viewId: 'v1',
    data: Buffer.from('x').toString('base64'),
  });
  expect(h.notifications).toEqual([
    { peer: owner, type: 'remote.data', data: { viewId: 'v1', data: 'x' } },
  ]);
});

it('uses only observe while relaying a view', async () => {
  const h = setup();
  const runtime = { observe: h.observe, input: vi.fn(), resize: vi.fn() };
  await h.open();
  h.events().data('output');
  h.events().size({ cols: 90, rows: 40 });
  h.events().end('exited', 0);
  expect(runtime.observe).toHaveBeenCalledOnce();
  expect(runtime.input).not.toHaveBeenCalled();
  expect(runtime.resize).not.toHaveBeenCalled();
  expect(h.frames.map((f) => f.t)).toEqual(['view.opened', 'view.data', 'view.size', 'view.end']);
});

it('requests a fresh observer after a resync end', async () => {
  const h = setup();
  const peer = {};
  const attached = h.relay.attach(peer, machine, 's1');
  h.relay.onFrame(machine, {
    t: 'view.opened',
    viewId: 'v1',
    firstPaint: '',
    size: geometry,
    windowsPty: null,
  });
  await attached;
  h.relay.onFrame(machine, { t: 'view.end', viewId: 'v1', reason: 'resync', exitCode: null });
  expect(h.notifications.at(-1)).toMatchObject({
    peer,
    type: 'remote.state',
    data: { state: 'resyncing' },
  });
  expect(h.frames.at(-1)).toEqual({ t: 'view.open', viewId: 'v1', sessionId: 's1' });
});

describe('a forgotten machine', () => {
  it('ends its open view as exited when it leaves the link list', async () => {
    const h = setup();
    const peer = {};
    const attached = h.relay.attach(peer, machine, 's1');
    h.relay.onFrame(machine, {
      t: 'view.opened',
      viewId: 'v1',
      firstPaint: Buffer.from('paint').toString('base64'),
      size: geometry,
      windowsPty: null,
    });
    await attached;
    h.unlink();
    h.relay.linkChanged(machine);
    expect(h.notifications).toContainEqual({
      peer,
      type: 'remote.state',
      data: expect.objectContaining({ state: 'exited' }),
    });
  });
});
