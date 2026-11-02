import { describe, expect, it, vi } from 'vitest';
import type { AttentionEntry } from '../../src/attention';
import { activateSessionTerminal, routeAttention } from '../../src/attention-route';
import type { Handle } from '../../src/conduit-mcp/types';
import { groupActive } from '../../webview/doc-groups';
import { docsReducer, initialDocs } from '../../webview/docs';

const entry = (over: Partial<AttentionEntry>): AttentionEntry => ({
  key: 'k',
  kind: 'session',
  sessionId: null,
  threadId: null,
  reason: null,
  handle: null,
  ...over,
});

function routes() {
  return { focusAsk: vi.fn(), openThread: vi.fn(), focusSession: vi.fn() };
}

it('Go to shows the workspace and Terminal even for the already selected agent, then focuses', () => {
  for (const initial of ['board', 'canvas', 'editor']) {
    for (const target of ['s1', 's2']) {
      let active = 's1';
      let center = initial;
      let docs = docsReducer(initialDocs, {
        type: 'open',
        kind: 'file',
        path: '/s1.ts',
        sessionId: 's1',
      });
      docs = docsReducer(docs, { type: 'open', kind: 'file', path: '/s2.ts', sessionId: 's2' });
      let focus: (() => void) | undefined;
      const focused: string[] = [];
      activateSessionTerminal(target, {
        select: (id) => {
          active = id;
        },
        showWorkspace: () => {
          center = 'editor';
        },
        activateTerminal: (id) => {
          docs = docsReducer(docs, { type: 'activate', id: null, sessionId: id, group: 1 });
        },
        afterVisible: (fn) => {
          focus = fn;
        },
        focus: (id) => {
          focused.push(id);
        },
      });
      expect([active, center, groupActive(docs, target, 1)]).toEqual([target, 'editor', null]);
      expect(docs.docs).toHaveLength(2);
      expect(focused).toEqual([]);
      expect(focus).toBeTypeOf('function');
      focus?.();
      expect(focused).toEqual([target]);
    }
  }
});

// Ported from the removed header chip's test (tool-policy spec §2.4; review r1-S2 C5).
describe('routeAttention', () => {
  it("an ask focuses the approval card, not the caller's session", () => {
    const to = routes();
    routeAttention(entry({ kind: 'ask', sessionId: 's1', handle: 'claude-1' as Handle }), to);
    expect(to.focusAsk).toHaveBeenCalledTimes(1);
    expect(to.focusSession).not.toHaveBeenCalled();
    expect(to.openThread).not.toHaveBeenCalled();
  });

  it('a message opens its thread', () => {
    const to = routes();
    routeAttention(entry({ kind: 'message', sessionId: 's1', threadId: 't1' }), to);
    expect(to.openThread).toHaveBeenCalledWith('t1');
    expect(to.focusSession).not.toHaveBeenCalled();
  });

  it('a session entry selects the session', () => {
    const to = routes();
    routeAttention(entry({ kind: 'session', sessionId: 's2' }), to);
    expect(to.focusSession).toHaveBeenCalledWith('s2');
    expect(to.focusAsk).not.toHaveBeenCalled();
  });

  it('a message without a thread falls back to its session', () => {
    const to = routes();
    routeAttention(entry({ kind: 'message', sessionId: 's3' }), to);
    expect(to.focusSession).toHaveBeenCalledWith('s3');
    expect(to.openThread).not.toHaveBeenCalled();
  });
});
