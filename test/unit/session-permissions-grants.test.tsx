// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { Grant, PolicyUiState } from '../../src/conduit-mcp/policy-types';
import { SessionActiveGrants } from '../../webview/components/session-permissions-details';

it('shows active grants for the trusted session and launched CLI only', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const grant = (
    id: string,
    who: Grant['who'],
    tool: Grant['tool'],
  ): Grant & { expiring: boolean } => ({
    id,
    who,
    tool,
    on: { kind: 'folder', path: '/p' },
    for: 'until-revoked',
    anchorSessionId: null,
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    lastUsedAt: null,
    state: 'active',
    endedAt: null,
    requestId: null,
    expiring: false,
  });
  const policy: PolicyUiState = {
    editToken: 'v1',
    saveError: null,
    backupWarning: null,
    profiles: [...BUILT_IN_PROFILES],
    assignments: [],
    sessions: {
      s1: {
        profileId: 'worker',
        profileName: 'Worker',
        exceptions: 0,
        source: 'default',
        label: null,
        sourcePoint: { kind: 'default' },
        inheritedPoint: { kind: 'default' },
        inheritedProfileId: 'worker',
        launchedCli: 'claude',
      },
    },
    grants: [
      grant('a', { kind: 'session', sessionId: 's1' }, 'open_session'),
      grant('b', { kind: 'cli', cli: 'claude' }, 'read_screen'),
      grant('c', { kind: 'session', sessionId: 'other' }, 'close_session'),
      grant('d', { kind: 'cli', cli: 'codex' }, 'open_terminal'),
      { ...grant('e', { kind: 'session', sessionId: 's1' }, 'send_input'), state: 'revoked' },
    ],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const revokeGrant = vi.fn(async () => true);
  await act(async () =>
    root.render(
      <SessionActiveGrants
        sessionId="s1"
        policy={policy}
        readOnly={false}
        revokeGrant={revokeGrant}
      />,
    ),
  );
  const grants = document.querySelector('[aria-label="Active grants"]');
  expect(grants?.textContent).toContain('open_session · Folder /p · until-revoked');
  expect(grants?.textContent).toContain('read_screen');
  expect(grants?.textContent).not.toContain('close_session');
  expect(grants?.textContent).not.toContain('open_terminal');
  expect(grants?.textContent).not.toContain('send_input');
  const revoke = grants?.querySelector<HTMLButtonElement>(
    '[aria-label="Revoke open_session grant"]',
  );
  expect(revoke).toBeDefined();
  await act(async () => revoke?.click());
  expect(revokeGrant).toHaveBeenCalledWith('a');
  await act(async () => root.unmount());
  host.remove();
});
