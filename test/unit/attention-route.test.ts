import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AttentionEntry } from '../../src/attention';
import { activateSessionTerminal, routeAttention } from '../../src/attention-route';
import type { Handle } from '../../src/conduit-mcp/types';
import { activeGroupOf, groupActive } from '../../webview/doc-groups';
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

it('App rows select without activating a document; explicit Go to and attention target Terminal', () => {
  const app = readFileSync(join(__dirname, '../../webview/app.tsx'), 'utf8');
  expect(app.includes('onSelect={selectAgent}')).toBe(true);
  const action = app.slice(app.indexOf('const selectAgent ='), app.indexOf('const goToTerminal ='));
  expect(action).toContain('setActiveId(sessionId)');
  expect(action).toContain("setCenterView('editor')");
  expect(action).not.toMatch(/dispatchDocs|requestTerminalFocus|activateSessionTerminal/);
  expect(app).toContain('select: () => goToTerminal(s.id)');
  expect(app).toContain('focusSession: goToTerminal');
});

it('a bare session switch restores both groups and the focused group, including a re-selection', () => {
  let docs = docsReducer(initialDocs, {
    type: 'open',
    kind: 'file',
    path: '/left.ts',
    sessionId: 's1',
  });
  docs = docsReducer(docs, { type: 'splitRight', sessionId: 's1' });
  docs = docsReducer(docs, {
    type: 'open',
    kind: 'file',
    path: '/right.ts',
    sessionId: 's1',
    group: 2,
  });
  const remembered = docs.layouts.s1;
  docs = docsReducer(docs, { type: 'switchSession', sessionId: 's2' });
  docs = docsReducer(docs, { type: 'switchSession', sessionId: 's1' });
  expect(docs.layouts.s1).toBe(remembered);
  expect(groupActive(docs, 's1', 1)).toBe('file:/left.ts');
  expect(groupActive(docs, 's1', 2)).toBe('file:/right.ts');
  expect(activeGroupOf(docs, 's1')).toBe(2);
  expect(docs.activeId).toBe('file:/right.ts');
  expect(docsReducer(docs, { type: 'switchSession', sessionId: 's1' })).toEqual(docs);
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
