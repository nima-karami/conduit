import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHcEvents } from '../../electron/hc-events';
import { createTerminalLinkFactory } from '../../electron/terminal-link';
import { FrameKind } from '../../src/contracts/frames';
import type { HcClient } from '../../src/contracts/hc';
import { APP_ATTACH_HISTORY_LINES, type TerminalLink } from '../../src/contracts/terminal-link';
import { PAINT_MAX_MS, PAINT_QUIET_MS } from '../../src/contracts/terminal-runtime';
import { NodeHcClient } from '../../src/hc-client';
import { FakeHc } from '../../src/hc-client/testing/fake-hc';
import type { TermGeometry } from '../../src/protocol';

const SIZE = { cols: 100, rows: 30 };
const TARGET = { hcSession: 'conduit-abc', terminal: 't1' };
const LABELS = { 'conduit.instance': 'abc' };

let fake: FakeHc;
let real: NodeHcClient;
let hcEvents: ReturnType<typeof createHcEvents>;
/** Everything the link did, in order: its hand-offs to the app and its calls on the stream. */
let trace: string[];
let streamCalls: { write: number; resize: number; facts: number };
/** The link's attach channels, recorded as each attach resolves: the link wires its paint in the same turn. */
let attached: number[];
let hc: HcClient;

beforeEach(async () => {
  fake = new FakeHc();
  await fake.listen();
  fake.terminals[0].labels = { ...LABELS };
  real = new NodeHcClient({ connect: fake.connect, reconnectDelayMs: 10 });
  hcEvents = createHcEvents(real, LABELS, () => {});
  await hcEvents.ready();
  trace = [];
  streamCalls = { write: 0, resize: 0, facts: 0 };
  attached = [];
  hc = {
    call: (m, p) => real.call(m, p),
    subscribe: (p, n) => real.subscribe(p, n),
    onConnection: (l) => real.onConnection(l),
    close: () => real.close(),
    attach: async (p) => {
      const r = await real.attach(p);
      const { stream } = r;
      attached.push(stream.channel);
      const credit = stream.credit.bind(stream);
      stream.credit = (n) => {
        trace.push(`credit:${n}`);
        credit(n);
      };
      stream.write = () => {
        streamCalls.write++;
      };
      stream.resize = () => {
        streamCalls.resize++;
      };
      stream.facts = () => {
        streamCalls.facts++;
      };
      return r;
    },
  };
});
afterEach(async () => {
  vi.useRealTimers();
  hcEvents.close();
  real.close();
  await fake.close();
});

function events() {
  const closed: [string, number | null, boolean][] = [];
  const sizes: TermGeometry[] = [];
  return {
    closed,
    sizes,
    handlers: {
      data: (d: string) => trace.push(`data:${d}`),
      size: (s: TermGeometry) => sizes.push(s),
      closed: (reason: string, code: number | null, restartable: boolean) =>
        closed.push([reason, code, restartable]),
    },
  };
}

const factory = () =>
  createTerminalLinkFactory({ hc, hcSession: TARGET.hcSession, hcEvents, log: () => {} });
const attachChannel = () => attached.at(-1) ?? -1;
const creditFrames = () =>
  fake.frames.filter((f) => f.kind === FrameKind.Credit && f.channel === attachChannel()).length;
/** Polls on setImmediate: vi.waitFor advances fake timers, which would end a paint early. */
async function io(check: () => boolean): Promise<void> {
  for (let i = 0; i < 5_000 && !check(); i++) await new Promise((r) => setImmediate(r));
  expect(check()).toBe(true);
}
const settled = async (p: Promise<unknown>) =>
  Promise.race([p.then(() => 'settled'), new Promise((r) => setImmediate(() => r('pending')))]);

describe('createTerminalLinkFactory', () => {
  it('attach is observe:true with history arg', async () => {
    const link = await factory().attach(
      's1',
      TARGET,
      SIZE,
      APP_ATTACH_HISTORY_LINES,
      events().handlers,
    );
    const attach = fake.calls.find((c) => c.method === 'terminal.attach');
    expect(attach?.params).toEqual({
      terminal: 't1',
      observe: true,
      history: APP_ATTACH_HISTORY_LINES,
      cols: 100,
      rows: 30,
    });
    expect(link.firstPaint).toEqual({ data: '', replay: [{ length: 0, geometry: SIZE }] });
  });

  it('first paint ends after PAINT_QUIET_MS quiet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fake.paint = Buffer.from('hello');
    const linked = factory().attach('s1', TARGET, SIZE, 2000, events().handlers);
    await io(() => creditFrames() === 1);
    vi.advanceTimersByTime(PAINT_QUIET_MS - 1);
    expect(await settled(linked)).toBe('pending');
    fake.send(attachChannel(), Buffer.from(' world'));
    await io(() => creditFrames() === 2);
    vi.advanceTimersByTime(PAINT_QUIET_MS - 1);
    expect(await settled(linked)).toBe('pending');
    vi.advanceTimersByTime(1);
    const link = await linked;
    expect(link.firstPaint).toEqual({
      data: 'hello world',
      replay: [{ length: 11, geometry: SIZE }],
    });
    expect(trace.filter((t) => t.startsWith('data:'))).toEqual([]);
  });

  it('first paint capped at PAINT_MAX_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const linked = factory().attach('s1', TARGET, SIZE, 2000, events().handlers);
    // The cap is armed in the turn the attach resolves; a timer count would also count any other.
    await io(() => attached.length === 1);
    expect(vi.getTimerCount()).toBe(1);
    const step = PAINT_QUIET_MS - 5;
    let sent = 0;
    for (let at = 0; at + step < PAINT_MAX_MS; at += step) {
      fake.send(attachChannel(), Buffer.from('x'));
      sent++;
      await io(() => creditFrames() === sent);
      vi.advanceTimersByTime(step);
    }
    expect(await settled(linked)).toBe('pending');
    vi.advanceTimersByTime(step);
    const link = await linked;
    expect(link.firstPaint.data).toBe('x'.repeat(sent));
    fake.send(attachChannel(), Buffer.from('late'));
    await io(() => trace.includes('data:late'));
  });

  it('credit returned after data hand-off', async () => {
    const link = await factory().attach('s1', TARGET, SIZE, 2000, events().handlers);
    trace.length = 0;
    fake.send(attachChannel(), Buffer.from('abc'));
    await vi.waitFor(() => expect(trace).toEqual(['data:abc', 'credit:3']));
    link.close();
  });

  it('disconnected close is restartable; exited is not', async () => {
    const first = events();
    let link: TerminalLink | undefined = await factory().attach(
      's1',
      TARGET,
      SIZE,
      2000,
      first.handlers,
    );
    fake.end(attachChannel(), { reason: 'exited', exit_code: 7, signal: null });
    await vi.waitFor(() => expect(first.closed).toEqual([['exited', 7, false]]));
    const second = events();
    link = await factory().attach('s1', TARGET, SIZE, 2000, second.handlers);
    expect(link.sessionId).toBe('s1');
    fake.disconnect();
    await vi.waitFor(() => expect(second.closed).toEqual([['disconnected', null, true]]));
  });

  it('never calls write/resize/facts', async () => {
    const e = events();
    fake.paint = Buffer.from('paint');
    const link = await factory().attach('s1', TARGET, SIZE, 2000, e.handlers);
    fake.send(attachChannel(), Buffer.from('data'));
    fake.emit(fake.terminals[0], 'size', { cols: 120, rows: 40 });
    await vi.waitFor(() => expect(e.sizes).toEqual([{ cols: 120, rows: 40 }]));
    await vi.waitFor(() => expect(trace).toContain('data:data'));
    link.close();
    await real.call('server.status', {});
    expect(streamCalls).toEqual({ write: 0, resize: 0, facts: 0 });
    // A detach the app asked for is not reported as a close.
    expect(e.closed).toEqual([]);
  });
});
