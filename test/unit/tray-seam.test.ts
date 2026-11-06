import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTraySeam,
  type SeamFs,
  TRAY_SEAM_IN_FILE,
  TRAY_SEAM_OUT_FILE,
} from '../../server/tray/seam';
import type { HelperToSupervisor } from '../../src/contracts/tray-protocol';

const IN = path.join('/u', TRAY_SEAM_IN_FILE);

function harness() {
  const files = new Map<string, Buffer>();
  const fs: SeamFs = {
    append: (p, s) => {
      files.set(p, Buffer.concat([files.get(p) ?? Buffer.alloc(0), Buffer.from(s)]));
    },
    read: (p) => files.get(p) ?? null,
  };
  const timers: { ms: number; cb: () => void; cancelled: boolean }[] = [];
  const setTimer = (ms: number, cb: () => void) => {
    const t = { ms, cb, cancelled: false };
    timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  const tick = () => {
    const live = timers.filter((t) => !t.cancelled);
    timers.length = 0;
    for (const t of live) t.cb();
  };
  const logs: string[] = [];
  const seam = createTraySeam({
    userData: '/u',
    fs,
    setTimer,
    log: { write: (_l, _w, m) => logs.push(m) },
  });
  return { seam, files, timers, tick, logs, fs };
}

describe('tray seam', () => {
  it('mirrors both directions as one JSON line each', () => {
    const h = harness();
    h.seam.mirror('out', { type: 'exit' });
    h.seam.mirror('in', { type: 'hidden' });
    const lines =
      h.files.get(path.join('/u', TRAY_SEAM_OUT_FILE))?.toString().trim().split('\n') ?? [];
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { dir: 'out', message: { type: 'exit' } },
      { dir: 'in', message: { type: 'hidden' } },
    ]);
  });

  it('injects each complete line from tray-seam-in.jsonl once, polling every 250 ms', () => {
    const h = harness();
    const got: HelperToSupervisor[] = [];
    const dispose = h.seam.injected((m) => got.push(m));
    expect(h.timers.map((t) => t.ms)).toEqual([250]);
    h.tick();
    expect(got).toEqual([]);
    h.fs.append(IN, '{"type":"stopAll"}\n{"type":"sho');
    h.tick();
    expect(got).toEqual([{ type: 'stopAll' }]);
    h.fs.append(IN, 'wn"}\n');
    h.tick();
    h.tick();
    expect(got).toEqual([{ type: 'stopAll' }, { type: 'shown' }]);
    dispose();
    h.fs.append(IN, '{"type":"stopAll"}\n');
    h.tick();
    expect(got).toHaveLength(2);
  });

  it('an invalid or unknown injected line is logged and skipped', () => {
    const h = harness();
    const got: HelperToSupervisor[] = [];
    h.seam.injected((m) => got.push(m));
    h.fs.append(IN, 'nope\n{"type":"future"}\n{"type":"opened"}\n');
    h.tick();
    expect(got).toEqual([{ type: 'opened' }]);
    expect(h.logs).toHaveLength(2);
  });

  it('a truncated input file starts over from its beginning', () => {
    const h = harness();
    const got: HelperToSupervisor[] = [];
    h.seam.injected((m) => got.push(m));
    h.fs.append(IN, '{"type":"shown"}\n{"type":"hidden"}\n');
    h.tick();
    h.files.set(IN, Buffer.from('{"type":"opened"}\n'));
    h.tick();
    expect(got.map((m) => m.type)).toEqual(['shown', 'hidden', 'opened']);
  });

  it('a throwing read is logged and polling continues', () => {
    const h = harness();
    const files = h.files;
    let fail = true;
    h.fs.read = (p) => {
      if (fail) throw new Error('EBUSY');
      return files.get(p) ?? null;
    };
    const got: HelperToSupervisor[] = [];
    h.seam.injected((m) => got.push(m));
    h.tick();
    expect(h.logs.join()).toMatch(/EBUSY/);
    fail = false;
    h.fs.append(IN, '{"type":"opened"}\n');
    h.tick();
    expect(got).toEqual([{ type: 'opened' }]);
  });
});
