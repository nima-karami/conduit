import { afterEach, describe, expect, it } from 'vitest';
import {
  type Harness,
  harness,
  hcLabelsFor,
  INSTANCE,
  labelsFor,
  launch,
} from '../../server/runtime/testing/harness';
import type { HcTerminal } from '../../src/contracts/hc';
import { SERVER_REATTACH_HISTORY_LINES } from '../../src/contracts/terminal-runtime';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const calls = (method: string) => h.fake.calls.filter((c) => c.method === method);
const spec = { command: 'node', args: [], cwd: '/work' };

function terminal(
  address: string,
  name: string,
  labels: Record<string, string>,
  extra: Partial<HcTerminal> = {},
): HcTerminal {
  const record: HcTerminal = {
    address,
    name,
    labels,
    argv: ['node'],
    cwd: '/work',
    state: 'live',
    created_ms: 1,
    screen: 'exact',
    cols: 77,
    rows: 33,
    ...extra,
  };
  h.fake.terminals.push(record);
  return record;
}

describe('TerminalRuntime reconcile', () => {
  it('runs in the D21 order and records every outcome', async () => {
    h = await harness();
    const live = launch(1);
    const pruned = launch(2);
    const ended = launch(3);
    const reserved = launch(4);
    const late = launch(5);
    const superseded = launch(6);
    const orphan = launch(7);
    h.tokens.add('live', live, 'live', 'a-live');
    h.tokens.add('pruned', pruned, 'live', 'a-gone');
    h.tokens.add('ended', ended, 'live', 'a-ended');
    h.tokens.add('reserved', reserved, 'reserved', null);
    h.tokens.add('late', late, 'unconfirmed', null);
    h.tokens.add('superseded', superseded, 'superseded', null);
    terminal('a-live', live.launchId, hcLabelsFor('live', live));
    terminal('a-ended', ended.launchId, hcLabelsFor('ended', ended), {
      state: 'finished',
      exit_code: 0,
      reason: 'exited',
    });
    terminal('a-late', late.launchId, hcLabelsFor('late', late));
    terminal('a-super', superseded.launchId, hcLabelsFor('superseded', superseded));
    terminal('a-orphan', orphan.launchId, hcLabelsFor('orphan', orphan));
    terminal('a-server', 'conduit-server-0123456789abcdef', {
      'conduit.instance': INSTANCE,
      'conduit.role': 'server',
    });
    h.fake.onCall('terminal.read', () => ({ text: 'done\n', complete: true, how: 'screen' }));

    const adopted = await h.runtime.start().then(() => h.runtime.get('live'));
    expect(adopted?.target.terminal).toBe('a-live');

    expect(calls('terminal.get').map((c) => c.params.terminal)).toEqual([
      'a-live',
      'a-gone',
      'a-ended',
      'a-ended',
      reserved.launchId,
      late.launchId,
      superseded.launchId,
    ]);
    expect(calls('terminal.attach').map((c) => c.params)).toEqual([
      {
        terminal: 'a-live',
        cols: 77,
        rows: 33,
        resumed: true,
        history: SERVER_REATTACH_HISTORY_LINES,
      },
      {
        terminal: 'a-late',
        cols: 77,
        rows: 33,
        resumed: true,
        history: SERVER_REATTACH_HISTORY_LINES,
      },
    ]);
    expect(h.events).toContainEqual({
      type: 'exit',
      sessionId: 'pruned',
      generation: 2,
      code: null,
      reason: 'lost',
    });
    expect(h.events).toContainEqual({
      type: 'exit',
      sessionId: 'ended',
      generation: 3,
      code: 0,
      reason: 'exited',
    });
    expect(h.ring.text('ended')).toBe('done\r\n');
    await expect
      .poll(() => calls('terminal.rm').map((c) => c.params.terminal))
      .toEqual(['a-ended']);
    expect(h.tokens.row(pruned.launchId)).toBeUndefined();
    expect(h.tokens.row(reserved.launchId)?.state).toBe('unconfirmed');
    expect(h.events).toContainEqual({
      type: 'unconfirmed',
      sessionId: 'reserved',
      generation: 4,
      launchId: reserved.launchId,
    });
    expect(h.tokens.row(late.launchId)).toMatchObject({ state: 'live', hcAddress: 'a-late' });
    expect(h.tokens.row(superseded.launchId)).toBeUndefined();
    expect(calls('terminal.kill').map((c) => c.params.terminal)).toEqual(['a-super', 'a-orphan']);
    expect(h.runtime.health()).toEqual({ state: 'ready', hcVersion: '0.1.16' });
  });

  it('not_found on a live row means lost only: the row is revoked, nothing else touched', async () => {
    h = await harness();
    const gone = launch(1);
    h.tokens.add('s1', gone, 'live', 'a-gone');
    await h.runtime.start();
    expect(h.events.filter((e) => e.type === 'exit')).toEqual([
      { type: 'exit', sessionId: 's1', generation: 1, code: null, reason: 'lost' },
    ]);
    expect(calls('terminal.read')).toHaveLength(0);
    expect(calls('terminal.rm')).toHaveLength(0);
    expect(h.tokens.calls).toEqual([`revoke ${gone.launchId}`]);
  });

  it('an already-unconfirmed row hc doesn’t list stays and is announced on every reconcile', async () => {
    h = await harness();
    const ids = launch(8);
    h.tokens.add('s8', ids, 'unconfirmed', null);
    const unconfirmed = {
      type: 'unconfirmed',
      sessionId: 's8',
      generation: 8,
      launchId: ids.launchId,
    };
    await h.runtime.start();
    expect(h.events).toEqual([unconfirmed]);
    await h.runtime.reconcile();
    expect(h.events).toEqual([unconfirmed, unconfirmed]);
    expect(h.tokens.row(ids.launchId)?.state).toBe('unconfirmed');
    expect(h.tokens.calls).toEqual([]);
  });

  it('skips rows an in-flight spawn owns', async () => {
    h = await harness();
    await h.runtime.start();
    h.fake.onCall('terminal.run', () => new Promise(() => {}));
    const ids = launch(4);
    await h.tokens.reserve('s1', ids);
    void h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    await expect.poll(() => calls('terminal.run').length).toBe(1);
    await h.runtime.reconcile();
    expect(calls('terminal.get')).toHaveLength(0);
    expect(h.tokens.row(ids.launchId)?.state).toBe('reserved');
    expect(h.events.some((e) => e.type === 'unconfirmed')).toBe(false);
  });

  it('an unreadable token store is degraded: adopts nothing, kills nothing', async () => {
    h = await harness();
    h.tokens.state = 'unreadable';
    const orphan = launch(7);
    terminal('a-orphan', orphan.launchId, hcLabelsFor('orphan', orphan));
    await h.runtime.start();
    expect(h.runtime.health()).toEqual({
      state: 'degraded',
      reason: 'token store unreadable',
      hcVersion: '0.1.16',
    });
    const record = h.fake.terminals.find((t) => t.address === 'a-orphan') as HcTerminal;
    // Readable again but not yet reconciled: still no clean load, so `created` kills nothing.
    h.tokens.state = 'loaded';
    h.fake.emit(record, 'created', record);
    await h.hc.call('server.status', {});
    expect(calls('terminal.kill')).toHaveLength(0);
    expect(calls('terminal.attach')).toHaveLength(0);
    expect(calls('terminal.get')).toHaveLength(0);
  });

  it('a missing token store with labelled terminals live is as bad as unreadable', async () => {
    h = await harness();
    h.tokens.state = 'missing';
    terminal('a-orphan', launch(7).launchId, hcLabelsFor('orphan', launch(7)));
    await h.runtime.start();
    expect(h.runtime.health()).toMatchObject({ reason: 'token store unreadable' });
    expect(calls('terminal.kill')).toHaveLength(0);
  });

  it('a core reconnect re-attaches at the record size with resumed + history, paint as gap', async () => {
    h = await harness();
    await h.runtime.start();
    const ids = launch(1);
    await h.tokens.reserve('s1', ids);
    await h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    const address = h.runtime.get('s1')?.target.terminal;
    const record = h.fake.terminals.find((t) => t.address === address) as HcTerminal;
    Object.assign(record, { cols: 101, rows: 41 });
    h.fake.paint = Buffer.from('SCREEN');
    h.fake.disconnect();
    await expect.poll(() => h.events.some((e) => e.type === 'resynced')).toBe(true);
    expect(calls('terminal.attach').at(-1)?.params).toEqual({
      terminal: address,
      cols: 101,
      rows: 41,
      resumed: true,
      history: SERVER_REATTACH_HISTORY_LINES,
    });
    await expect
      .poll(() => h.events.find((e) => e.type === 'paint' && e.cause === 'gap'))
      .toMatchObject({ data: 'SCREEN', size: { cols: 101, rows: 41 } });
    expect(h.ring.gaps).toEqual([
      { sessionId: 's1', paint: 'SCREEN', size: { cols: 101, rows: 41 } },
    ]);
    expect(h.events.filter((e) => e.type === 'spawned')).toHaveLength(1);
    expect(h.runtime.input('s1', 1, 'k')).toBe(true);
  });

  it('a tracked terminal that finished while the core was away: read, exit, rm, no attach', async () => {
    h = await harness();
    await h.runtime.start();
    const ids = launch(1);
    await h.tokens.reserve('s1', ids);
    await h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
    const address = h.runtime.get('s1')?.target.terminal;
    const record = h.fake.terminals.find((t) => t.address === address) as HcTerminal;
    const attaches = calls('terminal.attach').length;
    h.fake.onCall('terminal.read', () => ({ text: 'last words', complete: true, how: 'screen' }));
    h.fake.disconnect();
    Object.assign(record, { state: 'finished', exit_code: 2, reason: 'exited' });
    await expect.poll(() => h.events.some((e) => e.type === 'resynced')).toBe(true);
    expect(calls('terminal.attach')).toHaveLength(attaches);
    expect(h.ring.text('s1')).toContain('last words');
    expect(h.events).toContainEqual({
      type: 'exit',
      sessionId: 's1',
      generation: 1,
      code: 2,
      reason: 'exited',
    });
    await expect.poll(() => calls('terminal.rm').map((c) => c.params.terminal)).toEqual([address]);
  });

  it('a replaced core version is degraded `core replaced`', async () => {
    h = await harness();
    await h.runtime.start();
    h.fake.hello.version = '0.1.17';
    h.fake.disconnect();
    await expect.poll(() => h.events.some((e) => e.type === 'resynced')).toBe(true);
    expect(h.runtime.health()).toEqual({
      state: 'degraded',
      reason: 'core replaced',
      hcVersion: '0.1.17',
    });
  });
});
