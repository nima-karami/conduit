import { afterEach, describe, expect, it } from 'vitest';
import { ServerAttention } from '../../server/attention';
import { createRuntimeServices } from '../../server/runtime';
import { exitReasonOf } from '../../server/runtime/runtime';
import {
  type Harness,
  harness,
  hcLabelsFor,
  labelsFor,
  launch,
} from '../../server/runtime/testing/harness';
import { FrameKind } from '../../src/contracts/frames';
import type { HcTerminal } from '../../src/contracts/hc';
import type { ServerEvent, ServerEvents } from '../../src/contracts/server-protocol';
import type { RuntimeEvent } from '../../src/contracts/terminal-runtime';
import { FakeRpcError } from '../../src/hc-client/testing/fake-hc';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const spec = { command: 'node', args: [], cwd: '/work' };
const calls = (method: string) => h.fake.calls.filter((c) => c.method === method);
const barrier = () => h.hc.call('server.status', {});
const record = (address: string) =>
  h.fake.terminals.find((t) => t.address === address) as HcTerminal;
const finishedEvent = (t: HcTerminal, code: number) =>
  h.fake.emit(t, 'finished', { reason: 'exited', exit_code: code, signal: null, finished_ms: 1 });

async function startedSpawn(n = 1) {
  const ids = launch(n);
  await h.tokens.reserve('s1', ids);
  return { ids, result: h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids) };
}

describe('TerminalRuntime races', () => {
  it('a `finished` event during the first attach decides nothing when the attach succeeds', async () => {
    h = await harness();
    await h.runtime.start();
    h.fake.paint = Buffer.from('P');
    h.beforeAttach = async () => {
      h.beforeAttach = undefined;
      const t = h.fake.terminals.at(-1) as HcTerminal;
      finishedEvent(t, 9);
      await barrier();
    };
    const { result } = await startedSpawn();
    await expect(result).resolves.toMatchObject({ ok: true, terminal: { generation: 1 } });
    expect(calls('terminal.read')).toHaveLength(0);
    expect(h.events.some((e) => e.type === 'exit')).toBe(false);
    h.fake.end(h.attachChannels.at(-1) ?? -1, { reason: 'exited', exit_code: 5 });
    await expect
      .poll(() => h.events.filter((e) => e.type === 'exit'))
      .toEqual([{ type: 'exit', sessionId: 's1', generation: 1, code: 5, reason: 'exited' }]);
    expect(calls('terminal.read')).toHaveLength(0);
  });

  it('a `finished` event during the first attach, then a refused attach, reads once', async () => {
    h = await harness();
    await h.runtime.start();
    h.fake.onCall('terminal.read', () => ({ text: 'OUT', complete: true, how: 'screen' }));
    h.beforeAttach = async () => {
      const t = h.fake.terminals.at(-1) as HcTerminal;
      Object.assign(t, { state: 'finished', exit_code: 4, reason: 'exited' });
      finishedEvent(t, 4);
      await barrier();
    };
    const { ids, result } = await startedSpawn();
    await expect(result).resolves.toEqual({
      ok: true,
      launchId: ids.launchId,
      finished: { exitCode: 4, reason: 'exited', output: 'OUT' },
    });
    expect(calls('terminal.read')).toHaveLength(1);
    expect(h.ring.text('s1')).toBe('OUT');
    expect(h.events.filter((e) => e.type === 'exit')).toHaveLength(1);
    await expect.poll(() => calls('terminal.rm').length).toBe(1);
  });

  it('an attach that succeeds after the exit was recorded meanwhile is dropped', async () => {
    h = await harness();
    await h.runtime.start();
    const ids = launch(1);
    await h.tokens.reserve('s1', ids);
    await h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    const address = h.runtime.get('s1')?.target.terminal ?? '';
    let gone = false;
    h.fake.onCall('terminal.get', (params) => {
      const t = h.fake.terminals.find(
        (x) => x.address === params.terminal || x.name === params.terminal,
      );
      if (!t || (gone && t.address === address)) throw new FakeRpcError('not_found');
      return t;
    });
    // The nested reconcile's orphan sweep must not end the program: the attach has to succeed.
    h.fake.onCall('terminal.kill', (params) => record(String(params.terminal)));
    h.beforeAttach = async () => {
      h.beforeAttach = undefined;
      // A concurrent reconcile finds the record pruned and records the exit first.
      gone = true;
      await h.runtime.reconcile();
      gone = false;
    };
    h.fake.disconnect();
    await expect.poll(() => h.events.some((e) => e.type === 'resynced')).toBe(true);
    expect(h.events.filter((e) => e.type === 'exit')).toEqual([
      { type: 'exit', sessionId: 's1', generation: 1, code: null, reason: 'lost' },
    ]);
    const channel = h.attachChannels.at(-1);
    await expect
      .poll(() => h.fake.frames.some((f) => f.channel === channel && f.kind === FrameKind.Close))
      .toBe(true);
    expect(h.runtime.get('s1')).toBeUndefined();
    expect(h.events.filter((e) => e.type === 'paint' && e.cause === 'gap')).toHaveLength(0);
  });

  it('a reconcile while a re-attach is in flight does not attach twice', async () => {
    h = await harness();
    await h.runtime.start();
    const ids = launch(1);
    await h.tokens.reserve('s1', ids);
    await h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    const before = calls('terminal.attach').length;
    h.beforeAttach = async () => {
      h.beforeAttach = undefined;
      await h.runtime.reconcile();
    };
    h.fake.disconnect();
    await expect.poll(() => h.events.some((e) => e.type === 'resynced')).toBe(true);
    expect(calls('terminal.attach')).toHaveLength(before + 1);
    expect(h.runtime.input('s1', 1, 'k')).toBe(true);
  });

  it('a resize during the attach reaches the stream once it is held', async () => {
    h = await harness();
    await h.runtime.start();
    h.beforeAttach = async () => {
      h.runtime.resize('s1', { cols: 100, rows: 50 });
    };
    const { result } = await startedSpawn();
    await result;
    const channel = h.attachChannels.at(-1);
    await expect
      .poll(() =>
        h.fake.frames
          .filter((f) => f.channel === channel && f.kind === FrameKind.Resize)
          .map((f) => [
            Buffer.from(f.payload).readUInt16LE(0),
            Buffer.from(f.payload).readUInt16LE(2),
          ]),
      )
      .toEqual([[100, 50]]);
    expect(h.runtime.get('s1')?.size).toEqual({ cols: 100, rows: 50 });
  });

  it('a failed final read is not cached, and does not stop the rest of reconcile', async () => {
    h = await harness();
    await h.runtime.start();
    const ids = launch(1);
    await h.tokens.reserve('s1', ids);
    await h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    const address = h.runtime.get('s1')?.target.terminal ?? '';
    const reserved = launch(2);
    h.tokens.add('s2', reserved, 'reserved', null);
    let reads = 0;
    h.fake.onCall('terminal.read', () => {
      reads++;
      if (reads === 1) throw new FakeRpcError('blocked');
      return { text: 'late', complete: true, how: 'screen' };
    });
    h.fake.disconnect();
    Object.assign(record(address), { state: 'finished', exit_code: 2, reason: 'exited' });
    await expect.poll(() => h.events.some((e) => e.type === 'resynced')).toBe(true);
    expect(h.tokens.row(reserved.launchId)?.state).toBe('unconfirmed');
    expect(h.events.some((e) => e.type === 'exit')).toBe(false);
    await h.runtime.reconcile();
    expect(h.events.filter((e) => e.type === 'exit')).toEqual([
      { type: 'exit', sessionId: 's1', generation: 1, code: 2, reason: 'exited' },
    ]);
    expect(h.ring.text('s1')).toContain('late');
  });

  it('a final read cut off by a disconnect is retried by the next reconnect', async () => {
    h = await harness();
    await h.runtime.start();
    const ids = launch(1);
    await h.tokens.reserve('s1', ids);
    await h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    const address = h.runtime.get('s1')?.target.terminal ?? '';
    let reads = 0;
    h.fake.onCall('terminal.read', () => {
      reads++;
      if (reads === 1) {
        setImmediate(() => h.fake.disconnect());
        return new Promise(() => {});
      }
      return { text: 'final', complete: true, how: 'screen' };
    });
    h.fake.disconnect();
    Object.assign(record(address), { state: 'finished', exit_code: 3, reason: 'exited' });
    await expect
      .poll(() => h.events.filter((e) => e.type === 'exit'), { timeout: 3000 })
      .toEqual([{ type: 'exit', sessionId: 's1', generation: 1, code: 3, reason: 'exited' }]);
    expect(reads).toBe(2);
    expect(h.ring.text('s1')).toContain('final');
  });

  it('a late terminal is matched by its hc name only, never the conduit.launch label', async () => {
    h = await harness();
    await h.runtime.start();
    const ids = launch(3);
    h.tokens.add('s1', ids, 'unconfirmed', null);
    const t: HcTerminal = {
      address: 'forged',
      name: null,
      labels: hcLabelsFor('s1', ids),
      argv: [],
      cwd: '/',
      state: 'live',
      created_ms: 1,
      screen: 'exact',
      cols: 80,
      rows: 24,
    };
    h.fake.terminals.push(t);
    h.fake.emit(t, 'created', t);
    await barrier();
    await barrier();
    expect(h.tokens.row(ids.launchId)?.state).toBe('unconfirmed');
    expect(calls('terminal.attach')).toHaveLength(0);
  });

  it('adopt emits the record`s reported status and title', async () => {
    h = await harness();
    const ids = launch(1);
    h.tokens.add('s1', ids, 'live', 'a1');
    h.fake.terminals.push({
      address: 'a1',
      name: ids.launchId,
      labels: hcLabelsFor('s1', ids),
      argv: [],
      cwd: '/',
      state: 'live',
      created_ms: 1,
      screen: 'exact',
      cols: 80,
      rows: 24,
      title: 'claude',
      status: { state: 'working' },
      reported: true,
    });
    await h.runtime.start();
    expect(h.events.filter((e) => e.type === 'status' || e.type === 'title')).toEqual([
      { type: 'status', sessionId: 's1', status: { state: 'working' } },
      { type: 'title', sessionId: 's1', title: 'claude' },
    ]);
  });

  it('stopping settles only launches still awaiting the run reply', async () => {
    h = await harness();
    await h.runtime.start();
    h.beforeAttach = () => new Promise(() => {});
    const { ids } = await startedSpawn();
    await expect.poll(() => h.tokens.row(ids.launchId)?.state).toBe('live');
    await h.runtime.beginStopping('stopAll');
    expect(h.tokens.row(ids.launchId)?.state).toBe('live');
  });

  it('a paint is the bytes until the stream is quiet for PAINT_QUIET_MS', async () => {
    h = await harness();
    await h.runtime.start();
    h.fake.paint = Buffer.from('PAINT');
    const { result } = await startedSpawn();
    await result;
    // Well inside PAINT_QUIET_MS of the paint's first byte.
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.fake.send(h.attachChannels.at(-1) ?? -1, Buffer.from('MORE'));
    await expect
      .poll(() => h.events.find((e) => e.type === 'paint'))
      .toMatchObject({ data: 'PAINTMORE', cause: 'attach' });
    expect(h.events.some((e) => e.type === 'data')).toBe(false);
  });

  it('a core not on the pinned version is `core replaced` from the first connect', async () => {
    h = await harness();
    h.fake.hello.version = '0.1.99';
    await h.runtime.start();
    expect(h.runtime.health()).toMatchObject({ state: 'degraded', reason: 'core replaced' });
  });

  it('maps end reasons: unknown is lost', () => {
    expect(exitReasonOf('exited')).toBe('exited');
    expect(exitReasonOf('signaled')).toBe('killed');
    expect(exitReasonOf('holder_lost')).toBe('lost');
    expect(exitReasonOf(null)).toBe('lost');
  });

  it('scrollback show/record fall back to the last requested size before a spawn', async () => {
    h = await harness();
    const shown: Array<{ type: ServerEvent; data: unknown }> = [];
    const files = new Map<string, string>();
    const services = createRuntimeServices({
      hc: h.hc,
      tokens: h.tokens,
      emit: <E extends ServerEvent>(type: E, data: ServerEvents[E]) => shown.push({ type, data }),
      instance: 'other',
      hcSession: 'conduit-test',
      appVersion: '9',
      logPath: 'log',
      userData: '/',
      recording: () => true,
      log: () => {},
      files: {
        read: (n) => files.get(n),
        write: (n, b) => files.set(n, b),
        remove: (n) => files.delete(n),
      },
    });
    services.runtime.resize('s9', { cols: 70, rows: 20 });
    services.scrollback.record('s9', 'MARK');
    services.scrollback.show('s9', 'SHOW');
    expect(shown).toEqual([{ type: 'term.show', data: { sessionId: 's9', data: 'SHOW' } }]);
    const replay = services.scrollback.replayForColdStart('s9');
    expect(replay?.data.startsWith('MARKSHOW')).toBe(true);
    expect(replay?.replay[0]).toMatchObject({
      geometry: { cols: 70, rows: 20 },
    });
    services.attention.dispose();
  });
});

describe('ServerAttention change signal', () => {
  it('fires only when busy or needsAttention flips', () => {
    const listeners = new Set<(e: RuntimeEvent) => void>();
    const attention = new ServerAttention({
      runtime: {
        on: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      },
      sweepMs: 1_000_000,
    });
    let changes = 0;
    attention.onChange(() => changes++);
    const status = (state: 'idle' | 'working') => {
      for (const l of listeners) l({ type: 'status', sessionId: 'a', status: { state } });
    };
    status('idle');
    status('idle');
    expect(changes).toBe(0);
    status('working');
    expect(changes).toBe(1);
    status('working');
    expect(changes).toBe(1);
    attention.dispose();
  });
});
