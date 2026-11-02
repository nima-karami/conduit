import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameKind, INITIAL_STREAM_CREDIT } from '../../src/contracts/frames';
import type { HcStreamEnd } from '../../src/contracts/hc';
import { NodeHcClient } from '../../src/hc-client';
import { FakeHc } from '../../src/hc-client/testing/fake-hc';

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
const attach = (observe = false) => client.attach({ terminal: 't1', cols: 80, rows: 24, observe });
const barrier = () => client.call('server.status', {});

describe('hc attach streams', () => {
  it('holds early paint and the end until handlers are registered, with end last exactly once', async () => {
    fake.paint = Buffer.from('paint');
    const { stream } = await attach();
    fake.send(stream.channel, Buffer.from('live'));
    fake.end(stream.channel, { reason: 'exited', exit_code: 7 });
    await barrier();
    const received: (string | HcStreamEnd)[] = [];
    stream.onClose((end) => received.push(end));
    expect(received).toEqual([]);
    stream.onData((bytes) => received.push(Buffer.from(bytes).toString()));
    expect(received).toEqual(['paint', 'live', { reason: 'exited', exit_code: 7 }]);
    stream.onClose((end) => received.push(end));
    expect(received).toHaveLength(3);
  });

  it('allows only the initial window until the consumer explicitly returns handed-off credit', async () => {
    const { stream } = await attach();
    let received = 0;
    stream.onData((bytes) => {
      received += bytes.byteLength;
    });
    fake.send(stream.channel, Buffer.alloc(INITIAL_STREAM_CREDIT + 17, 65));
    await barrier();
    expect(received).toBe(INITIAL_STREAM_CREDIT);
    expect(fake.frames.filter((frame) => frame.kind === FrameKind.Credit)).toHaveLength(0);
    stream.credit(1);
    await expect.poll(() => received).toBe(INITIAL_STREAM_CREDIT + 1);
    stream.credit(INITIAL_STREAM_CREDIT - 1);
    await expect.poll(() => received).toBe(INITIAL_STREAM_CREDIT + 17);
    expect(() => stream.credit(18)).toThrow(/credit/i);
    stream.credit(17);
    await barrier();
    const amounts = fake.frames
      .filter((frame) => frame.kind === FrameKind.Credit)
      .map((frame) => Buffer.from(frame.payload).readUInt32LE());
    expect(amounts).toEqual([1, INITIAL_STREAM_CREDIT - 1, 17]);
  });

  it('refuses credit before handoff and rejects invalid credit amounts', async () => {
    const { stream } = await attach();
    fake.send(stream.channel, Buffer.from('held'));
    await barrier();
    for (const n of [1, -1, 0.5, Number.NaN]) expect(() => stream.credit(n)).toThrow(/credit/i);
  });

  it('sends input, resize and display facts in wire order, with focus only as input bytes', async () => {
    const { stream } = await attach();
    stream.write(Buffer.from('\x1b[I'));
    stream.resize(101, 37);
    stream.facts({ fg: '#123456', cell: [8, 16] });
    await barrier();
    const frames = fake.frames.filter((frame) => frame.channel === stream.channel);
    expect(frames.map((frame) => frame.kind)).toEqual([0, 3, 5]);
    expect([...frames[0].payload]).toEqual([27, 91, 73]);
    expect([...frames[1].payload]).toEqual([101, 0, 37, 0]);
    expect(JSON.parse(Buffer.from(frames[2].payload).toString())).toEqual({
      fg: '#123456',
      cell: [8, 16],
    });
  });

  it('refuses observer input, resize and facts', async () => {
    const { stream } = await attach(true);
    expect(() => stream.write(Buffer.from('x'))).toThrow(/observer/i);
    expect(() => stream.resize(90, 30)).toThrow(/observer/i);
    expect(() => stream.facts({ bg: '#000000' })).toThrow(/observer/i);
  });

  it('drops data that arrives while detaching', async () => {
    const { stream } = await attach();
    const got: (string | HcStreamEnd)[] = [];
    stream.onData((bytes) => got.push(Buffer.from(bytes).toString()));
    stream.onClose((end) => got.push(end));
    fake.send(stream.channel, Buffer.from('before'));
    await expect.poll(() => got).toEqual(['before']);
    stream.close();
    fake.sendFrame({ channel: stream.channel, kind: FrameKind.Data, payload: Buffer.from('late') });
    await barrier();
    expect(got).toEqual(['before', { reason: 'detached' }]);
  });

  it('ends a detach at once, discarding paint the consumer never read', async () => {
    fake.paint = Buffer.from('first paint');
    const { stream } = await attach(true);
    await barrier();
    const got: (string | HcStreamEnd)[] = [];
    stream.onClose((end) => got.push(end));
    stream.close();
    expect(got).toEqual([{ reason: 'detached' }]);
    stream.onData((bytes) => got.push(Buffer.from(bytes).toString()));
    expect(got).toEqual([{ reason: 'detached' }]);
  });

  it('ends a detached stream locally when the core does not echo CLOSE', async () => {
    fake.echoDetach = false;
    const { stream } = await attach(true);
    const ends: HcStreamEnd[] = [];
    stream.onClose((end) => ends.push(end));
    stream.close();
    expect(ends).toEqual([{ reason: 'detached' }]);
    await barrier();
    expect(
      fake.frames.filter((f) => f.channel === stream.channel && f.kind === FrameKind.Close),
    ).toHaveLength(1);
  });

  it('detaches with an empty CLOSE and rejects later writes', async () => {
    const { stream } = await attach();
    const ends: HcStreamEnd[] = [];
    stream.onClose((end) => ends.push(end));
    stream.close();
    stream.close();
    expect(ends).toEqual([{ reason: 'detached' }]);
    await barrier();
    expect(
      fake.frames
        .filter((frame) => frame.channel === stream.channel && frame.kind === FrameKind.Close)
        .map((frame) => frame.payload.byteLength),
    ).toEqual([0]);
    expect(() => stream.write(Buffer.from('x'))).toThrow(/closed/i);
  });
});
