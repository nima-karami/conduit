import { afterEach, describe, expect, it } from 'vitest';
import {
  type Harness,
  harness,
  hcLabelsFor,
  INSTANCE,
  labelsFor,
  launch,
} from '../../server/runtime/testing/harness';
import { createTyping } from '../../server/runtime/typing';
import { FrameKind } from '../../src/contracts/frames';
import type { HcTerminal } from '../../src/contracts/hc';
import { FakeRpcError } from '../../src/hc-client/testing/fake-hc';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const spec = { command: 'node', args: ['-e', '1'], cwd: '/work', env: { A: '1' } };
const calls = (method: string) => h.fake.calls.filter((c) => c.method === method);

async function started(overrides?: Parameters<typeof harness>[0]) {
  h = await harness(overrides);
  await h.runtime.start();
  return h;
}

async function spawned(sessionId = 's1', n = 1) {
  const ids = launch(n);
  await h.tokens.reserve(sessionId, ids);
  const result = await h.runtime.spawn(sessionId, spec, labelsFor(sessionId, ids), ids);
  return { ids, result };
}

function lateTerminal(name: string, labels: Record<string, string>): HcTerminal {
  const record: HcTerminal = {
    address: `late-${name.slice(-4)}`,
    name,
    labels,
    argv: ['node'],
    cwd: '/work',
    state: 'live',
    created_ms: 1,
    screen: 'exact',
    cols: 120,
    rows: 40,
  };
  h.fake.terminals.push(record);
  h.fake.emit(record, 'created', record);
  return record;
}

describe('TerminalRuntime spawn', () => {
  it('a reply resolves the launch and takes the active attach at the last size, facts as display', async () => {
    await started();
    h.runtime.resize('s1', { cols: 90, rows: 30 });
    h.runtime.facts('s1', { fg: '#ffffff', cell: [8, 16] });
    const { ids, result } = await spawned();
    expect(result).toMatchObject({ ok: true, terminal: { generation: 1, launchId: ids.launchId } });
    const address = h.tokens.row(ids.launchId)?.hcAddress;
    expect(h.tokens.row(ids.launchId)?.state).toBe('live');
    expect(calls('terminal.attach').at(-1)?.params).toEqual({
      terminal: address,
      cols: 90,
      rows: 30,
      display: { fg: '#ffffff', cell: [8, 16] },
    });
    expect(h.events.filter((e) => e.type === 'spawned')).toEqual([
      { type: 'spawned', sessionId: 's1', generation: 1, size: { cols: 90, rows: 30 } },
    ]);
  });

  it('runs with the fixed flags, name = launch id, TERM_PROGRAM=conduit and no HC_* in env', async () => {
    await started();
    const ids = launch(7);
    const env = { A: '1', HC_SESSION: 'user', hc_terminal_id: 'x', TERM_PROGRAM: 'ghostty' };
    await h.runtime.spawn('s1', { ...spec, env }, labelsFor('s1', ids), ids);
    expect(calls('terminal.run')[0]?.params).toEqual({
      argv: ['node', '-e', '1'],
      cwd: '/work',
      env: { A: '1', TERM_PROGRAM: 'conduit', TERM_PROGRAM_VERSION: '9.9.9' },
      labels: labelsFor('s1', ids),
      name: ids.launchId,
      keep: false,
      no_parent: true,
      no_notify: true,
    });
  });

  it('connection lost before the reply: row and event unconfirmed, never retried', async () => {
    await started();
    h.fake.onCall('terminal.run', () => {
      setImmediate(() => h.fake.disconnect());
      return new Promise(() => {});
    });
    const { ids, result } = await spawned();
    expect(result).toEqual({
      ok: false,
      refusal: { reason: 'spawn_unconfirmed', launchId: ids.launchId },
    });
    expect(h.tokens.row(ids.launchId)?.state).toBe('unconfirmed');
    expect(h.events).toContainEqual({
      type: 'unconfirmed',
      sessionId: 's1',
      generation: 1,
      launchId: ids.launchId,
    });
    await expect.poll(() => h.events.some((e) => e.type === 'resynced')).toBe(true);
    expect(calls('terminal.run')).toHaveLength(1);
    expect(h.tokens.row(ids.launchId)?.state).toBe('unconfirmed');
  });

  it('a later `created` by name adopts the unconfirmed launch', async () => {
    await started();
    h.fake.onCall('terminal.run', () => {
      setImmediate(() => h.fake.disconnect());
      return new Promise(() => {});
    });
    const { ids } = await spawned();
    await expect.poll(() => h.events.some((e) => e.type === 'resynced')).toBe(true);
    const record = lateTerminal(ids.launchId, hcLabelsFor('s1', ids));
    await expect.poll(() => h.tokens.row(ids.launchId)?.state).toBe('live');
    expect(h.tokens.row(ids.launchId)?.hcAddress).toBe(record.address);
    await expect.poll(() => h.runtime.get('s1')?.target.terminal).toBe(record.address);
    expect(h.events.filter((e) => e.type === 'spawned')).toHaveLength(1);
    expect(calls('terminal.kill')).toHaveLength(0);
  });

  it('a superseded launch registering late is killed and its row revoked', async () => {
    await started();
    const ids = launch(3);
    h.tokens.add('s1', ids, 'superseded', null);
    const record = lateTerminal(ids.launchId, hcLabelsFor('s1', ids));
    await expect
      .poll(() => calls('terminal.kill').map((c) => c.params.terminal))
      .toEqual([record.address]);
    await expect.poll(() => h.tokens.row(ids.launchId)).toBeUndefined();
    expect(h.runtime.get('s1')).toBeUndefined();
  });

  it('an unmatched role=session terminal is killed on `created`; role=server never', async () => {
    await started();
    const server = lateTerminal('conduit-server-0123456789abcdef', {
      'conduit.instance': INSTANCE,
      'conduit.role': 'server',
    });
    const orphan = lateTerminal(launch(9).launchId, hcLabelsFor('s9', launch(9)));
    await expect
      .poll(() => calls('terminal.kill').map((c) => c.params.terminal))
      .toEqual([orphan.address]);
    expect(calls('terminal.kill').some((c) => c.params.terminal === server.address)).toBe(false);
  });

  it('a program that ended before the attach is read into the ring, its exit recorded and rm`d', async () => {
    await started();
    h.fake.afterReply = (method, result) => {
      if (method !== 'terminal.run') return;
      const t = h.fake.terminals.find((x) => x.address === (result as HcTerminal).address);
      if (t) Object.assign(t, { state: 'finished', exit_code: 3, reason: 'exited' });
    };
    h.fake.onCall('terminal.read', () => ({ text: 'bye\nnow', complete: true, how: 'screen' }));
    const { ids, result } = await spawned();
    expect(result).toEqual({
      ok: true,
      launchId: ids.launchId,
      finished: { exitCode: 3, reason: 'exited', output: 'bye\r\nnow' },
    });
    expect(h.ring.text('s1')).toBe('bye\r\nnow');
    expect(h.events).toContainEqual({
      type: 'exit',
      sessionId: 's1',
      generation: 1,
      code: 3,
      reason: 'exited',
    });
    await expect.poll(() => calls('terminal.rm').length).toBe(1);
    expect(h.runtime.get('s1')).toBeUndefined();
  });

  it('an attach refused with not_found for a program that just ended is recorded, not thrown', async () => {
    await started();
    h.fake.afterReply = (method, result) => {
      if (method !== 'terminal.run') return;
      const t = h.fake.terminals.find((x) => x.address === (result as HcTerminal).address);
      if (t) Object.assign(t, { state: 'finished', exit_code: 4, reason: 'exited' });
    };
    h.fake.onCall('terminal.attach', () => {
      throw new FakeRpcError('not_found');
    });
    h.fake.onCall('terminal.read', () => ({ text: 'FAST-OUT', complete: true, how: 'screen' }));
    const { ids, result } = await spawned();
    expect(result).toEqual({
      ok: true,
      launchId: ids.launchId,
      finished: { exitCode: 4, reason: 'exited', output: 'FAST-OUT' },
    });
    expect(h.ring.text('s1')).toBe('FAST-OUT');
  });

  it('a `finished` event racing the first attach records the exit and output once', async () => {
    await started();
    let release = () => {};
    h.fake.onCall('terminal.attach', async (params) => {
      // hc reports the end while our attach is still on its way.
      const t = h.fake.terminals.find((x) => x.address === params.terminal) as HcTerminal;
      Object.assign(t, { state: 'finished', exit_code: 4, reason: 'exited' });
      h.fake.emit(t, 'finished', { reason: 'exited', exit_code: 4, signal: null, finished_ms: 1 });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new FakeRpcError('not_found');
    });
    h.fake.onCall('terminal.read', () => ({ text: 'FAST-OUT', complete: true, how: 'screen' }));
    const ids = launch(1);
    await h.tokens.reserve('s1', ids);
    const pending = h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    await expect.poll(() => calls('terminal.attach').length).toBe(1);
    await h.hc.call('server.status', {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await expect(pending).resolves.toEqual({
      ok: true,
      launchId: ids.launchId,
      finished: { exitCode: 4, reason: 'exited', output: 'FAST-OUT' },
    });
    expect(h.ring.text('s1')).toBe('FAST-OUT');
    expect(h.events.filter((e) => e.type === 'exit')).toEqual([
      { type: 'exit', sessionId: 's1', generation: 1, code: 4, reason: 'exited' },
    ]);
    await expect.poll(() => calls('terminal.rm').length).toBe(1);
    expect(calls('terminal.read')).toHaveLength(1);
  });

  it('input, resize and facts pass through the active attach; a stale generation is dropped', async () => {
    await started();
    h.fake.paint = Buffer.from('P');
    await spawned();
    await expect.poll(() => h.events.some((e) => e.type === 'paint')).toBe(true);
    const channel = h.attachChannels.at(-1);
    expect(h.runtime.input('s1', 1, 'ls\r')).toBe(true);
    expect(h.runtime.input('s1', 0, 'stale')).toBe(false);
    h.runtime.resize('s1', { cols: 100, rows: 50 });
    h.runtime.facts('s1', { bg: '#000000' });
    const on = (kind: number) =>
      h.fake.frames.filter((f) => f.channel === channel && f.kind === kind);
    await expect.poll(() => on(FrameKind.Facts).length).toBe(1);
    expect(on(FrameKind.Data).map((f) => Buffer.from(f.payload).toString())).toEqual(['ls\r']);
    const resize = Buffer.from(on(FrameKind.Resize)[0].payload);
    expect([resize.readUInt16LE(0), resize.readUInt16LE(2)]).toEqual([100, 50]);
    expect(JSON.parse(Buffer.from(on(FrameKind.Facts)[0].payload).toString())).toEqual({
      bg: '#000000',
    });
    expect(h.runtime.get('s1')?.size).toEqual({ cols: 100, rows: 50 });
  });

  it('TypingPort writes through input at the live generation', async () => {
    await started();
    await spawned();
    const typing = createTyping(h.runtime, { gapMs: 0 });
    expect(typing.write('s1', 'x')).toBe(true);
    expect(typing.write('s1', 'y', { generation: 0 })).toBe(false);
    await expect(typing.submit('s1', 'hi')).resolves.toBe('submitted');
    const channel = h.attachChannels.at(-1);
    await expect
      .poll(() =>
        h.fake.frames
          .filter((f) => f.channel === channel && f.kind === FrameKind.Data)
          .map((f) => Buffer.from(f.payload).toString()),
      )
      .toEqual(['x', 'hi', '\r']);
  });

  it('the first paint is `paint{attach}`, later bytes are `data`; both reach the ring and grant credit', async () => {
    await started();
    h.fake.paint = Buffer.from('PAINT');
    await spawned();
    await expect
      .poll(() => h.events.find((e) => e.type === 'paint'))
      .toMatchObject({ type: 'paint', data: 'PAINT', cause: 'attach' });
    const channel = h.attachChannels.at(-1) ?? -1;
    h.fake.send(channel, Buffer.from('out'));
    await expect
      .poll(() => h.events.filter((e) => e.type === 'data'))
      .toEqual([{ type: 'data', sessionId: 's1', generation: 1, data: 'out' }]);
    expect(h.ring.text('s1')).toBe('PAINTout');
    const credit = h.fake.frames
      .filter((f) => f.channel === channel && f.kind === FrameKind.Credit)
      .reduce((n, f) => n + Buffer.from(f.payload).readUInt32LE(0), 0);
    expect(credit).toBe(8);
    expect(h.runtime.tailLines('s1', 1)).toEqual(['out']);
  });

  it('an exit is recorded from the stream end, then terminal.rm', async () => {
    await started();
    await spawned();
    await h.runtime.kill('s1');
    await expect
      .poll(() => h.events.find((e) => e.type === 'exit'))
      .toEqual({ type: 'exit', sessionId: 's1', generation: 1, code: 1, reason: 'killed' });
    await expect.poll(() => calls('terminal.rm').length).toBe(1);
    expect(h.runtime.get('s1')).toBeUndefined();
  });

  it('retire kills without an exit event', async () => {
    await started();
    await spawned();
    await h.runtime.retire('s1');
    await expect.poll(() => calls('terminal.rm').length).toBe(1);
    expect(h.events.some((e) => e.type === 'exit')).toBe(false);
  });

  it("beginStopping('stopAll') supersedes pending launches and earlier unconfirmed rows", async () => {
    await started();
    const earlier = launch(1);
    h.tokens.add('s0', earlier, 'unconfirmed', null);
    h.fake.onCall('terminal.run', () => new Promise(() => {}));
    const ids = launch(2);
    await h.tokens.reserve('s1', ids);
    void h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    await expect.poll(() => calls('terminal.run').length).toBe(1);
    await h.runtime.beginStopping('stopAll');
    expect(h.tokens.row(ids.launchId)?.state).toBe('superseded');
    expect(h.tokens.row(earlier.launchId)?.state).toBe('superseded');
    const next = launch(3);
    await expect(h.runtime.spawn('s2', spec, labelsFor('s2', next), next)).resolves.toEqual({
      ok: false,
      refusal: { reason: 'server_stopping' },
    });
    expect(calls('terminal.run')).toHaveLength(1);
  });

  it("beginStopping('restart') leaves pending launches unconfirmed for the replacement", async () => {
    await started();
    h.fake.onCall('terminal.run', () => new Promise(() => {}));
    const ids = launch(2);
    await h.tokens.reserve('s1', ids);
    void h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    await expect.poll(() => calls('terminal.run').length).toBe(1);
    await h.runtime.beginStopping('restart');
    expect(h.tokens.row(ids.launchId)?.state).toBe('unconfirmed');
  });

  it('a refused run revokes its row and returns spawn_failed', async () => {
    await started();
    h.fake.onCall('terminal.run', () => {
      throw new FakeRpcError('spawn_failed', 'no such program');
    });
    const ids = launch(4);
    await h.tokens.reserve('s1', ids);
    await expect(h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids)).resolves.toEqual({
      ok: false,
      refusal: { reason: 'spawn_failed', message: 'no such program' },
    });
    expect(h.tokens.row(ids.launchId)).toBeUndefined();
    expect(h.events.some((e) => e.type === 'unconfirmed')).toBe(false);
  });

  it('forwards hc status (mapped), title, size and foreground for a tracked terminal', async () => {
    await started();
    await spawned();
    const address = h.runtime.get('s1')?.target.terminal ?? '';
    const t = h.fake.terminals.find((x) => x.address === address) as HcTerminal;
    h.fake.emit(t, 'status', {
      status: { state: 'blocked', kind: 'permission', app: 'claude' },
      records: {},
      reported: true,
    });
    h.fake.emit(t, 'status', { status: { state: 'thinking' }, records: {}, reported: true });
    h.fake.emit(t, 'title', { title: 'hello' });
    h.fake.emit(t, 'size', { cols: 10, rows: 5 });
    h.fake.emit(t, 'foreground', { pid: 5, name: 'node', argv: ['node'], cwd: '/w' });
    await expect
      .poll(() =>
        h.events.filter((e) => e.type === 'status' || e.type === 'title' || e.type === 'size'),
      )
      .toEqual([
        {
          type: 'status',
          sessionId: 's1',
          status: { state: 'blocked', kind: 'permission', app: 'claude' },
        },
        { type: 'status', sessionId: 's1', status: null },
        { type: 'title', sessionId: 's1', title: 'hello' },
        { type: 'size', sessionId: 's1', size: { cols: 10, rows: 5 } },
      ]);
    await expect
      .poll(() => h.events.find((e) => e.type === 'foreground'))
      .toEqual({
        type: 'foreground',
        sessionId: 's1',
        foreground: { pid: 5, name: 'node', argv: ['node'], cwd: '/w' },
      });
  });
});
