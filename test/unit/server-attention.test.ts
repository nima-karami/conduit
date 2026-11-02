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
      attentionReason: null,
      completions: 1,
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

  it('input into a hidden session is not an acknowledgment: the episode stays armed, once', () => {
    setup();
    at(10_000);
    data('\x07');
    at(20_000);
    attention.sweep();
    expect(attention.statusOf('a').needsAttention).toBe(true);
    attention.recordInput('a', 20_001);
    data('echo x\r\n');
    at(30_000);
    attention.sweep();
    expect(attention.statusOf('a').needsAttention).toBe(true);
    expect(edges).toHaveLength(1);
  });

  it('input does not clear a reported waiting episode', () => {
    setup();
    status({ state: 'working' });
    status({ state: 'done' });
    expect(attention.statusOf('a').needsAttention).toBe(true);
    attention.recordInput('a', 1);
    expect(attention.statusOf('a').needsAttention).toBe(true);
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

describe('ServerAttention — completions and reasons (sidebar-agent-tree spec §4)', () => {
  const big = () => data('x'.repeat(2000));
  const facts = () => {
    const s = attention.statusOf('a');
    return { attentionReason: s.attentionReason, completions: s.completions };
  };

  it('an untracked session reads neutral facts', () => {
    setup();
    expect(attention.statusOf('nobody')).toEqual({
      busy: false,
      needsAttention: false,
      completedRun: false,
      attentionReason: null,
      completions: 0,
    });
  });

  it('a heuristic run counts while visible, with no legacy edge', () => {
    setup();
    attention.setVisible(1, ['a']);
    at(10_000);
    big();
    at(20_000);
    attention.sweep();
    expect(facts()).toEqual({ attentionReason: null, completions: 1 });
    expect(edges).toEqual([]);
    expect(attention.statusOf('a').needsAttention).toBe(false);
  });

  it('every qualifying heuristic run counts, even with the legacy episode armed', () => {
    setup();
    at(10_000);
    big();
    at(20_000);
    attention.sweep();
    at(30_000);
    big();
    at(40_000);
    attention.sweep();
    expect(facts().completions).toBe(2);
    expect(edges).toEqual([{ sessionId: 'a', kind: 'run-end' }]);
  });

  it('a reported Working -> Done/Idle counts once; Blocked and repeats do not', () => {
    setup();
    status({ state: 'working' });
    status({ state: 'done' });
    status({ state: 'done' });
    expect(facts().completions).toBe(1);
    status({ state: 'working' });
    status({ state: 'blocked', kind: 'permission' });
    expect(facts().completions).toBe(1);
    status({ state: 'working' });
    status({ state: 'idle' });
    expect(facts().completions).toBe(2);
    status({ state: 'working' });
    status({ state: 'error' });
    expect(facts().completions).toBe(2);
  });

  it('a reporting program’s output is not also counted by the heuristic', () => {
    setup();
    status({ state: 'working' });
    at(10_000);
    big();
    status({ state: 'done' });
    at(30_000);
    attention.sweep();
    expect(facts().completions).toBe(1);
  });

  it('the counter survives spawn and exit, and resets on forget and a new server', () => {
    setup();
    status({ state: 'working' });
    status({ state: 'done' });
    emit({ type: 'exit', sessionId: 'a', generation: 1, code: 0, reason: 'exited' });
    emit({ type: 'spawned', sessionId: 'a', generation: 2, size: { cols: 80, rows: 24 } });
    expect(facts().completions).toBe(1);
    attention.forgetSession('a');
    expect(facts().completions).toBe(0);
    status({ state: 'working' });
    status({ state: 'done' });
    expect(facts().completions).toBe(1);
    attention.dispose();
    setup();
    expect(facts().completions).toBe(0);
  });

  it('entering Blocked while hidden is the blocked reason; Working, visibility and exit clear it', () => {
    setup();
    status({ state: 'blocked', kind: 'question' });
    expect(facts().attentionReason).toBe('blocked');
    status({ state: 'working' });
    expect(facts().attentionReason).toBeNull();
    status({ state: 'blocked', kind: 'question' });
    attention.setVisible(1, ['a']);
    expect(facts().attentionReason).toBeNull();
    attention.dropWindow(1);
    status({ state: 'working' });
    status({ state: 'blocked', kind: null });
    expect(facts().attentionReason).toBe('blocked');
    emit({ type: 'exit', sessionId: 'a', generation: 1, code: 0, reason: 'exited' });
    expect(facts().attentionReason).toBeNull();
  });

  it('leaving Blocked for Done clears the reason and is not a completion', () => {
    setup();
    status({ state: 'blocked', kind: 'permission' });
    status({ state: 'done' });
    expect(facts()).toEqual({ attentionReason: null, completions: 0 });
  });

  it('Blocked on a visible session is no reason, as the legacy episode', () => {
    setup();
    attention.setVisible(1, ['a']);
    status({ state: 'blocked', kind: 'permission' });
    expect(facts().attentionReason).toBeNull();
  });

  it('a genuine bell while hidden is the bell reason and no completion; seeing it clears it', () => {
    setup();
    at(10_000);
    data('\x07');
    at(11_000);
    attention.sweep();
    expect(facts()).toEqual({ attentionReason: 'bell', completions: 0 });
    attention.setVisible(1, ['a']);
    expect(facts().attentionReason).toBeNull();
  });

  it('a bell on a visible session is no reason', () => {
    setup();
    attention.setVisible(1, ['a']);
    at(10_000);
    data('\x07');
    at(11_000);
    attention.sweep();
    expect(facts().attentionReason).toBeNull();
  });

  it('a counter-only or reason-only change notifies onChange and raises no edge', () => {
    setup();
    let changes = 0;
    attention.onChange(() => changes++);
    attention.setVisible(1, ['a']);
    at(10_000);
    big();
    at(12_000);
    attention.sweep(); // busy -> idle
    changes = 0;
    at(20_000);
    attention.sweep();
    expect(facts().completions).toBe(1);
    expect(changes).toBe(1);
    attention.dropWindow(1);
    status({ state: 'blocked', kind: 'permission' });
    changes = 0;
    status({ state: 'working' });
    status({ state: 'done' });
    expect(changes).toBeGreaterThanOrEqual(2);
    expect(edges.map((e) => e.kind)).toEqual(['run-end', 'run-end']);
  });
});

describe('ServerAttention — review round (authority switch, bell latch)', () => {
  const facts = () => {
    const s = attention.statusOf('a');
    return { attentionReason: s.attentionReason, completions: s.completions };
  };

  it('a program that stops reporting right after a reported Done counts that run once', () => {
    setup();
    status({ state: 'working' });
    at(10_000);
    data('x'.repeat(2000));
    status({ state: 'done' });
    status(null);
    at(30_000);
    attention.sweep();
    expect(facts().completions).toBe(1);
  });

  it('heuristic evidence from before a program starts reporting never completes later', () => {
    setup();
    at(10_000);
    data('x'.repeat(2000));
    status({ state: 'idle' });
    status(null);
    at(30_000);
    attention.sweep();
    expect(facts().completions).toBe(0);
  });

  it('every unseen bell raises the reason, even with the legacy episode already armed', () => {
    setup();
    at(10_000);
    data('x'.repeat(2000));
    at(20_000);
    attention.sweep();
    expect(attention.statusOf('a').needsAttention).toBe(true);
    expect(facts().attentionReason).toBeNull();
    at(25_000);
    data('\x07');
    expect(facts().attentionReason).toBe('bell');
  });

  it('the bell reason survives output inside the same run and clears when Working resumes', () => {
    setup();
    at(10_000);
    data('ask?\x07');
    at(10_500);
    data('statusline');
    expect(facts().attentionReason).toBe('bell');
    at(13_000);
    attention.sweep(); // quiet: no longer busy
    data('working again');
    expect(facts().attentionReason).toBeNull();
  });

  it('seeing the session clears the bell reason', () => {
    setup();
    at(10_000);
    data('\x07');
    expect(facts().attentionReason).toBe('bell');
    attention.setVisible(1, ['a']);
    expect(facts().attentionReason).toBeNull();
  });
});
