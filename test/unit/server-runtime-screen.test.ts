import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness, labelsFor, launch } from '../../server/runtime/testing/harness';
import { FrameKind } from '../../src/contracts/frames';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const calls = (method: string) => h.fake.calls.filter((c) => c.method === method);

async function live(overrides?: Parameters<typeof harness>[0]) {
  h = await harness(overrides);
  await h.runtime.start();
  h.fake.paint = Buffer.from('\x1b[2J\x1b[H');
  const ids = launch(1);
  await h.tokens.reserve('s1', ids);
  h.runtime.resize('s1', { cols: 40, rows: 5 });
  await h.runtime.spawn('s1', { command: 'node', args: [], cwd: '/' }, labelsFor('s1', ids), ids);
  h.runtime.screens.ensure('s1', { seedTail: false });
  await expect.poll(() => h.events.some((e) => e.type === 'paint')).toBe(true);
  return h.attachChannels.at(-1) ?? -1;
}

const dataCount = () => h.events.filter((e) => e.type === 'data').length;

describe('TerminalRuntime screen()', () => {
  it('is null while no model runs', async () => {
    h = await harness();
    await expect(h.runtime.screen('s1')).resolves.toBeNull();
  });

  it('resolves only after every earlier `data` is parsed', async () => {
    const channel = await live();
    await expect.poll(() => h.events.some((e) => e.type === 'spawned')).toBe(true);
    let read: ReturnType<typeof h.runtime.screen> | undefined;
    h.runtime.on((e) => {
      if (e.type === 'data') read ??= h.runtime.screen('s1');
    });
    h.fake.send(channel, Buffer.from('\x1b[2J\x1b[Hhello'));
    await expect.poll(dataCount).toBe(1);
    const snap = await read;
    expect(snap?.lines[0]).toBe('hello');
    expect(snap?.lines).toHaveLength(5);
  });

  it('past the backlog bound reads unknown; an observer paint reseeds it, the stream untouched', async () => {
    const channel = await live({ screenBacklogMaxBytes: 1000 });
    const attaches = calls('terminal.attach').length;
    h.fake.paint = Buffer.from('\x1b[2J\x1b[Hreseeded');
    let during: Promise<unknown> | undefined;
    h.runtime.on((e) => {
      if (e.type === 'data') during ??= h.runtime.screen('s1');
    });
    h.fake.send(channel, Buffer.from('x'.repeat(5000)));
    await expect.poll(dataCount).toBe(1);
    await expect(during).resolves.toBeNull();
    await expect.poll(() => calls('terminal.attach').length).toBe(attaches + 1);
    expect(calls('terminal.attach').at(-1)?.params).toEqual({
      terminal: h.runtime.get('s1')?.target.terminal,
      cols: 40,
      rows: 5,
      observe: true,
    });
    const observer = h.attachChannels.at(-1);
    await expect
      .poll(() =>
        h.events.filter((e) => e.type === 'paint').map((e) => e.type === 'paint' && e.cause),
      )
      .toEqual(['attach', 'attach']);
    const snap = await h.runtime.screen('s1');
    expect(snap?.lines[0]).toBe('reseeded');
    expect(h.ring.text('s1')).not.toContain('reseeded');
    // The observer is gone and the active stream still carries everything, exactly once.
    await expect
      .poll(() => h.fake.frames.some((f) => f.channel === observer && f.kind === FrameKind.Close))
      .toBe(true);
    h.fake.send(channel, Buffer.from('after'));
    await expect.poll(dataCount).toBe(2);
    expect(h.ring.text('s1').split('after')).toHaveLength(2);
    expect(h.runtime.input('s1', 1, 'k')).toBe(true);
    await expect
      .poll(() => h.fake.frames.filter((f) => f.kind === FrameKind.Data && f.channel === channel))
      .toHaveLength(1);
  });
});
