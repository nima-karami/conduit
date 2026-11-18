// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { OwnerPermissionView } from '../../src/conduit-mcp/request-types';
import { PermissionsRequestBody } from '../../webview/components/permissions-request-body';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
const request: OwnerPermissionView = {
  id: 'r1',
  sessionId: 's1',
  requester: 'codex-1',
  space: null,
  lead: null,
  machine: 'local',
  title: 'Close a session',
  tool: 'close_session',
  why: 'Worker asks',
  state: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  endedAt: null,
  withdrawReason: null,
  grantable: true,
  answerable: true,
  choices: [
    { who: 'session', on: 'target', for: 'session-end' },
    { who: 'session', on: 'target', for: '1h' },
  ],
};

describe('permission request body', () => {
  it('creates only the selected grant and prevents duplicate submissions', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    let finish: () => void = () => {};
    const answer = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = () => resolve({ ok: true });
        }),
    );
    await act(async () =>
      root.render(<PermissionsRequestBody kind="local" request={request} answer={answer} />),
    );
    const button = (label: string) =>
      [...el.querySelectorAll('button')].find((b) => b.textContent === label);
    act(() => button('Allow…')?.click());
    act(() => {
      button('Allow')?.click();
      button('Allow')?.click();
    });
    expect(answer).toHaveBeenCalledOnce();
    expect(answer).toHaveBeenCalledWith('r1', { outcome: 'allowed', grant: request.choices[0] });
    await act(async () => finish());
    await act(async () => root.unmount());
    el.remove();
  });
  it('offers only a next-time grant after expiry', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () =>
      root.render(
        <PermissionsRequestBody
          kind="local"
          request={{ ...request, state: 'expired' }}
          answer={vi.fn(async () => ({ ok: true as const }))}
        />,
      ),
    );
    expect(el.textContent).toContain('agent must retry');
    expect(el.textContent).toContain('Allow next time');
    expect(el.textContent).not.toContain('Allow once');
    await act(async () => root.unmount());
    el.remove();
  });
});
