import { describe, expect, it } from 'vitest';
import {
  ATTENTION_QUIET_MS,
  MIN_RUN_BYTES,
  MIN_RUN_MS,
  SessionActivity,
  SPAWN_GRACE_MS,
} from '../../src/session-activity';
import type { Session } from '../../src/types';

const WINDOW = 1500;
const make = () => new SessionActivity({ busyWindowMs: WINDOW });

/**
 * A run that qualifies by duration: CONTINUOUS output spanning MIN_RUN_MS from `from`.
 * The writes are 500 ms apart so no gap reaches the busy window — two writes MIN_RUN_MS
 * apart are two separate trivial runs, not one long one.
 */
const runByDuration = (a: SessionActivity, id: string, from: number) => {
  for (let t = 0; t <= MIN_RUN_MS; t += 500) a.recordOutput(id, from + t, 40, 0);
  return from + MIN_RUN_MS;
};

/** The instant a run ending at `lastOutputAt` becomes a quiet edge. */
const quietAfter = (lastOutputAt: number) => lastOutputAt + ATTENTION_QUIET_MS;

describe('SessionActivity — busy meter (unchanged 1500 ms semantics)', () => {
  it('recordOutput marks a session busy (AC1)', () => {
    const a = make();
    expect(a.recordOutput('s', 0, 10, 0)).toBe(true); // idle -> busy is a change
    expect(a.statusOf('s')).toEqual({ busy: true, needsAttention: false, completedRun: false });
  });

  it('recordOutput while already busy reports no change (AC5)', () => {
    const a = make();
    a.recordOutput('s', 0, 10, 0);
    expect(a.recordOutput('s', 100, 10, 0)).toBe(false);
    expect(a.statusOf('s').busy).toBe(true);
  });

  it('sweep before the busy window elapses keeps busy and reports no change (AC7)', () => {
    const a = make();
    a.recordOutput('s', 0, 10, 0);
    const r = a.sweep(WINDOW - 1);
    expect(r.changed).toBe(false);
    expect(r.edges).toEqual([]);
    expect(a.statusOf('s').busy).toBe(true);
  });

  it('busy clears at the busy window even for a trivial, non-qualifying run', () => {
    const a = make();
    a.recordOutput('s', 0, 10, 0);
    const r = a.sweep(WINDOW);
    expect(r.changed).toBe(true);
    expect(a.statusOf('s')).toEqual({ busy: false, needsAttention: false, completedRun: true });
  });

  it('forget untracks a session (AC8)', () => {
    const a = make();
    a.recordOutput('s', 0, 10, 0);
    a.forget('s');
    expect(a.statusOf('s')).toEqual({ busy: false, needsAttention: false, completedRun: false });
  });

  it('apply merges flags onto sessions, leaving untracked ones unchanged (AC9)', () => {
    const a = make();
    a.recordOutput('busy', 0, 10, 0);
    const endA = runByDuration(a, 'attn', 0);
    a.sweep(quietAfter(endA)); // 'attn' qualified + quiet -> attention
    a.recordOutput('busy', quietAfter(endA), 10, 0); // 'busy' is producing again
    const sessions = [
      { id: 'busy' } as Session,
      { id: 'attn' } as Session,
      { id: 'untracked' } as Session,
    ];
    const out = a.apply(sessions);
    expect(out.find((s) => s.id === 'busy')).toMatchObject({ busy: true });
    expect(out.find((s) => s.id === 'attn')).toMatchObject({ busy: false, needsAttention: true });
    expect(out.find((s) => s.id === 'untracked')).toMatchObject({
      busy: false,
      needsAttention: false,
    });
  });

  it('completedRun latches on the first busy -> idle and survives later cycles (D15)', () => {
    const a = make();
    expect(a.statusOf('s').completedRun).toBe(false);
    a.recordOutput('s', 0, 10, 0);
    expect(a.statusOf('s').completedRun).toBe(false);
    a.sweep(WINDOW);
    expect(a.statusOf('s').completedRun).toBe(true);
    a.recordOutput('s', WINDOW + 1, 10, 0);
    expect(a.statusOf('s').completedRun).toBe(true);
    a.forget('s');
    expect(a.statusOf('s').completedRun).toBe(false);
  });

  it('apply decorates with fields the tracker does not own (lastLine, D6)', () => {
    const a = make();
    const out = a.apply([{ id: 's' } as Session], (id) => ({ lastLine: `tail of ${id}` }));
    expect(out[0]).toMatchObject({ busy: false, lastLine: 'tail of s' });
  });
});

describe('SessionActivity — attention arming (spec contract 1-6)', () => {
  it('exports the tuning constants', () => {
    expect(MIN_RUN_MS).toBe(2000);
    expect(MIN_RUN_BYTES).toBe(1024);
    expect(ATTENTION_QUIET_MS).toBe(4000);
    expect(SPAWN_GRACE_MS).toBe(5000);
  });

  it('a spinner (small write every 300 ms, forever) never arms', () => {
    const a = make();
    let t = 0;
    for (let i = 0; i < 40; i += 1) {
      a.recordOutput('s', t, 12, 0);
      expect(a.sweep(t + 150).edges).toEqual([]);
      t += 300;
    }
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('a run qualifying by DURATION arms once after the attention quiet gap', () => {
    const a = make();
    const end = runByDuration(a, 's', 0);
    // Busy has already cleared, but attention waits the longer quiet window (hysteresis).
    expect(a.sweep(end + WINDOW).edges).toEqual([]);
    expect(a.statusOf('s').needsAttention).toBe(false);
    const armed = a.sweep(quietAfter(end));
    expect(armed.edges).toEqual([{ id: 's', kind: 'run-end' }]);
    expect(armed.changed).toBe(true);
    expect(a.statusOf('s').needsAttention).toBe(true);
  });

  it('a run qualifying by BYTES arms even when it lasted under MIN_RUN_MS', () => {
    const a = make();
    a.recordOutput('s', 0, MIN_RUN_BYTES, 0);
    a.recordOutput('s', 200, 8, 0);
    expect(a.sweep(quietAfter(200)).edges).toEqual([{ id: 's', kind: 'run-end' }]);
  });

  it('two trivial bursts separated by an idle gap do not merge into one long run', () => {
    const a = make();
    a.recordOutput('s', 0, 200, 0);
    a.sweep(WINDOW); // goes idle: the run is over
    a.recordOutput('s', 600_000, 200, 0); // ten minutes later, unrelated
    expect(a.sweep(quietAfter(600_000)).edges).toEqual([]);
  });

  it('bytes do not accumulate across an idle gap either', () => {
    const a = make();
    // Two bursts of 600 bytes: 1200 together, but neither run reaches MIN_RUN_BYTES.
    a.recordOutput('s', 0, 600, 0);
    a.recordOutput('s', WINDOW + 1, 600, 0);
    expect(a.sweep(quietAfter(WINDOW + 1)).edges).toEqual([]);
  });

  it('output within the busy window keeps ONE run going (the boundary is the busy window)', () => {
    const a = make();
    a.recordOutput('s', 0, 600, 0);
    a.recordOutput('s', WINDOW - 1, 600, 0); // no idle gap -> same run, 1200 bytes
    expect(a.sweep(quietAfter(WINDOW - 1)).edges).toEqual([{ id: 's', kind: 'run-end' }]);
  });

  it('a qualified run that resumes after an idle gap loses its stale qualification', () => {
    const a = make();
    const end = runByDuration(a, 's', 0); // qualified, but never swept to a quiet edge
    a.sweep(end + WINDOW); // busy -> idle; still short of the attention quiet gap
    a.recordOutput('s', end + 30_000, 40, 0); // a lone repaint much later
    expect(a.sweep(quietAfter(end + 30_000)).edges).toEqual([]);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('a short, small run never arms no matter how long it stays quiet', () => {
    const a = make();
    a.recordOutput('s', 0, 40, 0);
    a.recordOutput('s', 300, 40, 0);
    expect(a.sweep(quietAfter(300)).edges).toEqual([]);
    expect(a.sweep(300 + 60_000).edges).toEqual([]);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('a second quiet cycle without acknowledgment does NOT re-fire (episode latch)', () => {
    const a = make();
    const end = runByDuration(a, 's', 0);
    expect(a.sweep(quietAfter(end)).edges).toHaveLength(1);
    // A repainting TUI dribbles once, goes quiet again: the episode is still open.
    a.recordOutput('s', quietAfter(end) + 100, 20, 0);
    expect(a.sweep(quietAfter(end) + 100 + ATTENTION_QUIET_MS).edges).toEqual([]);
    // Even a fresh QUALIFYING run cannot re-fire an unacknowledged episode.
    const end2 = runByDuration(a, 's', quietAfter(end) + 20_000);
    expect(a.sweep(quietAfter(end2)).edges).toEqual([]);
    expect(a.statusOf('s').needsAttention).toBe(true); // still waiting, still flagged
  });

  it('output alone never clears an armed session — only visibility does', () => {
    const a = make();
    const end = runByDuration(a, 's', 0);
    a.sweep(quietAfter(end));
    expect(a.statusOf('s').needsAttention).toBe(true);
    a.recordOutput('s', quietAfter(end) + 10, 4000, 0);
    expect(a.statusOf('s').needsAttention).toBe(true);
    a.setVisible(1, ['s']);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('acknowledgment then a small repaint does not re-arm (CC idle statusline)', () => {
    const a = make();
    const end = runByDuration(a, 's', 0);
    a.sweep(quietAfter(end));
    expect(a.setVisible(1, ['s'])).toBe(true); // user looks -> acknowledged
    expect(a.statusOf('s').needsAttention).toBe(false);
    a.setVisible(1, []); // user switches away again
    a.recordOutput('s', 30_000, 20, 0);
    expect(a.sweep(quietAfter(30_000)).edges).toEqual([]);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('after acknowledgment a NEW qualifying run arms a fresh episode', () => {
    const a = make();
    const end = runByDuration(a, 's', 0);
    a.sweep(quietAfter(end));
    a.setVisible(1, ['s']);
    a.setVisible(1, []);
    const end2 = runByDuration(a, 's', 30_000);
    expect(a.sweep(quietAfter(end2)).edges).toEqual([{ id: 's', kind: 'run-end' }]);
  });

  it('a bare bell arms immediately, with no quiet wait', () => {
    const a = make();
    a.recordOutput('s', 0, 12, 1);
    const r = a.sweep(10);
    expect(r.edges).toEqual([{ id: 's', kind: 'bell' }]);
    expect(a.statusOf('s')).toMatchObject({ busy: true, needsAttention: true });
  });

  it('a bell fires once per episode', () => {
    const a = make();
    a.recordOutput('s', 0, 12, 1);
    expect(a.sweep(10).edges).toHaveLength(1);
    a.recordOutput('s', 100, 12, 1);
    expect(a.sweep(110).edges).toEqual([]);
  });

  it('a bell on a VISIBLE session never arms and is consumed by that visibility', () => {
    const a = make();
    a.setVisible(1, ['s']);
    a.recordOutput('s', 0, 12, 1);
    expect(a.sweep(10).edges).toEqual([]);
    expect(a.statusOf('s').needsAttention).toBe(false);
    // Switching away must not deliver the swallowed bell late.
    a.setVisible(1, []);
    expect(a.sweep(2000).edges).toEqual([]);
  });
});

describe('SessionActivity — visible sets (contract 4)', () => {
  it('a visible session never arms on a qualifying run', () => {
    const a = make();
    a.setVisible(1, ['s']);
    const end = runByDuration(a, 's', 0);
    expect(a.sweep(quietAfter(end)).edges).toEqual([]);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('two windows each watching their own session: neither arms', () => {
    const a = make();
    a.setVisible(1, ['a']);
    a.setVisible(2, ['b']);
    const endA = runByDuration(a, 'a', 0);
    const endB = runByDuration(a, 'b', 0);
    expect(a.sweep(quietAfter(Math.max(endA, endB))).edges).toEqual([]);
  });

  it('a split-pane session counts as visible (active + split are both reported)', () => {
    const a = make();
    a.setVisible(1, ['active', 'split']);
    const end = runByDuration(a, 'split', 0);
    expect(a.sweep(quietAfter(end)).edges).toEqual([]);
  });

  it('a session visible in ANY window is exempt, even when another window reports it hidden', () => {
    const a = make();
    a.setVisible(1, ['s']);
    a.setVisible(2, ['other']);
    const end = runByDuration(a, 's', 0);
    expect(a.sweep(quietAfter(end)).edges).toEqual([]);
  });

  it('dropWindow un-exempts the sessions that window was showing', () => {
    const a = make();
    a.setVisible(1, ['s']);
    a.dropWindow(1);
    const end = runByDuration(a, 's', 0);
    expect(a.sweep(quietAfter(end)).edges).toEqual([{ id: 's', kind: 'run-end' }]);
  });

  it('visibility while a run is in flight resets it, so switching away does not arm late', () => {
    const a = make();
    a.recordOutput('s', 0, 40, 0);
    a.recordOutput('s', 500, 40, 0);
    a.setVisible(1, ['s']); // the user opens the session mid-run
    for (let t = 1000; t <= MIN_RUN_MS; t += 500) a.recordOutput('s', t, 40, 0);
    a.sweep(MIN_RUN_MS + 100);
    a.setVisible(1, []); // ...and switches away again
    expect(a.sweep(quietAfter(MIN_RUN_MS)).edges).toEqual([]);
  });
});

describe('SessionActivity — spawn grace and exit (contracts 5 and 6)', () => {
  it('output inside the spawn grace is never evidence (banners, relaunch bursts)', () => {
    const a = make();
    a.recordSpawn('s', 0);
    a.recordOutput('s', 50, 4096, 0); // a fat MOTD banner
    a.recordOutput('s', 900, 200, 0);
    expect(a.sweep(quietAfter(900)).edges).toEqual([]);
    expect(a.sweep(60_000).edges).toEqual([]);
  });

  it('a bell inside the spawn grace is swallowed', () => {
    const a = make();
    a.recordSpawn('s', 0);
    a.recordOutput('s', 100, 12, 1);
    expect(a.sweep(200).edges).toEqual([]);
    expect(a.sweep(SPAWN_GRACE_MS + 1000).edges).toEqual([]);
  });

  it('a qualifying run after the grace expires arms normally', () => {
    const a = make();
    a.recordSpawn('s', 0);
    a.recordOutput('s', 100, 300, 0); // banner, discarded
    const end = runByDuration(a, 's', SPAWN_GRACE_MS + 1000);
    expect(a.sweep(quietAfter(end)).edges).toEqual([{ id: 's', kind: 'run-end' }]);
  });

  it('recordSpawn resets an open episode (a relaunched session starts clean)', () => {
    const a = make();
    const end = runByDuration(a, 's', 0);
    a.sweep(quietAfter(end));
    expect(a.statusOf('s').needsAttention).toBe(true);
    a.recordSpawn('s', 30_000);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('an exited session never arms, and its pending evidence is dropped', () => {
    const a = make();
    const end = runByDuration(a, 's', 0);
    a.recordExit('s');
    expect(a.sweep(quietAfter(end)).edges).toEqual([]);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('exit clears an already-armed session', () => {
    const a = make();
    const end = runByDuration(a, 's', 0);
    a.sweep(quietAfter(end));
    expect(a.statusOf('s').needsAttention).toBe(true);
    a.recordExit('s');
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('output after an exit cannot arm (no zombie edge)', () => {
    const a = make();
    a.recordSpawn('s', 0);
    const live = SPAWN_GRACE_MS + 100;
    a.recordOutput('s', live, 40, 0);
    a.recordExit('s');
    a.recordOutput('s', live + 100, 4096, 1); // a dying gasp, bell and all
    expect(a.sweep(quietAfter(live + 100)).edges).toEqual([]);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('recordExit after forget does not resurrect the entry', () => {
    // pty.dispose kills the child, so its onExit lands AFTER disposeSession's forget().
    // Re-creating an entry there would leak a row swept every 750 ms for the app's life.
    const a = make();
    a.recordOutput('s', 0, 40, 0);
    a.forget('s');
    a.recordExit('s');
    expect(a.apply([{ id: 's' } as Session])).toEqual([
      { id: 's', busy: false, needsAttention: false, completedRun: false },
    ]);
    expect(a.trackedCount()).toBe(0);
  });

  it('a spawn after an exit makes the session eligible again', () => {
    const a = make();
    a.recordExit('s');
    a.recordSpawn('s', 0);
    const end = runByDuration(a, 's', SPAWN_GRACE_MS + 100);
    expect(a.sweep(quietAfter(end)).edges).toEqual([{ id: 's', kind: 'run-end' }]);
  });
});
