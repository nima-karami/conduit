// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, expect, it, vi } from 'vitest';
import { PermissionsUpgradeDialog } from '../../webview/components/permissions-upgrade-dialog';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it('labels resolved global differences without claiming explicit choices', async () => {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <PermissionsUpgradeDialog
        migration={{
          migratedFrom: 'v0.64',
          acknowledged: false,
          offeredSessionIds: [],
          summary: [
            {
              point: { kind: 'default' },
              provenance: 'resolved-global',
              fields: [{ tool: 'send_input', field: 'access', value: 'off' }],
              profileId: 'worker',
              exceptions: 1,
              onScreenOnly: false,
            },
          ],
        }}
        editToken="v1"
        acknowledge={vi.fn(async () => ({ ok: true as const }))}
        sessions={{}}
        onReview={vi.fn()}
        onReviewSession={vi.fn()}
        onDone={vi.fn()}
      />,
    ),
  );
  expect(document.body.textContent).toContain('Resolved global settings: send_input access off');
  await act(async () => root.unmount());
  el.remove();
});
