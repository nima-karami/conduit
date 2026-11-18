// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PolicyDecision, PreviewResult } from '../../src/conduit-mcp/policy-types';
import { PermissionsCheckRequest } from '../../webview/components/permissions-check-request';

it('checks the selected exact target and full draft, and labels policy-only results', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const decision: PolicyDecision = {
    decision: 'allow',
    reason: { by: 'profile', point: { kind: 'default' }, profileId: 'worker' },
    rule: { when: null, reach: null, move: null },
    grantId: null,
    grantIds: [],
    overrideId: null,
    overrideIds: [],
    deniedTarget: null,
    forcedAsk: false,
  };
  const previewPolicy = vi.fn(
    async (): Promise<PreviewResult | null> => ({
      ok: true,
      decision,
      editToken: 'v1',
      runtime: 'unevaluated',
    }),
  );
  const draft = {
    point: { kind: 'default' as const },
    assignment: { profileId: 'lead' as const, exceptions: [], onScreenOnly: false },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PermissionsCheckRequest
        sessions={[
          { id: 's1', label: 'First' },
          { id: 's2', label: 'Second' },
        ]}
        draft={draft}
        expectedToken="v1"
        previewPolicy={previewPolicy}
      />,
    ),
  );
  const selects = host.querySelectorAll('select');
  const choose = async (element: HTMLSelectElement, value: string) => {
    await act(async () => {
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  await choose(selects[0], 's1');
  await choose(selects[2], 's2');
  const button = host.querySelector('button');
  await act(async () => button?.click());
  expect(previewPolicy).toHaveBeenCalledWith(
    's1',
    { tool: 'close_session', targetSessionId: 's2' },
    draft,
    'v1',
  );
  expect(host.textContent).toContain('ALLOW');
  expect(host.textContent).toContain('Runtime conditions have not been evaluated');
  await choose(selects[1], 'open_file');
  expect(host.textContent).not.toContain('ALLOW');
  expect(host.textContent).toContain('Absolute file path');
  await act(async () => root.unmount());
  host.remove();
});

it('reports stale policy and ignores an outdated response', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let resolve!: (value: PreviewResult | null) => void;
  const previewPolicy = vi.fn(
    () =>
      new Promise<PreviewResult | null>((done) => {
        resolve = done;
      }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    sessions: [{ id: 's1', label: 'First' }],
    draft: null,
    expectedToken: 'v1',
    previewPolicy,
  };
  await act(async () => root.render(<PermissionsCheckRequest {...props} />));
  const selects = host.querySelectorAll('select');
  for (const select of [selects[0], selects[2]])
    await act(async () => {
      select.value = 's1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  await act(async () => host.querySelector('button')?.click());
  await act(async () => root.render(<PermissionsCheckRequest {...props} expectedToken="v2" />));
  await act(async () => resolve({ ok: false, error: 'conflict' }));
  expect(host.textContent).not.toContain('Policy changed');
  await act(async () => host.querySelector('button')?.click());
  await act(async () => resolve({ ok: false, error: 'conflict' }));
  expect(host.textContent).toContain('Policy changed');
  await act(async () => root.unmount());
  host.remove();
});
