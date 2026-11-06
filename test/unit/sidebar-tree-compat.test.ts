import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildAgentTree } from '../../src/agent-tree';
import { attentionEntries, attentionSessions } from '../../src/attention';
import { sessionIconState } from '../../src/session-icon';
import { advanceAgentRuntime, defaultSidebarUi } from '../../src/sidebar-state';
import type { Session, SessionIconKind } from '../../src/types';
import { SessionGlyph } from '../../webview/icons';

/**
 * Compatibility pins for the Spaces and agent tree change (docs/plans/2026-11-02-sidebar-agent-tree.plan.md
 * S0): old records and legacy consumers keep working.
 */

/** A record as an older app or a hand-edited file has it: no server facts at all. */
const legacy = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  name: id,
  agentId: 'claude',
  home: '/w',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
  ...over,
});

describe('legacy records', () => {
  it('build a tree with neutral facts: no spurious Needs you or Done', () => {
    const sessions = [legacy('a', { needsAttention: true, completedRun: true }), legacy('b')];
    const runtime = advanceAgentRuntime({
      previous: null,
      before: [],
      sessions,
      previousAskSessionIds: new Set(),
      askSessionIds: new Set(),
      viewedTerminalIds: new Set(),
      now: 1,
    });
    const t = buildAgentTree({
      sessions,
      runtime,
      ui: defaultSidebarUi(),
      matchingIds: new Set(['a', 'b']),
      askSessionIds: new Set(),
    });
    expect(t.rows.a.state).toBe('idle');
    expect(runtime.seen).toEqual({ a: 0, b: 0 });
  });

  it('legacy appIcon literals stay valid kinds and every kind has a glyph', () => {
    const kinds: SessionIconKind[] = [
      'claude',
      'powershell',
      'terminal',
      'codex',
      'opencode',
      'cursor',
      'gemini',
      'agent',
    ];
    for (const kind of kinds) {
      const html = renderToStaticMarkup(
        createElement(SessionGlyph, { icon: { type: 'kind', kind } }),
      );
      expect(html, kind).toMatch(/<svg/);
    }
  });
});

describe('legacy consumers ignore the new facts', () => {
  const blockedOnly = legacy('x', { attentionReason: 'blocked' });
  const finished = legacy('y', { needsAttention: true });

  it('sessionIconState, attentionSessions and attentionEntries still read needsAttention', () => {
    expect(sessionIconState(blockedOnly)).toBe('idle');
    expect(sessionIconState(finished)).toBe('attention');
    expect(attentionSessions([blockedOnly, finished]).map((s) => s.id)).toEqual(['y']);
    expect(attentionEntries([blockedOnly, finished], [], new Map(), 0).map((e) => e.key)).toEqual([
      'session:y',
    ]);
  });
});
