// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SessionPermissionsNative } from '../../webview/components/session-permissions-native';

it('shows the specific typed native refusal and its settings action only for native failures', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onOpenSettings = vi.fn();
  const props = {
    native: { atLaunch: null, next: { status: 'unavailable' as const } },
    posture: { status: 'unavailable' as const },
    handStarted: false,
    onOpenSettings,
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
  const button = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === 'Open in MCP › Agents',
  );
  await act(async () => button?.click());
  expect(onOpenSettings).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  host.remove();
});
