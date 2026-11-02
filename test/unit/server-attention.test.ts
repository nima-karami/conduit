import { afterEach, describe, expect, it } from 'vitest';
import { ServerAttention } from '../../server/attention';
import type { AttentionEdge } from '../../src/contracts/server-ports';
import type { ReportedStatus, RuntimeEvent } from '../../src/contracts/terminal-runtime';

let attention: ServerAttention;
let now = 0;
let emit: (e: RuntimeEvent) => void;
const edges: AttentionEdge[] = [];

function setup() {
  now = 0;
  edges.length = 0;
  const listeners = new Set<(e: RuntimeEvent) => void>();
  emit = (e) => {
    for (const l of listeners) l(e);
  };
  attention = new ServerAttention({
    runtime: {
      on: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    now: () => now,
    sweepMs: 1_000_000,
  });
  attention.onEdge((e) => edges.push(e));
  emit({ type: 'spawned', sessionId: 'a', generation: 1, size: { cols: 80, rows: 24 } });
}
afterEach(() => attention?.dispose());

const data = (d: string) => emit({ type: 'data', sessionId: 'a', generation: 1, data: d });
const status = (s: ReportedStatus) => emit({ type: 'status', sessionId: 'a', status: s });
const at = (ms: number) => {
  now = ms;
};

describe('ServerAttention', () => {
  it('heuristics for a non-reporting program: a bell arms an edge on sweep', async () => {
    setup();
    at(10_000);
    data('done\x07');
    at(20_000);
    attention.sweep();
    expect(edges).toEqual([{ sessionId: 'a', kind: 'bell' }]);
    expect(attention.statusOf('a').needsAttention).toBe(true);
  });

  it('inert output is not activity', () => {
    setup();
    at(10_000);
    data('\x1b[?2004h');
    expect(attention.statusOf('a').busy).toBe(false);
    expect(attention.lastOutputAt('a')).toBe(0);
  });

  it('OSC 7501 is primary: working is busy, leaving it arms one run-end edge', () => {
    setup();
    at(10_000);
    status({ state: 'working' });
    expect(attention.statusOf('a')).toMatchObject({ busy: true, needsAttention: false });
    status({ state: 'idle' });
    expect(attention.statusOf('a')).toEqual({
      busy: false,
      needsAttention: true,
      completedRun: true,
    });
    status({ state: 'idle' });
    expect(edges).toEqual([{ sessionId: 'a', kind: 'run-end' }]);
  });

  it('a reporting program ignores the output heuristics (bells, run-end)', () => {
    setup();
    status({ state: 'idle' });
    at(10_000);
    data('x'.repeat(4000));
    data('\x07');
    at(30_000);
    attention.sweep();
    expect(edges).toEqual([]);
    expect(attention.statusOf('a').needsAttention).toBe(false);
  });

  it('a blocked report arms once; a repeat is the same episode', () => {
    setup();
    status({ state: 'blocked', kind: 'permission' });
    status({ state: 'blocked', kind: 'permission' });
    attention.setVisible(1, ['a']);
    attention.dropWindow(1);
    status({ state: 'blocked', kind: 'permission' });
    expect(edges).toHaveLength(1);
    expect(attention.statusOf('a').needsAttention).toBe(false);
  });

  it('visibility acknowledges and suppresses, for both paths', () => {
    setup();
    status({ state: 'working' });
    attention.setVisible(1, ['a']);
    status({ state: 'done' });
    expect(edges).toEqual([]);
    attention.dropWindow(1);
    status({ state: 'working' });
    status({ state: 'done' });
    expect(attention.statusOf('a').needsAttention).toBe(true);
    expect(attention.setVisible(2, ['a'])).toBe(true);
    expect(attention.statusOf('a').needsAttention).toBe(false);
  });

  it('input clears an armed episode', () => {
    setup();
    at(10_000);
    data('\x07');
    at(20_000);
    attention.sweep();
    expect(attention.statusOf('a').needsAttention).toBe(true);
    attention.recordInput('a', 20_001);
    expect(attention.statusOf('a').needsAttention).toBe(false);
    at(30_000);
    attention.sweep();
    expect(attention.statusOf('a').needsAttention).toBe(false);
  });

  it('clearAll drops every window: an unwatched run arms again', () => {
    setup();
    attention.setVisible(1, ['a']);
    attention.clearAll();
    status({ state: 'working' });
    status({ state: 'idle' });
    expect(edges).toHaveLength(1);
  });

  it('an exit ends the episode; a status of null falls back to heuristics', () => {
    setup();
    status({ state: 'blocked', kind: null });
    status(null);
    expect(attention.statusOf('a').needsAttention).toBe(false);
    status({ state: 'blocked', kind: null });
    emit({ type: 'exit', sessionId: 'a', generation: 1, code: 0, reason: 'exited' });
    expect(attention.statusOf('a')).toMatchObject({ busy: false, needsAttention: false });
  });

  it('paints are never activity', () => {
    setup();
    at(10_000);
    emit({
      type: 'paint',
      sessionId: 'a',
      generation: 1,
      data: 'x'.repeat(5000),
      size: { cols: 80, rows: 24 },
      cause: 'gap',
    });
    expect(attention.statusOf('a').busy).toBe(false);
  });
});
