import { describe, expect, it } from 'vitest';
import {
  type AttentionEvent,
  attentionItemId,
  reduceAttention,
  youAttention,
} from '../../src/conduit-mcp/attention-items';
import type { McpAttentionItem, ThreadSummary } from '../../src/conduit-mcp/types';

const AT = '2026-10-25T12:00:00.000Z';
const H = 'codex-2';

const run = (events: AttentionEvent[], start: McpAttentionItem[] = []) =>
  events.reduce<McpAttentionItem[]>((items, e) => reduceAttention(items, e), start);

const urgent: AttentionEvent = {
  t: 'raise',
  raise: { kind: 'urgent-waiting', handle: H, messageId: 'm_1' },
  sessionId: 's2',
  threadId: 't_1',
  at: AT,
};
const unsent: AttentionEvent = {
  t: 'raise',
  raise: { kind: 'unsent-notice', handle: H },
  sessionId: 's2',
  threadId: null,
  at: AT,
};
const renotice: AttentionEvent = {
  t: 'raise',
  raise: { kind: 'unread-after-renotice', handle: H, messageId: 'm_1' },
  sessionId: 's2',
  threadId: 't_1',
  at: AT,
};
const paused: AttentionEvent = { t: 'thread-limit', threadId: 't_1', handle: 'claude-1', at: AT };

describe('attentionItemId', () => {
  it('is reason:handle:ref', () => {
    expect(attentionItemId('urgent-waiting', H, 'm_1')).toBe('urgent-waiting:codex-2:m_1');
    expect(attentionItemId('unsent-notice', H, null)).toBe('unsent-notice:codex-2:');
  });
});

describe('reduceAttention', () => {
  it('a raise becomes an item', () => {
    expect(run([urgent])).toEqual([
      {
        id: 'urgent-waiting:codex-2:m_1',
        reason: 'urgent-waiting',
        handle: H,
        sessionId: 's2',
        threadId: 't_1',
        messageId: 'm_1',
        at: AT,
      },
    ]);
  });

  it('raise twice → one item', () => {
    expect(run([urgent, { ...urgent, at: 'later' }])).toHaveLength(1);
    expect(run([unsent, unsent])).toHaveLength(1);
  });

  const clearing: Array<[string, AttentionEvent, AttentionEvent, number]> = [
    [
      'urgent-waiting cleared by noticed',
      urgent,
      { t: 'status', messageId: 'm_1', handle: H, status: 'noticed' },
      0,
    ],
    [
      'urgent-waiting cleared by read',
      urgent,
      { t: 'status', messageId: 'm_1', handle: H, status: 'read' },
      0,
    ],
    [
      'urgent-waiting kept by another message',
      urgent,
      { t: 'status', messageId: 'm_2', handle: H, status: 'read' },
      1,
    ],
    [
      'urgent-waiting kept by another handle',
      urgent,
      { t: 'status', messageId: 'm_1', handle: 'x-1', status: 'read' },
      1,
    ],
    ['thread-paused cleared by thread-reset', paused, { t: 'thread-reset', threadId: 't_1' }, 0],
    [
      'thread-paused kept by another thread reset',
      paused,
      { t: 'thread-reset', threadId: 't_2' },
      1,
    ],
    ['unsent-notice cleared by renderer-input', unsent, { t: 'renderer-input', handle: H }, 0],
    ['unsent-notice cleared by notice-submitted', unsent, { t: 'notice-submitted', handle: H }, 0],
    [
      'unsent-notice kept by another handle input',
      unsent,
      { t: 'renderer-input', handle: 'x-1' },
      1,
    ],
    [
      'unread-after-renotice cleared by read',
      renotice,
      { t: 'status', messageId: 'm_1', handle: H, status: 'read' },
      0,
    ],
    [
      'unread-after-renotice kept by noticed',
      renotice,
      { t: 'status', messageId: 'm_1', handle: H, status: 'noticed' },
      1,
    ],
  ];
  it.each(clearing)('%s', (_label, raise, clear, left) => {
    expect(run([raise, clear])).toHaveLength(left);
  });

  it('thread-paused carries the thread and the agent that hit the limit', () => {
    expect(run([paused])[0]).toMatchObject({
      id: 'thread-paused:claude-1:t_1',
      reason: 'thread-paused',
      threadId: 't_1',
      messageId: null,
      sessionId: null,
    });
  });

  it('session-gone drops all for the handle', () => {
    const other: AttentionEvent = {
      ...unsent,
      raise: { kind: 'unsent-notice', handle: 'claude-1' },
    };
    const items = run([urgent, unsent, renotice, other, { t: 'session-gone', handle: H }]);
    expect(items.map((i) => i.handle)).toEqual(['claude-1']);
  });

  it('does not mutate its input', () => {
    const start = run([urgent]);
    const copy = structuredClone(start);
    reduceAttention(start, { t: 'session-gone', handle: H });
    expect(start).toEqual(copy);
  });
});

describe('youAttention', () => {
  const thread = (threadId: string, unreadFor: string[]): ThreadSummary => ({
    threadId,
    subject: '',
    firstLine: '',
    participants: [],
    topPriority: 'normal',
    lastAt: AT,
    messageCount: 1,
    unreadFor,
  });
  it('youAttention: one item per thread with you unread', () => {
    const items = youAttention(
      [thread('t_1', ['you', H]), thread('t_2', [H]), thread('t_3', ['you'])],
      AT,
    );
    expect(items).toEqual([
      {
        id: 'message-to-you:you:t_1',
        reason: 'message-to-you',
        handle: 'you',
        sessionId: null,
        threadId: 't_1',
        messageId: null,
        at: AT,
      },
      expect.objectContaining({ id: 'message-to-you:you:t_3', threadId: 't_3' }),
    ]);
  });
});
