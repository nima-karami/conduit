import { describe, expect, it } from 'vitest';
import { type PollClient, pollRunning } from '../../server/tray/hc-poll';

type ListResult = Awaited<ReturnType<PollClient['call']>>;

function fakeHc(list: (params: unknown) => Promise<ListResult>) {
  const calls: { method: string; params: unknown }[] = [];
  let closed = 0;
  const client: PollClient = {
    call: async (method, params) => {
      calls.push({ method, params });
      return list(params);
    },
    close: () => {
      closed++;
    },
  };
  return { connect: () => client, calls, closed: () => closed };
}

const term = (state: string) => ({ address: 'a', state, labels: {} });

describe('pollRunning', () => {
  it('counts live session terminals of this instance, with the labels hc-cli uses', async () => {
    const hc = fakeHc(async () => ({
      terminals: [term('live'), term('finished'), term('live')],
      hidden_finished: 0,
    }));
    expect(await pollRunning(hc.connect, { instance: 'abc' }, () => {})).toBe(2);
    expect(hc.calls).toEqual([
      {
        method: 'terminal.list',
        params: { labels: { 'conduit.instance': 'abc', 'conduit.role': 'session' } },
      },
    ]);
    expect(hc.closed()).toBe(1);
  });

  it('a failed call is null, logged, and the client is still closed', async () => {
    const logs: string[] = [];
    const hc = fakeHc(async () => {
      throw new Error('core gone');
    });
    expect(await pollRunning(hc.connect, { instance: 'abc' }, (m) => logs.push(m))).toBeNull();
    expect(hc.closed()).toBe(1);
    expect(logs.join()).toMatch(/core gone/);
  });

  it('a throwing connect is null and logged', async () => {
    const logs: string[] = [];
    const r = await pollRunning(
      () => {
        throw new Error('no session');
      },
      { instance: 'abc' },
      (m) => logs.push(m),
    );
    expect(r).toBeNull();
    expect(logs.join()).toMatch(/no session/);
  });
});
