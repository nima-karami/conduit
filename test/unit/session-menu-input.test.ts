import { describe, expect, it } from 'vitest';
import type { Handle } from '../../src/conduit-mcp/types';
import type { McpNotConnected, McpSessionBadge } from '../../src/conduit-mcp/ui-types';
import { sessionMcpLink, sessionSnoozeInput } from '../../webview/session-menu-input';

const NOW = 1_000_000;

describe('sessionSnoozeInput', () => {
  it('is snoozable only with a reason or a pending ask', () => {
    expect(sessionSnoozeInput({ id: 'a', attentionReason: null }, false, new Map(), NOW)).toEqual({
      snoozable: false,
      snoozedUntil: undefined,
      now: NOW,
    });
    expect(sessionSnoozeInput({ id: 'a' }, false, new Map(), NOW).snoozable).toBe(false);
    expect(
      sessionSnoozeInput({ id: 'a', attentionReason: 'needs-input' }, false, new Map(), NOW)
        .snoozable,
    ).toBe(true);
    expect(
      sessionSnoozeInput({ id: 'a', attentionReason: null }, true, new Map(), NOW).snoozable,
    ).toBe(true);
  });

  it('reports a snooze end only while it is in the future', () => {
    const s = { id: 'a', attentionReason: 'done' };
    expect(sessionSnoozeInput(s, false, new Map([['a', NOW + 60_000]]), NOW).snoozedUntil).toBe(
      NOW + 60_000,
    );
    expect(sessionSnoozeInput(s, false, new Map([['a', NOW]]), NOW).snoozedUntil).toBeUndefined();
    expect(
      sessionSnoozeInput(s, false, new Map([['b', NOW + 60_000]]), NOW).snoozedUntil,
    ).toBeUndefined();
  });
});

describe('sessionMcpLink', () => {
  const badge = (over: Partial<McpSessionBadge>): McpSessionBadge => ({
    handle: 'h1' as Handle,
    unread: 0,
    urgent: 0,
    paused: false,
    unavailable: null,
    connected: true,
    gate: null,
    ...over,
  });
  const nc = { cli: 'cursor', install: 'installed', launch: 1 } as McpNotConnected;

  it('is null while messaging is off', () => {
    expect(sessionMcpLink(badge({ unavailable: 'endpoint-down' }), undefined, false)).toBeNull();
  });

  it('names an unavailable reason the card warns with', () => {
    expect(sessionMcpLink(badge({ unavailable: 'endpoint-down' }), undefined, true)).toEqual({
      kind: 'unavailable',
      reason: 'endpoint-down',
    });
  });

  it("carries Cursor's reason through its not-connected status", () => {
    expect(sessionMcpLink(badge({ unavailable: 'cursor-not-connected' }), nc, true)).toEqual({
      kind: 'not-connected',
      cli: 'cursor',
      install: 'installed',
    });
  });

  it('is the connected status otherwise', () => {
    expect(sessionMcpLink(badge({}), undefined, true)).toEqual({
      kind: 'connected',
      handle: 'h1',
    });
  });
});
