import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HC_PROTOCOL_GENERATION } from '../../src/contracts/hc';
import { NodeHcClient } from '../../src/hc-client';
import { FakeHc, FakeRpcError } from '../../src/hc-client/testing/fake-hc';

let fake: FakeHc;
let client: NodeHcClient;
beforeEach(async () => {
  fake = new FakeHc();
  await fake.listen();
  client = new NodeHcClient({ connect: fake.connect, reconnectDelayMs: 10 });
});
afterEach(async () => {
  client.close();
  await fake.close();
});

describe('hc RPC', () => {
  it('performs a plain hello before framed requests', async () => {
    await expect(client.call('terminal.get', { terminal: 't1' })).resolves.toMatchObject({
      address: 't1',
      state: 'live',
    });
    expect(fake.calls[0]).toMatchObject({
      method: 'hello',
      params: { framed: true, generation: HC_PROTOCOL_GENERATION },
    });
    expect(fake.calls[1]).toMatchObject({ method: 'terminal.get', params: { terminal: 't1' } });
  });

  it('correlates concurrent replies received out of order', async () => {
    let answer: ((value: unknown) => void) | undefined;
    fake.onCall(
      'terminal.get',
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const first = client.call('terminal.get', { terminal: 'slow' });
    const second = client.call('terminal.read', { terminal: 't1' });
    await expect(second).resolves.toMatchObject({ text: '', complete: true });
    answer?.({ ...fake.terminals[0], address: 'slow' });
    await expect(first).resolves.toMatchObject({ address: 'slow' });
  });

  it.each([
    'name_taken',
    'finished',
    'not_found',
    'blocked',
    'unavailable',
    'conflict',
    'status_mismatch',
    'spawn_failed',
    'live',
    'needs_framed',
  ])('maps %s from error.data.kind', async (kind) => {
    fake.onCall('terminal.get', () => {
      throw new FakeRpcError(kind, 'core explanation');
    });
    await expect(client.call('terminal.get', { terminal: 't1' })).rejects.toMatchObject({
      name: 'HcRpcError',
      kind,
      message: 'core explanation',
      code: -32000,
    });
  });

  it('preserves an unknown upstream error without inventing a C3 error kind', async () => {
    fake.onCall('terminal.get', () => {
      throw new FakeRpcError('future_kind', 'details');
    });
    await expect(client.call('terminal.get', { terminal: 't1' })).rejects.toMatchObject({
      rawKind: 'future_kind',
      data: { kind: 'future_kind' },
      message: 'details',
    });
  });
});
