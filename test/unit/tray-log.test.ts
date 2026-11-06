import { describe, expect, it } from 'vitest';
import { createTrayLog, type TrayLogFs } from '../../server/tray/tray-log';

function memFs() {
  const files = new Map<string, string>();
  const fs: TrayLogFs = {
    size: (p) => Buffer.byteLength(files.get(p) ?? ''),
    append: (p, s) => {
      files.set(p, (files.get(p) ?? '') + s);
    },
    rename: (a, b) => {
      const v = files.get(a);
      if (v === undefined) throw new Error('ENOENT');
      files.set(b, v);
      files.delete(a);
    },
  };
  return { fs, files };
}

const at = () => Date.UTC(2026, 10, 3, 12, 0, 0);

describe('createTrayLog', () => {
  it('writes ISO time, level, who and the message on one line', () => {
    const { fs, files } = memFs();
    const log = createTrayLog('/u/tray.log', { fs, now: at });
    log.write('warn', 'helper', 'icon\r\nnot added');
    expect(files.get('/u/tray.log')).toBe('2026-11-03T12:00:00.000Z warn helper icon not added\n');
  });

  it('defaults to the 1 MB cap', () => {
    const { fs, files } = memFs();
    files.set('/u/tray.log', 'x'.repeat(1_048_576 - 10));
    createTrayLog('/u/tray.log', { fs, now: at }).write('info', 'supervisor', 'next');
    expect(files.get('/u/tray.log.1')?.length).toBe(1_048_576 - 10);
    expect(files.get('/u/tray.log')).toContain('next');
  });

  it('rotates once into tray.log.1 when the next line would pass the cap', () => {
    const { fs, files } = memFs();
    const log = createTrayLog('/u/tray.log', { fs, now: at, capBytes: 170 });
    const line = (n: number) => `m${n}`.padEnd(40, 'x');
    log.write('info', 'supervisor', line(1));
    log.write('info', 'supervisor', line(2));
    expect(files.has('/u/tray.log.1')).toBe(false);
    log.write('info', 'supervisor', line(3));
    expect(files.get('/u/tray.log.1')).toContain('m1');
    expect(files.get('/u/tray.log.1')).toContain('m2');
    expect(files.get('/u/tray.log')).toContain('m3');
    expect(files.get('/u/tray.log')).not.toContain('m1');
    log.write('info', 'supervisor', line(4));
    log.write('info', 'supervisor', line(5));
    expect(files.get('/u/tray.log.1')).toContain('m3');
    expect(files.get('/u/tray.log.1')).not.toContain('m1');
    expect([...files.keys()].sort()).toEqual(['/u/tray.log', '/u/tray.log.1']);
  });

  it('a failing write goes to the fallback, never throws', () => {
    const fallback: string[] = [];
    const log = createTrayLog('/u/tray.log', {
      fs: {
        size: () => 0,
        append: () => {
          throw new Error('EACCES');
        },
        rename: () => {},
      },
      now: at,
      fallback: (l) => fallback.push(l),
    });
    expect(() => log.write('error', 'supervisor', 'boom')).not.toThrow();
    expect(fallback.join()).toMatch(/EACCES/);
    expect(fallback.join()).toMatch(/boom/);
  });
});
