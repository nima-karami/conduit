import { afterEach, expect, it, vi } from 'vitest';
import { type Harness, harness, labelsFor, launch } from '../../server/runtime/testing/harness';
import { FrameKind } from '../../src/contracts/frames';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const spec = { command: 'node', args: [], cwd: '/work' };
async function started() {
  h = await harness();
  await h.runtime.start();
  h.runtime.resize('s1', { cols: 91, rows: 31 });
  const ids = launch(1);
  await h.tokens.reserve('s1', ids);
  await h.runtime.spawn('s1', spec, labelsFor('s1', ids), ids);
  await expect.poll(() => h.events.some((event) => event.type === 'paint')).toBe(true);
  h.fake.paint = Buffer.from('first paint');
}
function listeners() {
  return { data: vi.fn(), size: vi.fn(), end: vi.fn() };
}

it('collects the first paint, relays later output and credits the observer', async () => {
  await started();
  const events = listeners();
  const firstFrame = h.fake.frames.length;
  const observed = await h.runtime.observe('s1', events);
  expect(observed).toMatchObject({ firstPaint: 'first paint', size: { cols: 91, rows: 31 } });
  const channel = h.attachChannels.at(-1) ?? -1;
  h.fake.send(channel, Buffer.from('later'));
  await expect.poll(() => events.data.mock.calls).toEqual([['later']]);
  await expect
    .poll(() =>
      h.fake.frames
        .filter((f) => f.channel === channel && f.kind === FrameKind.Credit)
        .reduce((n, f) => n + Buffer.from(f.payload).readUInt32LE(0), 0),
    )
    .toBe(16);
  expect(h.fake.calls.filter((c) => c.method === 'terminal.attach').at(-1)?.params).toEqual({
    terminal: h.runtime.get('s1')?.target.terminal,
    observe: true,
    history: 0,
    cols: 91,
    rows: 31,
  });
  expect(
    h.fake.frames
      .slice(firstFrame)
      .filter((f) => f.channel !== 0 && f.kind !== FrameKind.Credit && f.kind !== FrameKind.Close),
  ).toEqual([]);
  observed?.close();
});
it('forwards size and exit after the first paint', async () => {
  await started();
  const events = listeners();
  const observed = await h.runtime.observe('s1', events);
  const terminal = h.fake.terminals.find((t) => t.address === h.runtime.get('s1')?.target.terminal);
  if (!terminal) throw new Error('terminal missing');
  h.fake.emit(terminal, 'size', { cols: 100, rows: 40 });
  await expect.poll(() => events.size.mock.calls).toEqual([[{ cols: 100, rows: 40 }]]);
  h.fake.end(h.attachChannels.at(-1) ?? -1, { reason: 'exited', exit_code: 23 });
  await expect.poll(() => events.end.mock.calls).toEqual([['exited', 23]]);
  observed?.close();
});
it('close detaches and suppresses later events', async () => {
  await started();
  const events = listeners();
  const observed = await h.runtime.observe('s1', events);
  const channel = h.attachChannels.at(-1) ?? -1;
  observed?.close();
  await expect
    .poll(() => h.fake.frames.some((f) => f.channel === channel && f.kind === FrameKind.Close))
    .toBe(true);
  const terminal = h.fake.terminals.find((t) => t.address === h.runtime.get('s1')?.target.terminal);
  if (!terminal) throw new Error('terminal missing');
  h.fake.emit(terminal, 'size', { cols: 100, rows: 40 });
  h.fake.send(channel, Buffer.from('ignored'));
  h.fake.end(channel, { reason: 'exited', exit_code: 1 });
  await expect
    .poll(() => h.events.some((e) => e.type === 'size' && e.size.cols === 100))
    .toBe(true);
  expect(events.data).not.toHaveBeenCalled();
  expect(events.size).not.toHaveBeenCalled();
  expect(events.end).not.toHaveBeenCalled();
});
it('returns null without a live terminal', async () => {
  h = await harness();
  await h.runtime.start();
  await expect(h.runtime.observe('missing', listeners())).resolves.toBeNull();
  expect(h.fake.calls.filter((c) => c.method === 'terminal.attach')).toHaveLength(0);
});

it('finishes an interrupted paint before reporting the close', async () => {
  await started();
  const events = listeners();
  const pending = h.runtime.observe('s1', events);
  await expect.poll(() => h.attachChannels.length).toBe(2);
  const channel = h.attachChannels.at(-1) ?? -1;
  h.fake.end(channel, { reason: 'exited', exit_code: 7 });
  const observed = await pending;
  expect(observed?.firstPaint).toBe('first paint');
  await expect.poll(() => events.end.mock.calls).toEqual([['exited', 7]]);
  observed?.close();
});

it('reports a non-exit close without an exit code', async () => {
  await started();
  const events = listeners();
  const observed = await h.runtime.observe('s1', events);
  h.fake.end(h.attachChannels.at(-1) ?? -1, { reason: 'holder_lost', exit_code: 7 });
  await expect.poll(() => events.end.mock.calls).toEqual([['closed', null]]);
  observed?.close();
});

it('buffers size events until the observer is returned', async () => {
  await started();
  h.fake.paint = Buffer.alloc(0);
  const events = listeners();
  const pending = h.runtime.observe('s1', events);
  await expect.poll(() => h.attachChannels.length).toBe(2);
  const terminal = h.fake.terminals.find((t) => t.address === h.runtime.get('s1')?.target.terminal);
  if (!terminal) throw new Error('terminal missing');
  h.fake.emit(terminal, 'size', { cols: 100, rows: 40 });
  await expect
    .poll(() => h.events.some((e) => e.type === 'size' && e.size.cols === 100))
    .toBe(true);
  expect(events.size).not.toHaveBeenCalled();
  h.fake.send(h.attachChannels.at(-1) ?? -1, Buffer.from('paint'));
  const observed = await pending;
  await expect.poll(() => events.size.mock.calls).toEqual([[{ cols: 100, rows: 40 }]]);
  observed?.close();
});

it('detaches observers when the runtime detaches streams', async () => {
  await started();
  const events = listeners();
  const observed = await h.runtime.observe('s1', events);
  const channel = h.attachChannels.at(-1) ?? -1;
  h.runtime.detachStreams();
  await expect
    .poll(() => h.fake.frames.some((f) => f.channel === channel && f.kind === FrameKind.Close))
    .toBe(true);
  expect(events.end).not.toHaveBeenCalled();
  observed?.close();
});
