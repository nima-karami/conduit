import { describe, expect, it } from 'vitest';
import {
  CURSOR_CLIENT_NAMES,
  clientKindOf,
  initializeClientName,
  noticeAdapterIdOf,
  pickNoticeAdapterId,
} from '../../src/conduit-mcp/client-info';

const E2E = { e2e: true };
const PROD = { e2e: false };

describe('client-info', () => {
  it('known names map to kinds; unknown → agent; non-string → agent', () => {
    expect(clientKindOf('claude-code', PROD)).toBe('claude');
    expect(clientKindOf('codex-mcp-client', PROD)).toBe('codex');
    expect(clientKindOf('opencode', PROD)).toBe('opencode');
    for (const name of CURSOR_CLIENT_NAMES) expect(clientKindOf(name, PROD)).toBe('cursor');
    expect(clientKindOf('Claude-Code', PROD)).toBe('agent');
    expect(clientKindOf('claude-code ', PROD)).toBe('agent');
    expect(clientKindOf('vscode', PROD)).toBe('agent');
    expect(clientKindOf('', PROD)).toBe('agent');
    for (const v of [undefined, null, 3, {}, ['claude-code']]) {
      expect(clientKindOf(v, PROD)).toBe('agent');
    }
  });

  it('Cursor names its MCP client "Cursor" (S0, docs/runs/2026-10-27-mcp-install/s0.md)', () => {
    expect(CURSOR_CLIENT_NAMES).toEqual(['Cursor']);
    expect(clientKindOf('Cursor', PROD)).toBe('cursor');
    expect(clientKindOf('cursor', PROD)).toBe('agent');
  });

  it('conduit-e2e-fake → fake only with e2e', () => {
    expect(clientKindOf('conduit-e2e-fake', E2E)).toBe('fake');
    expect(clientKindOf('conduit-e2e-fake', PROD)).toBe('agent');
  });

  it('noticeAdapterIdOf: opencode and agent are pull-only', () => {
    expect(noticeAdapterIdOf('claude')).toBe('claude');
    expect(noticeAdapterIdOf('codex')).toBe('codex');
    expect(noticeAdapterIdOf('cursor')).toBe('cursor');
    expect(noticeAdapterIdOf('fake')).toBe('fake');
    expect(noticeAdapterIdOf('opencode')).toBeNull();
    expect(noticeAdapterIdOf('agent')).toBeNull();
  });

  it('pickNoticeAdapterId: definition wins; else newest live with an adapter; none → null', () => {
    expect(pickNoticeAdapterId('codex', ['claude'])).toBe('codex');
    expect(pickNoticeAdapterId(undefined, ['opencode', 'codex'])).toBe('codex');
    expect(pickNoticeAdapterId(undefined, ['claude', 'codex'])).toBe('codex');
    expect(pickNoticeAdapterId(undefined, [])).toBeNull();
    expect(pickNoticeAdapterId(undefined, ['opencode', 'agent'])).toBeNull();
  });

  it('pickNoticeAdapterId: claude connected, then an unmapped client connects → still claude', () => {
    expect(pickNoticeAdapterId(undefined, ['claude', 'agent'])).toBe('claude');
    expect(pickNoticeAdapterId(undefined, ['claude', 'opencode'])).toBe('claude');
    expect(pickNoticeAdapterId(undefined, ['codex', 'claude', 'agent', 'opencode'])).toBe('claude');
  });

  it('initializeClientName: name, null without clientInfo, undefined for tools/list, a notification and non-JSON', () => {
    const init = (params: unknown) =>
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
    expect(initializeClientName(init({ clientInfo: { name: 'claude-code', version: '2' } }))).toBe(
      'claude-code',
    );
    expect(initializeClientName(init({ protocolVersion: '2025-06-18' }))).toBeNull();
    expect(initializeClientName(init(undefined))).toBeNull();
    expect(initializeClientName(init({ clientInfo: { name: 7 } }))).toBeNull();
    expect(initializeClientName(init({ clientInfo: 'x' }))).toBeNull();
    expect(
      initializeClientName(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'initialize' })),
    ).toBeNull();
    expect(
      initializeClientName(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })),
    ).toBeUndefined();
    expect(
      initializeClientName(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: { clientInfo: { name: 'x' } },
        }),
      ),
    ).toBeUndefined();
    expect(
      initializeClientName(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
    ).toBeUndefined();
    expect(initializeClientName('not json')).toBeUndefined();
    expect(initializeClientName('[]')).toBeUndefined();
    expect(initializeClientName('null')).toBeUndefined();
  });
});
