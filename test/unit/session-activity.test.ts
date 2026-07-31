import { describe, expect, it } from 'vitest';
import { SessionActivity } from '../../src/session-activity';
import type { Session } from '../../src/types';

const WINDOW = 1500;
const make = () => new SessionActivity({ busyWindowMs: WINDOW });

describe('SessionActivity (pure state machine)', () => {
  it('recordOutput marks a session busy (AC1)', () => {
    const a = make();
    expect(a.recordOutput('s', 0)).toBe(true); // idle -> busy is a change
    expect(a.statusOf('s')).toEqual({ busy: true, needsAttention: false, completedRun: false });
  });

  it('busy -> idle while unfocused sets needsAttention (AC2)', () => {
    const a = make();
    a.recordOutput('s', 0);
    expect(a.sweep(WINDOW)).toBe(true);
    expect(a.statusOf('s')).toEqual({ busy: false, needsAttention: true, completedRun: true });
  });

  it('finishing while focused does NOT set needsAttention (AC3)', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.focus('s');
    a.sweep(WINDOW);
    expect(a.statusOf('s')).toEqual({ busy: false, needsAttention: false, completedRun: true });
  });

  it('focus clears an existing needsAttention (AC4)', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.sweep(WINDOW); // unfocused -> attention
    expect(a.statusOf('s').needsAttention).toBe(true);
    expect(a.focus('s')).toBe(true);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('recordOutput while already busy reports no change (AC5)', () => {
    const a = make();
    a.recordOutput('s', 0);
    expect(a.recordOutput('s', 100)).toBe(false); // still busy, no flag change
    expect(a.statusOf('s').busy).toBe(true);
  });

  it('recordOutput on a flagged session clears attention (AC6)', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.sweep(WINDOW); // -> needsAttention
    expect(a.recordOutput('s', WINDOW + 10)).toBe(true); // busy again + cleared
    expect(a.statusOf('s')).toEqual({ busy: true, needsAttention: false, completedRun: true });
  });

  it('sweep before the window elapses keeps busy and reports no change (AC7)', () => {
    const a = make();
    a.recordOutput('s', 0);
    expect(a.sweep(WINDOW - 1)).toBe(false);
    expect(a.statusOf('s').busy).toBe(true);
  });

  it('forget untracks a session (AC8)', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.forget('s');
    expect(a.statusOf('s')).toEqual({ busy: false, needsAttention: false, completedRun: false });
  });

  it('apply merges flags onto sessions, leaving untracked ones unchanged (AC9)', () => {
    const a = make();
    a.recordOutput('busy', 0);
    a.recordOutput('attn', 0);
    a.sweep(WINDOW); // both unfocused -> both attention; then re-busy "busy"
    a.recordOutput('busy', WINDOW + 1);
    const sessions = [
      { id: 'busy' } as Session,
      { id: 'attn' } as Session,
      { id: 'untracked' } as Session,
    ];
    const out = a.apply(sessions);
    expect(out.find((s) => s.id === 'busy')).toMatchObject({ busy: true, needsAttention: false });
    expect(out.find((s) => s.id === 'attn')).toMatchObject({ busy: false, needsAttention: true });
    expect(out.find((s) => s.id === 'untracked')).toMatchObject({
      busy: false,
      needsAttention: false,
    });
  });

  it('completedRun latches on the first busy -> idle and survives later cycles (D15)', () => {
    const a = make();
    expect(a.statusOf('s').completedRun).toBe(false);
    a.recordOutput('s', 0);
    // Still running: nothing has *finished* here yet.
    expect(a.statusOf('s').completedRun).toBe(false);
    a.sweep(WINDOW);
    expect(a.statusOf('s').completedRun).toBe(true);
    // A second run neither clears it nor double-counts it.
    a.recordOutput('s', WINDOW + 1);
    expect(a.statusOf('s').completedRun).toBe(true);
    a.forget('s');
    expect(a.statusOf('s').completedRun).toBe(false);
  });

  it('apply decorates with fields the tracker does not own (lastLine, D6)', () => {
    const a = make();
    const out = a.apply([{ id: 's' } as Session], (id) => ({ lastLine: `tail of ${id}` }));
    expect(out[0]).toMatchObject({ busy: false, lastLine: 'tail of s' });
  });

  it('focus(undefined) clears the focused id without throwing', () => {
    const a = make();
    expect(a.focus(undefined)).toBe(false); // no attention to clear -> no change
  });

  it('switching focus away does not retroactively flag the previously focused session', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.focus('s');
    a.focus('other'); // s is no longer focused, still busy (not swept yet)
    a.sweep(WINDOW); // s goes idle while now-unfocused -> attention
    expect(a.statusOf('s').needsAttention).toBe(true);
  });
});
