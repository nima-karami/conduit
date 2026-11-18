// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Grant, PolicyUiState } from '../../src/conduit-mcp/policy-types';
import { PermissionsGrants } from '../../webview/components/permissions-grants';

it('uses current revisions and tokens, displays errors, and offers opaque undo after revoke', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const grant: Grant & { expiring: boolean } = {
    id: 'g1',
    who: { kind: 'session', sessionId: 's1' },
    tool: 'read_screen',
    on: { kind: 'folder', path: '/work' },
    for: '1h',
    anchorSessionId: null,
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    lastUsedAt: null,
    state: 'active',
    endedAt: null,
    requestId: 'r1',
    lifecycleRevision: 3,
    useCount: 2,
    expiring: true,
  };
  const policy: PolicyUiState = {
    editToken: 'current',
    saveError: null,
    backupWarning: null,
    profiles: [],
    assignments: [],
    sessions: {},
    grants: [grant, { ...grant, id: 'g2', tool: 'open_session', state: 'expired' }],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
  };
  const action = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: 'save-failed' })
    .mockResolvedValueOnce({ ok: true, undoToken: 'opaque' })
    .mockResolvedValueOnce({ ok: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<PermissionsGrants policy={policy} grantLifecycle={action} />));
  expect(host.textContent).toContain('Folder /work');
  expect(host.textContent).toContain('2 uses');
  const button = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  expect(button('Renew open_session grant')).toBeTruthy();
  await act(async () => button('Extend read_screen grant by one hour').click());
  expect(action).toHaveBeenCalledWith({
    kind: 'extend',
    id: 'g1',
    revision: 3,
    expectedToken: 'current',
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('save-failed');
  await act(async () => button('Revoke read_screen grant').click());
  const undo = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Undo')!;
  expect(document.activeElement).toBe(undo);
  await act(async () => undo.click());
  expect(action).toHaveBeenLastCalledWith({ kind: 'undo', token: 'opaque' });
  expect(host.textContent).not.toContain('Grant revoked.');
  await act(async () => root.unmount());
  host.remove();
});
