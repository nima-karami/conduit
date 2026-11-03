import { describe, expect, it } from 'vitest';
import type { McpThreadSummary } from '../../src/conduit-mcp/ui-types';
import {
  messageHasParticipantInScope,
  scopeMessageThreads,
  unreadMessagesOutsideScope,
} from '../../src/messages-scope';

const thread = (threadId: string, participants: string[]): McpThreadSummary => ({
  threadId,
  subject: threadId,
  firstLine: '',
  participants,
  topPriority: 'normal',
  lastAt: '2026-11-01T00:00:00.000Z',
  messageCount: 1,
  unreadFor: [],
  paused: false,
  unreadForYou: false,
});

const sessions = [
  { id: 'a', projectId: 'space-a' },
  { id: 'b', projectId: 'space-b' },
  { id: 'c', projectId: undefined },
];
const handlesBySession = { a: 'claude-1', b: 'codex-1', c: 'cursor-1' };
const threads = [
  thread('a', ['you', 'claude-1']),
  thread('b', ['claude-1', 'codex-1']),
  thread('c', ['you', 'cursor-1']),
  thread('orphan', ['you']),
  thread('unknown', ['missing-session-handle']),
];

describe('Messages Space scoping', () => {
  it('All retains every thread; a Space matches any participant session in it', () => {
    expect(
      scopeMessageThreads({ threads, sessions, handlesBySession, selection: { kind: 'all' } }),
    ).toHaveLength(5);
    expect(
      scopeMessageThreads({
        threads,
        sessions,
        handlesBySession,
        selection: { kind: 'space', projectId: 'space-a' },
      }).map((t) => t.threadId),
    ).toEqual(['a', 'b']);
  });

  it('No space matches sessions without a Space; the human never creates a match', () => {
    expect(
      scopeMessageThreads({ threads, sessions, handlesBySession, selection: { kind: 'none' } }).map(
        (t) => t.threadId,
      ),
    ).toEqual(['c']);
    expect(
      messageHasParticipantInScope(['you'], sessions, handlesBySession, { kind: 'none' }),
    ).toBe(false);
    expect(
      messageHasParticipantInScope(['missing-session-handle'], sessions, handlesBySession, {
        kind: 'none',
      }),
    ).toBe(false);
  });

  it('counts unread messages outside the selected Space exactly, including uncapped summaries', () => {
    expect(
      unreadMessagesOutsideScope({
        unreadByThread: [
          { participants: ['claude-1'], count: 2 },
          { participants: ['cursor-1'], count: 3 },
          { participants: ['you'], count: 4 },
        ],
        sessions,
        handlesBySession,
        selection: { kind: 'space', projectId: 'space-a' },
      }),
    ).toBe(7);
    expect(
      unreadMessagesOutsideScope({
        unreadByThread: [{ participants: ['claude-1'], count: 3 }],
        sessions,
        handlesBySession,
        selection: { kind: 'all' },
      }),
    ).toBe(0);
    expect(
      unreadMessagesOutsideScope({
        unreadByThread: [
          { participants: ['claude-1'], count: 1 },
          { participants: ['codex-1'], count: 2 },
          { participants: ['cursor-1'], count: 3 },
          { participants: ['missing-session-handle'], count: 4 },
        ],
        sessions,
        handlesBySession,
        selection: { kind: 'space', projectId: 'space-a' },
        filterHandle: 'claude-1',
      }),
    ).toBe(9);
  });
});
