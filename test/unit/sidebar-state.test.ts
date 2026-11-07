import { describe, expect, it } from 'vitest';
import {
  type AgentRuntime,
  advanceAgentRuntime,
  agentOwnState,
  defaultNewAgentProject,
  defaultSidebarUi,
  formatStateAge,
  parseSidebarUi,
} from '../../src/sidebar-state';
import type { Session } from '../../src/types';

const S = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  name: id,
  agentId: 'claude',
  home: '/w',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  attentionReason: null,
  completions: 0,
  ...over,
});
const NO_ASKS: ReadonlySet<string> = new Set();
const ids = (...v: string[]): ReadonlySet<string> => new Set(v);

function step(
  previous: AgentRuntime | null,
  before: readonly Session[],
  sessions: readonly Session[],
  o: {
    viewed?: ReadonlySet<string>;
    asks?: ReadonlySet<string>;
    prevAsks?: ReadonlySet<string>;
  } = {},
  now = 1000,
): AgentRuntime {
  return advanceAgentRuntime({
    previous,
    before,
    sessions,
    previousAskSessionIds: o.prevAsks ?? NO_ASKS,
    askSessionIds: o.asks ?? NO_ASKS,
    viewedTerminalIds: o.viewed ?? NO_ASKS,
    now,
  });
}

describe('agentOwnState', () => {
  it('ranks stopped, then needs-you, working, done, idle', () => {
    expect(agentOwnState(S('a', { status: 'stale', attentionReason: 'blocked' }), 0, true)).toBe(
      'stopped',
    );
    expect(agentOwnState(S('a', { status: 'exited' }), 0, false)).toBe('stopped');
    expect(agentOwnState(S('a', { attentionReason: 'bell', busy: true }), 0, false)).toBe(
      'blocked',
    );
    expect(agentOwnState(S('a', { busy: true }), 0, true)).toBe('blocked');
    expect(agentOwnState(S('a', { busy: true, completions: 3 }), 0, false)).toBe('working');
    expect(agentOwnState(S('a', { completions: 3 }), 2, false)).toBe('done');
    expect(agentOwnState(S('a', { completions: 3 }), 3, false)).toBe('idle');
  });

  it('ignores the legacy flags and repo dirtiness', () => {
    const legacy = S('a', {
      needsAttention: true,
      completedRun: true,
      repoGit: { '/w': { kind: 'branch', branch: 'x', dirty: true } },
      activeRepoRoot: '/w',
    });
    expect(agentOwnState(legacy, 0, false)).toBe('idle');
  });

  it('reads absent or malformed facts as null/0', () => {
    const { attentionReason: _r, completions: _c, ...bare } = S('a');
    expect(agentOwnState(bare, 0, false)).toBe('idle');
    for (const completions of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])
      expect(agentOwnState(S('a', { completions }), 0, false)).toBe('idle');
    const odd = { ...S('a'), attentionReason: 'later' } as unknown as Session;
    expect(agentOwnState(odd, 0, false)).toBe('idle');
  });
});

describe('advanceAgentRuntime', () => {
  it('holds only seen and stateSince', () => {
    const r = step(null, [], [S('a')]);
    expect(Object.keys(r).sort()).toEqual(['seen', 'stateSince']);
  });

  it('baselines every session on the first snapshot, so history never reads Done', () => {
    const r = step(null, [], [S('a', { completions: 5 }), S('b', { completions: 0 })]);
    expect(r.seen).toEqual({ a: 5, b: 0 });
  });

  it('baselines a newly admitted id on first sight, even with a high counter', () => {
    const r0 = step(null, [], [S('a')]);
    const r1 = step(r0, [S('a')], [S('a'), S('b', { completions: 7 })]);
    expect(r1.seen.b).toBe(7);
  });

  it('keeps seen behind a counter that jumped by more than one, until strictly viewed', () => {
    const a0 = S('a', { completions: 1 });
    const r0 = step(null, [], [a0]);
    const a1 = S('a', { completions: 4 });
    const r1 = step(r0, [a0], [a1]);
    expect(r1.seen.a).toBe(1);
    expect(agentOwnState(a1, r1.seen.a, false)).toBe('done');
    const r2 = step(r1, [a1], [a1], { viewed: ids('a') });
    expect(r2.seen.a).toBe(4);
  });

  it('only the strictly viewed terminal advances seen', () => {
    const a0 = S('a');
    const b0 = S('b');
    const r0 = step(null, [], [a0, b0]);
    const a1 = S('a', { completions: 1 });
    const b1 = S('b', { completions: 1 });
    // The App passes only the focused, visible terminal in a focused window; an active session
    // behind an editor, a background split or an unfocused window is simply absent from this set.
    const r1 = step(r0, [a0, b0], [a1, b1], { viewed: ids('b') });
    expect(r1.seen).toEqual({ a: 0, b: 1 });
    expect(agentOwnState(a1, r1.seen.a, false)).toBe('done');
    expect(agentOwnState(b1, r1.seen.b, false)).toBe('idle');
  });

  it('clamps seen to a counter that decreased (a server restart)', () => {
    const a0 = S('a', { completions: 6 });
    const r0 = step(null, [], [a0]);
    const a1 = S('a', { completions: 0 });
    const r1 = step(r0, [a0], [a1]);
    expect(r1.seen.a).toBe(0);
    const a2 = S('a', { completions: 1 });
    expect(agentOwnState(a2, step(r1, [a1], [a2]).seen.a, false)).toBe('done');
  });

  it('prunes vanished ids', () => {
    const r0 = step(null, [], [S('a'), S('b')]);
    const r1 = step(r0, [S('a'), S('b')], [S('a')]);
    expect(Object.keys(r1.seen)).toEqual(['a']);
    expect(Object.keys(r1.stateSince)).toEqual(['a']);
  });

  it('initialises stateSince from a finite lastActiveAt clamped to now', () => {
    const r = step(
      null,
      [],
      [
        S('past', { lastActiveAt: 400 }),
        S('future', { lastActiveAt: 9e12 }),
        S('bad', { lastActiveAt: Number.NaN }),
      ],
      {},
      1000,
    );
    expect(r.stateSince).toEqual({ past: 400, future: 1000, bad: 1000 });
  });

  it('moves stateSince only when the own derived state changes', () => {
    const a0 = S('a', { lastActiveAt: 10 });
    const r0 = step(null, [], [a0], {}, 100);
    // An unrelated broadcast (name, cwd, lastLine) keeps the age.
    const a1 = { ...a0, name: 'renamed', lastLine: 'x' };
    expect(step(r0, [a0], [a1], {}, 200).stateSince.a).toBe(10);
    // Working starts.
    const a2 = { ...a1, busy: true };
    const r2 = step(r0, [a1], [a2], {}, 300);
    expect(r2.stateSince.a).toBe(300);
    // A completion while working is still Working.
    const a3 = { ...a2, completions: 1 };
    expect(step(r2, [a2], [a3], {}, 400).stateSince.a).toBe(300);
  });

  it('moves stateSince on an ask, a reason, a completion and a view', () => {
    const a0 = S('a');
    const r0 = step(null, [], [a0], {}, 100);
    const r1 = step(r0, [a0], [a0], { asks: ids('a') }, 200);
    expect(r1.stateSince.a).toBe(200);
    const r2 = step(r1, [a0], [a0], { prevAsks: ids('a') }, 300);
    expect(r2.stateSince.a).toBe(300);
    const a1 = S('a', { attentionReason: 'bell' });
    const r3 = step(r2, [a0], [a1], {}, 400);
    expect(r3.stateSince.a).toBe(400);
    const a2 = S('a', { completions: 1 });
    const r4 = step(r3, [a1], [a2], {}, 500);
    expect(r4.stateSince.a).toBe(500); // Needs you -> Done
    const r5 = step(r4, [a2], [a2], { viewed: ids('a') }, 600);
    expect(r5.stateSince.a).toBe(600); // Done -> Idle
  });

  it('returns the previous object when nothing changed', () => {
    const a0 = S('a');
    const r0 = step(null, [], [a0]);
    expect(step(r0, [a0], [a0])).toBe(r0);
  });
});

describe('formatStateAge', () => {
  it('uses <1m, minutes, hours, then days, floored', () => {
    const now = 10 * 86_400_000;
    expect(formatStateAge(now, now)).toBe('<1m');
    expect(formatStateAge(now - 59_999, now)).toBe('<1m');
    expect(formatStateAge(now - 60_000, now)).toBe('1m');
    expect(formatStateAge(now - 3_599_999, now)).toBe('59m');
    expect(formatStateAge(now - 3_600_000, now)).toBe('1h');
    expect(formatStateAge(now - 86_399_999, now)).toBe('23h');
    expect(formatStateAge(now - 86_400_000, now)).toBe('1d');
    expect(formatStateAge(now - 9 * 86_400_000, now)).toBe('9d');
  });

  it('clamps a future instant to <1m', () => {
    expect(formatStateAge(5000, 1000)).toBe('<1m');
  });
});

describe('sidebar UI state', () => {
  it('defaults to All with Stopped folded', () => {
    expect(defaultSidebarUi()).toEqual({
      selection: { kind: 'all' },
      foldedGroups: ['stopped'],
      foldedSessions: [],
      pinnedIds: [],
    });
  });

  it('round-trips a valid value and ignores unknown fields', () => {
    const v = {
      selection: { kind: 'space', projectId: 'p1' },
      foldedGroups: ['done', 'pinned'],
      foldedSessions: ['a'],
      pinnedIds: ['b', 'c'],
      extra: 1,
    };
    expect(parseSidebarUi(v)).toEqual({
      selection: { kind: 'space', projectId: 'p1' },
      foldedGroups: ['done', 'pinned'],
      foldedSessions: ['a'],
      pinnedIds: ['b', 'c'],
    });
    expect(parseSidebarUi({ ...v, selection: { kind: 'none' } }).selection).toEqual({
      kind: 'none',
    });
    expect(parseSidebarUi({ ...v, foldedGroups: [] }).foldedGroups).toEqual([]);
  });

  it('defaults malformed input and fields', () => {
    for (const bad of [undefined, null, 3, 'x', []])
      expect(parseSidebarUi(bad)).toEqual(defaultSidebarUi());
    const parsed = parseSidebarUi({
      selection: { kind: 'space', projectId: '' },
      foldedGroups: 'stopped',
      foldedSessions: [1, 'a', 'a', null],
      pinnedIds: ['b', 'b', 'c'],
    });
    expect(parsed).toEqual({
      selection: { kind: 'all' },
      foldedGroups: ['stopped'],
      foldedSessions: ['a'],
      pinnedIds: ['b', 'c'],
    });
    expect(parseSidebarUi({ foldedGroups: ['bogus', 'idle', 'idle'] }).foldedGroups).toEqual([
      'idle',
    ]);
  });

  it('caps every list at 10,000 entries', () => {
    const many = Array.from({ length: 10_050 }, (_, i) => `s${i}`);
    const parsed = parseSidebarUi({ foldedSessions: many, pinnedIds: many });
    expect(parsed.foldedSessions).toHaveLength(10_000);
    expect(parsed.pinnedIds).toHaveLength(10_000);
  });
});

describe('defaultNewAgentProject', () => {
  const sessions = [S('a', { projectId: 'p1' }), S('b')];
  it('uses the selected Space, or none for No space', () => {
    expect(defaultNewAgentProject({ kind: 'space', projectId: 'p2' }, sessions, 'a')).toBe('p2');
    expect(defaultNewAgentProject({ kind: 'none' }, sessions, 'a')).toBeNull();
  });
  it("under All, uses the last focused agent's Space, else No space", () => {
    expect(defaultNewAgentProject({ kind: 'all' }, sessions, 'a')).toBe('p1');
    expect(defaultNewAgentProject({ kind: 'all' }, sessions, 'b')).toBeNull();
    expect(defaultNewAgentProject({ kind: 'all' }, sessions, 'gone')).toBeNull();
    expect(defaultNewAgentProject({ kind: 'all' }, sessions, undefined)).toBeNull();
  });
});

describe('agentOwnState — stuck screens (CON-151)', () => {
  it('a stuck session is blocked, busy or not', () => {
    expect(agentOwnState(S('a', { attentionReason: 'stuck', busy: true }), 0, false)).toBe(
      'blocked',
    );
    expect(agentOwnState(S('a', { attentionReason: 'stuck' }), 0, false)).toBe('blocked');
  });
});
