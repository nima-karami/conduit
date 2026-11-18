// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { HostToWebview } from '../../src/protocol';
import { getToastsSnapshot } from '../../webview/toast-store';
import { usePermissionRefusals } from '../../webview/use-permission-refusals';

const { listeners } = vi.hoisted(() => ({
  listeners: new Set<(message: HostToWebview) => void>(),
}));
vi.mock('../../webview/bridge', () => ({
  subscribe: (listener: (message: HostToWebview) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

it('drops badges and notices after relaunch and rejects delayed events from the old launch', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const openActivity = vi.fn();
  function Example({ generation }: { generation: number }) {
    const { refusalsBySession, openRefusal } = usePermissionRefusals(
      [
        {
          id: 's1',
          name: 'First',
          runtime: { generation, spawn: 'live', reportedStatus: null, lastSize: null },
        },
      ],
      openActivity,
    );
    const refusal = refusalsBySession['s1'];
    return refusal ? (
      <button type="button" onClick={() => openRefusal('s1', refusal.latest)}>
        {refusal.count} refused
      </button>
    ) : null;
  }

  const at = '2026-11-18T00:00:00.000Z';
  const send = (generation: number, id: string) =>
    act(() => {
      for (const listener of listeners)
        listener({
          type: 'mcp:activityRecorded',
          generation,
          sessionId: 's1',
          id,
          at,
          tool: 'close_session',
          outcome: 'denied',
        });
    });

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(<Example generation={1} />));
  await send(1, 'prior');
  expect(host.textContent).toBe('1 refused');
  const oldAction = getToastsSnapshot().at(-1)?.action;
  expect(oldAction?.label).toBe('Why?');

  await act(() => root.render(<Example generation={2} />));
  expect(host.querySelector('button')).toBeNull();
  expect(getToastsSnapshot()).toEqual([]);
  oldAction?.run();
  expect(openActivity).not.toHaveBeenCalled();
  await send(1, 'late');
  expect(host.querySelector('button')).toBeNull();

  await send(2, 'current');
  expect(host.textContent).toBe('1 refused');
  await act(() => host.querySelector('button')?.click());
  expect(openActivity).toHaveBeenCalledWith({ sessionId: 's1', item: { id: 'current', at } });
  expect(host.querySelector('button')).toBeNull();
  await act(() => root.unmount());
  host.remove();
});
