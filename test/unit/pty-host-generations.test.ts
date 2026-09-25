import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview } from '../../src/protocol';
import { PtyHost } from '../../src/pty-host';

// Per-spawn generations (mf-live-edits spec §2.4 R1): each fake child keeps its own callbacks,
// so a test can fire an old child's exit after a newer one has started.
interface FakeChild {
  data: (d: string) => void;
  exit: (e: { exitCode: number }) => void;
  kills: number;
  writes: string[];
}
const children: FakeChild[] = [];

vi.mock('@lydell/node-pty', () => ({
  spawn: () => {
    const c: FakeChild = { data: () => {}, exit: () => {}, kills: 0, writes: [] };
    children.push(c);
    return {
      onData: (cb: (d: string) => void) => {
        c.data = cb;
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        c.exit = cb;
      },
      write: (d: string) => c.writes.push(d),
      resize: () => {},
      kill: () => {
        c.kills++;
      },
    };
  },
}));

const spec = { command: 'cmd.exe', args: [] as string[], cwd: '.' };

function host() {
  const sent: HostToWebview[] = [];
  const h = new PtyHost((m) => sent.push(m));
  const exits = () => sent.filter((m) => m.type === 'term:exit');
  const data = () => sent.flatMap((m) => (m.type === 'term:data' ? [m.data] : []));
  return { h, sent, exits, data };
}

describe('PtyHost generations (AC-9)', () => {
  beforeEach(() => {
    children.length = 0;
  });

  it('gen-1 exit after retire + gen-2 start leaves gen 2 alive and sends no term:exit', () => {
    const { h, exits } = host();
    h.start('s', 80, 24, spec);
    expect(h.retire('s')).toBe(true);
    expect(children[0].kills).toBe(1);
    h.start('s', 80, 24, spec);
    const gen2 = h.generation('s');
    children[0].exit({ exitCode: 1 });
    expect(h.isAlive('s')).toBe(true);
    expect(h.generation('s')).toBe(gen2);
    expect(exits()).toEqual([]);
    expect(h.input('s', 'x')).toBe(true);
    expect(children[1].writes).toEqual(['x']);
  });

  it('gen-1 exit after dispose + gen-2 start is ignored', () => {
    const { h, exits } = host();
    h.start('s', 80, 24, spec);
    h.dispose('s');
    h.start('s', 80, 24, spec);
    children[0].exit({ exitCode: 0 });
    expect(h.isAlive('s')).toBe(true);
    expect(exits()).toEqual([]);
  });

  it('data from a retired child is dropped', () => {
    const { h, data } = host();
    h.start('s', 80, 24, spec);
    h.retire('s');
    children[0].data('late from gen 1');
    h.start('s', 80, 24, spec);
    children[0].data('later from gen 1');
    children[1].data('gen 2');
    expect(data()).toEqual(['gen 2']);
    expect(h.lastLine('s')).toBe('gen 2');
  });

  it('exit of a disposed child with no successor still sends term:exit', () => {
    const { h, exits } = host();
    h.start('s', 80, 24, spec);
    h.dispose('s');
    children[0].exit({ exitCode: 3 });
    expect(exits()).toEqual([{ type: 'term:exit', sessionId: 's', code: 3 }]);
  });

  it('exit of the current child deletes it and sends term:exit', () => {
    const { h, exits } = host();
    h.start('s', 80, 24, spec);
    children[0].exit({ exitCode: 0 });
    expect(h.isAlive('s')).toBe(false);
    expect(h.generation('s')).toBeUndefined();
    expect(exits()).toHaveLength(1);
  });

  it('generation increases per start; undefined when none', () => {
    const { h } = host();
    expect(h.generation('s')).toBeUndefined();
    h.start('s', 80, 24, spec);
    const g1 = h.generation('s') as number;
    h.start('t', 80, 24, spec);
    const t1 = h.generation('t') as number;
    h.retire('s');
    expect(h.generation('s')).toBeUndefined();
    h.start('s', 80, 24, spec);
    const g2 = h.generation('s') as number;
    expect(t1).toBeGreaterThan(g1);
    expect(g2).toBeGreaterThan(t1);
  });

  it('retire → isAlive false at once; retire with none → false', () => {
    const { h } = host();
    expect(h.retire('s')).toBe(false);
    h.start('s', 80, 24, spec);
    h.retire('s');
    expect(h.isAlive('s')).toBe(false);
    expect(h.input('s', 'x')).toBe(false);
    expect(children[0].writes).toEqual([]);
  });

  it('disposeAll kills retired children', () => {
    const { h } = host();
    h.start('s', 80, 24, spec);
    h.retire('s');
    h.start('s', 80, 24, spec);
    h.disposeAll();
    expect(children[0].kills).toBe(2);
    expect(children[1].kills).toBe(1);
  });

  it('a retired child that already exited is not killed again by disposeAll', () => {
    const { h } = host();
    h.start('s', 80, 24, spec);
    h.retire('s');
    children[0].exit({ exitCode: 0 });
    h.disposeAll();
    expect(children[0].kills).toBe(1);
  });
});
