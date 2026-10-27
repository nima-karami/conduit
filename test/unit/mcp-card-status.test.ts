import { describe, expect, it } from 'vitest';
import type { McpNotConnected, McpSessionBadge } from '../../src/conduit-mcp/ui-types';
import { cardMcpStatus } from '../../webview/mcp-card-status';

const badge = (o: Partial<McpSessionBadge> = {}): McpSessionBadge => ({
  handle: 'claude-3',
  unread: 0,
  urgent: 0,
  paused: false,
  unavailable: null,
  connected: true,
  gate: 'open',
  ...o,
});
const nc = (o: Partial<McpNotConnected> = {}): McpNotConnected => ({
  cli: 'codex',
  install: 'not-installed',
  launch: 1,
  reason: 'no-initialize',
  ...o,
});

describe('cardMcpStatus', () => {
  it('disabled → null', () => {
    expect(cardMcpStatus(badge(), nc(), false)).toBeNull();
  });

  it('connected badge → connected', () => {
    expect(cardMcpStatus(badge(), undefined, true)).toEqual({
      kind: 'connected',
      handle: 'claude-3',
    });
  });

  it('a badge that has not connected, with no nc → null', () => {
    expect(cardMcpStatus(badge({ connected: false }), undefined, true)).toBeNull();
    expect(cardMcpStatus(undefined, undefined, true)).toBeNull();
  });

  it('nc → not-connected even with a badge', () => {
    expect(cardMcpStatus(badge(), nc({ install: 'installed' }), true)).toEqual({
      kind: 'not-connected',
      cli: 'codex',
      install: 'installed',
    });
  });

  it('unavailable other than cursor-not-connected → null (the existing warning shows)', () => {
    expect(cardMcpStatus(badge({ unavailable: 'endpoint-down' }), nc(), true)).toBeNull();
    expect(cardMcpStatus(badge({ unavailable: 'endpoint-down' }), undefined, true)).toBeNull();
  });

  it('cursor-not-connected with nc → not-connected', () => {
    expect(
      cardMcpStatus(
        badge({ unavailable: 'cursor-not-connected', connected: false }),
        nc({ cli: 'cursor', reason: 'cursor-not-connected' }),
        true,
      ),
    ).toMatchObject({ kind: 'not-connected', cli: 'cursor' });
  });
});
