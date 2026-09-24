import { describe, expect, it } from 'vitest';
import { ADD_DIR_LINE_GAP_MS, type AddDirsDeps, runAddDirs } from '../../src/add-dir-delivery';
import { SUBMIT_GAP_MS } from '../../src/timed-messages';

function fake(over: Partial<AddDirsDeps> = {}) {
  const writes: string[] = [];
  const sleeps: number[] = [];
  const delivered: string[] = [];
  const deps: AddDirsDeps = {
    sessionId: 's',
    inFlight: new Set(),
    sessionExists: () => true,
    isAlive: () => true,
    isBusy: () => false,
    typeable: () => ['C:\\a b', 'D:\\c'],
    write: (d) => {
      writes.push(d);
      return true;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onDelivered: (p) => delivered.push(p),
    ...over,
  };
  return { deps, writes, sleeps, delivered };
}

describe('runAddDirs (AC-8)', () => {
  it('busy → busy with zero writes', async () => {
    const f = fake({ isBusy: () => true });
    expect(await runAddDirs(f.deps)).toEqual({ ok: false, reason: 'busy', delivered: [] });
    expect(f.writes).toEqual([]);
    expect(f.deps.inFlight.size).toBe(0);
  });

  it('idle, two paths → writes exactly the lines and Enters, sleeps between', async () => {
    const f = fake();
    expect(await runAddDirs(f.deps)).toEqual({ ok: true, delivered: ['C:\\a b', 'D:\\c'] });
    expect(f.writes).toEqual(['/add-dir C:\\a b', '\r', '/add-dir D:\\c', '\r']);
    expect(f.sleeps).toEqual([SUBMIT_GAP_MS, ADD_DIR_LINE_GAP_MS, SUBMIT_GAP_MS]);
    expect(f.sleeps).toEqual([120, 300, 120]);
    expect(f.delivered).toEqual(['C:\\a b', 'D:\\c']);
  });

  it('the path is typed verbatim: double spaces and & survive', async () => {
    const f = fake({ typeable: () => ['C:\\R&D  x'] });
    await runAddDirs(f.deps);
    expect(f.writes[0]).toBe('/add-dir C:\\R&D  x');
  });

  it('dead after the first Enter → writeFailed, delivered [p1], onDelivered once', async () => {
    let enters = 0;
    const f = fake({
      isAlive: () => enters < 1,
      write: (d) => {
        if (d === '\r') enters++;
        return true;
      },
    });
    expect(await runAddDirs(f.deps)).toEqual({
      ok: false,
      reason: 'writeFailed',
      delivered: ['C:\\a b'],
    });
    expect(f.delivered).toEqual(['C:\\a b']);
  });

  it('dead inside the submit gap → no Enter is written', async () => {
    let alive = true;
    const writes: string[] = [];
    const f = fake({
      isAlive: () => alive,
      write: (d) => {
        writes.push(d);
        return true;
      },
      sleep: async () => {
        alive = false;
      },
    });
    const r = await runAddDirs(f.deps);
    expect(r).toEqual({ ok: false, reason: 'writeFailed', delivered: [] });
    expect(writes).toEqual(['/add-dir C:\\a b']);
  });

  it('a refused write → writeFailed', async () => {
    const f = fake({ write: () => false });
    expect(await runAddDirs(f.deps)).toEqual({ ok: false, reason: 'writeFailed', delivered: [] });
  });

  it('second call while the first awaits → inFlight, no writes', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inFlight = new Set<string>();
    const first = fake({ inFlight, sleep: () => gate });
    const second = fake({ inFlight });
    const p1 = runAddDirs(first.deps);
    expect(await runAddDirs(second.deps)).toEqual({
      ok: false,
      reason: 'inFlight',
      delivered: [],
    });
    expect(second.writes).toEqual([]);
    release();
    await p1;
    expect(inFlight.size).toBe(0);
  });

  it('latch released after a failure', async () => {
    const inFlight = new Set<string>();
    const f = fake({
      inFlight,
      write: () => {
        throw new Error('pty gone');
      },
    });
    await expect(runAddDirs(f.deps)).rejects.toThrow('pty gone');
    expect(inFlight.size).toBe(0);
    const g = fake({ inFlight, write: () => false });
    await runAddDirs(g.deps);
    expect(inFlight.size).toBe(0);
  });

  it('no scope → notClaude; empty → nothingPending; dead → notRunning; gone → noSession', async () => {
    expect(await runAddDirs(fake({ typeable: () => undefined }).deps)).toMatchObject({
      reason: 'notClaude',
    });
    expect(await runAddDirs(fake({ typeable: () => [] }).deps)).toMatchObject({
      reason: 'nothingPending',
    });
    expect(await runAddDirs(fake({ isAlive: () => false }).deps)).toMatchObject({
      reason: 'notRunning',
    });
    expect(await runAddDirs(fake({ sessionExists: () => false }).deps)).toMatchObject({
      reason: 'noSession',
    });
  });

  it('the list is snapshotted at the start', async () => {
    const list = ['/a', '/b'];
    const f = fake({ typeable: () => list });
    const p = runAddDirs(f.deps);
    list.push('/c');
    await p;
    expect(f.delivered).toEqual(['/a', '/b']);
  });
});
