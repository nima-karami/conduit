import { describe, expect, it, vi } from 'vitest';
import { THREAD_AGENT_LIMIT } from '../../src/conduit-mcp/types';
import type { McpGateState, McpThreadSummary, McpUiState } from '../../src/conduit-mcp/ui-types';
import type { Session } from '../../src/types';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import {
  composeTargets,
  newMessageCount,
  tabBadge,
  threadAccessibleName,
  visibleThreads,
} from '../../webview/conduit-mcp-view-model';

function thread(o: Partial<McpThreadSummary> = {}): McpThreadSummary {
  return {
    threadId: 't1',
    subject: 'Build fix',
    firstLine: 'the build is red',
    participants: ['claude-1', 'codex-2'],
    topPriority: 'normal',
    lastAt: '2026-10-25T10:00:00.000Z',
    messageCount: 1,
    unreadFor: [],
    paused: false,
    unreadForYou: false,
    ...o,
  };
}

function state(o: Partial<McpUiState> = {}): McpUiState {
  return {
    enabled: true,
    storeError: null,
    loading: false,
    sessions: {},
    threads: [],
    attention: [],
    youUnread: 0,
    youUrgent: 0,
    switchable: [],
    notConnected: {},
    awaitingApproval: [],
    ...o,
  };
}

function session(id: string, name: string): Session {
  return {
    id,
    name,
    agentId: 'claude',
    home: 'G:/work',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
  };
}

const badge = (handle: string) => ({
  handle,
  unread: 0,
  urgent: 0,
  paused: false,
  unavailable: null,
  connected: true,
  gate: 'open' as const,
});

describe('visibleThreads', () => {
  it('unread filter keeps only threads unread for you, newest first', () => {
    const ts = [
      thread({ threadId: 'a', lastAt: '2026-10-25T09:00:00.000Z', unreadForYou: true }),
      thread({ threadId: 'b', lastAt: '2026-10-25T11:00:00.000Z' }),
      thread({ threadId: 'c', lastAt: '2026-10-25T12:00:00.000Z', unreadForYou: true }),
    ];
    expect(visibleThreads(ts, { unreadOnly: true, handle: null }).map((t) => t.threadId)).toEqual([
      'c',
      'a',
    ]);
    expect(visibleThreads(ts, { unreadOnly: false, handle: null }).map((t) => t.threadId)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('handle filter keeps threads with that participant', () => {
    const ts = [
      thread({ threadId: 'a', participants: ['claude-1', 'codex-2'] }),
      thread({ threadId: 'b', participants: ['claude-1', 'you'] }),
    ];
    expect(
      visibleThreads(ts, { unreadOnly: false, handle: 'codex-2' }).map((t) => t.threadId),
    ).toEqual(['a']);
  });
});

describe('threadAccessibleName', () => {
  it('says "unread" and "urgent" in words', () => {
    const name = threadAccessibleName(thread({ unreadForYou: true, topPriority: 'urgent' }));
    expect(name).toContain('Build fix');
    expect(name).toContain('unread');
    expect(name).toContain('urgent');
    expect(threadAccessibleName(thread())).not.toMatch(/unread|urgent/);
  });

  it('takes its words from MCP_STR.a11y, never by lower-casing a visible string', () => {
    const a11y: Record<string, unknown> = MCP_STR.a11y;
    const saved = { unread: a11y.unread, urgent: a11y.urgent };
    a11y.unread = 'NEU';
    a11y.urgent = 'DRINGEND';
    const paused = vi.spyOn(MCP_STR.a11y, 'paused').mockReturnValue('PAUSIERT');
    try {
      const name = threadAccessibleName(
        thread({ unreadForYou: true, topPriority: 'urgent', paused: true }),
      );
      expect(name).toBe('Build fix, claude-1, codex-2, NEU, DRINGEND, PAUSIERT');
      expect(paused).toHaveBeenCalledWith(THREAD_AGENT_LIMIT);
    } finally {
      Object.assign(a11y, saved);
      paused.mockRestore();
    }
  });
});

describe('newMessageCount', () => {
  it('counts only new threads and new unread-for-you messages; the first state is not news', () => {
    const prev = state({
      threads: [
        thread({ threadId: 'a', messageCount: 2, unreadForYou: true }),
        thread({ threadId: 'b', messageCount: 3 }),
      ],
    });
    const next = state({
      threads: [
        thread({ threadId: 'a', messageCount: 4, unreadForYou: true }),
        // Agent-to-agent growth the human isn't addressed in: not announced.
        thread({ threadId: 'b', messageCount: 5 }),
        thread({ threadId: 'c', messageCount: 1 }),
      ],
    });
    expect(newMessageCount(prev, next)).toBe(3);
    expect(newMessageCount(null, next)).toBe(0);
  });
});

describe('tabBadge', () => {
  it('is null at 0 and flags urgent', () => {
    expect(tabBadge(state())).toBeNull();
    expect(tabBadge(state({ youUnread: 2 }))).toEqual({ count: 2, urgent: false });
    expect(tabBadge(state({ youUnread: 2, youUrgent: 1 }))).toEqual({ count: 2, urgent: true });
  });
});

describe('composeTargets', () => {
  it('excludes sessions without a handle and keeps rail order', () => {
    const sessions = [session('s1', 'api'), session('s2', 'shell'), session('s3', 'web')];
    const st = state({ sessions: { s3: badge('codex-2'), s1: badge('claude-1') } });
    expect(composeTargets(sessions, st)).toEqual([
      { handle: 'claude-1', label: 'api' },
      { handle: 'codex-2', label: 'web' },
    ]);
  });
});

describe('MCP_STR', () => {
  it('names the urgent attention reason with the handle', () => {
    expect(MCP_STR.attention['urgent-waiting']('codex-2')).toBe(
      'urgent message waiting for codex-2',
    );
  });

  it('has a gate string for every McpGateState', () => {
    const all: McpGateState[] = [
      'open',
      'pull-only',
      'off',
      'paused',
      'not-running',
      'settling',
      'no-connection',
      'busy',
      'quiet',
      'blocking-prompt',
      'no-empty-input',
      'draft',
      'spacing',
      'no-echo',
    ];
    for (const g of all) expect(MCP_STR.gate[g]).toMatch(/\S/);
    expect(MCP_STR.gate['blocking-prompt']).toBe('Notices held: prompt on screen');
  });

  it('prefixes every unavailable reason', () => {
    for (const s of Object.values(MCP_STR.unavailable)) {
      expect(s.startsWith('Messaging unavailable: ')).toBe(true);
    }
  });
});
