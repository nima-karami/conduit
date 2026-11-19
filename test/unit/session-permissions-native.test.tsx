// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { SessionPermissionsNative } from '../../webview/components/session-permissions-native';

it('shows the specific typed refusal and recovery only for native failures', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    native: { atLaunch: null, next: { status: 'unavailable' as const } },
    posture: { status: 'unavailable' as const },
    handStarted: false,
  };
  await act(async () =>
    root.render(
      <SessionPermissionsNative
        {...props}
        refusal={{ reason: 'unresolvable', command: 'codex' }}
      />,
    ),
  );
  expect(host.textContent).not.toContain('Native launch refused');
  await act(async () =>
    root.render(
      <SessionPermissionsNative
        {...props}
        refusal={{ reason: 'native_permissions', problem: 'conflict' }}
      />,
    ),
  );
  expect(host.textContent).toContain('Native flags conflict with launcher arguments');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Remove the conflicting native permission flags from the agent launcher, then retry.',
  );
  await act(async () => root.unmount());
  host.remove();
});
