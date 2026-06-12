import { describe, expect, it } from 'vitest';
import { dotClass, dotState, dotTitle } from '../../src/session-dot';
import type { Session } from '../../src/types';

const sess = (over: Partial<Session>): Session => ({
  id: 's1',
  name: 'S1',
  agentId: 'a1',
  projectPath: '/p',
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  ...over,
});

describe('dotState', () => {
  it('running + quiet -> a single vibrant running dot', () => {
    expect(dotState(sess({ status: 'running' }))).toEqual({
      tone: 'running',
      vibrant: true,
      pulse: false,
    });
  });

  it('running + busy -> a single vibrant pulsing busy dot', () => {
    expect(dotState(sess({ status: 'running', busy: true }))).toEqual({
      tone: 'busy',
      vibrant: true,
      pulse: true,
    });
  });

  it('running + needsAttention -> a single vibrant attention dot', () => {
    expect(dotState(sess({ status: 'running', needsAttention: true }))).toEqual({
      tone: 'attention',
      vibrant: true,
      pulse: false,
    });
  });

  it('needsAttention outranks busy (attention wins) — still ONE dot', () => {
    expect(dotState(sess({ status: 'running', busy: true, needsAttention: true })).tone).toBe(
      'attention',
    );
  });

  it('exited -> off (dimmed), regardless of stale runtime flags', () => {
    expect(dotState(sess({ status: 'exited' }))).toEqual({
      tone: 'off',
      vibrant: false,
      pulse: false,
    });
    // A leftover busy/attention flag on a dead session must NOT light the dot.
    expect(dotState(sess({ status: 'exited', busy: true, needsAttention: true })).vibrant).toBe(
      false,
    );
  });

  it('stale -> off (dimmed)', () => {
    expect(dotState(sess({ status: 'stale' })).tone).toBe('off');
    expect(dotState(sess({ status: 'stale', busy: true })).vibrant).toBe(false);
  });

  it('every status produces exactly one well-formed dot (never two)', () => {
    for (const status of ['running', 'exited', 'stale'] as const) {
      for (const busy of [false, true]) {
        for (const needsAttention of [false, true]) {
          const st = dotState(sess({ status, busy, needsAttention }));
          // A single tone string is always returned — one dot, never a pair.
          expect(['attention', 'busy', 'running', 'off']).toContain(st.tone);
          // vibrant iff the session is active (running, in any activity sub-state).
          expect(st.vibrant).toBe(status === 'running');
        }
      }
    }
  });
});

describe('dotClass', () => {
  it('renders a single `.dot` plus exactly one tone modifier', () => {
    expect(dotClass(dotState(sess({ status: 'running' })))).toBe('dot dot--running');
    expect(dotClass(dotState(sess({ status: 'exited' })))).toBe('dot dot--off');
    expect(dotClass(dotState(sess({ status: 'running', needsAttention: true })))).toBe(
      'dot dot--attention',
    );
  });

  it('adds the pulse modifier only when busy', () => {
    expect(dotClass(dotState(sess({ status: 'running', busy: true })))).toBe(
      'dot dot--busy dot--pulse',
    );
    expect(dotClass(dotState(sess({ status: 'running' })))).not.toContain('dot--pulse');
  });
});

describe('dotTitle', () => {
  it('gives a hover label for active tones and none when off', () => {
    expect(dotTitle(dotState(sess({ status: 'running', needsAttention: true })))).toBe(
      'Finished — needs attention',
    );
    expect(dotTitle(dotState(sess({ status: 'running', busy: true })))).toBe('Busy');
    expect(dotTitle(dotState(sess({ status: 'running' })))).toBe('Running');
    expect(dotTitle(dotState(sess({ status: 'exited' })))).toBeUndefined();
  });
});
