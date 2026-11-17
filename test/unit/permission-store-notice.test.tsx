// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  PermissionStoreNotice,
  type PermissionStoreNoticeProps,
} from '../../webview/components/permission-store-notice';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
});
async function render(props: Partial<PermissionStoreNoticeProps> = {}) {
  const host = document.createElement('div');
  root = createRoot(host);
  const onRetry = vi.fn(async () => null);
  await act(async () =>
    root.render(
      <PermissionStoreNotice
        saveError="Restrictions active here; not saved"
        backupWarning={null}
        readOnly={false}
        onRetry={onRetry}
        {...props}
      />,
    ),
  );
  return { host, onRetry };
}
it('keeps errors visible, retries manually and reports uncertain timeout without focus', async () => {
  const { host, onRetry } = await render();
  expect(host.textContent).toContain('Restrictions active here; not saved');
  expect(onRetry).not.toHaveBeenCalled();
  expect(host.querySelector('[autofocus]')).toBeNull();
  await act(async () => host.querySelector('button')?.click());
  expect(onRetry).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Saving timed out');
  expect(host.textContent).toContain('Restrictions active here; not saved');
});
it('separates backup warning and refuses retry for a read-only store', async () => {
  const { host, onRetry } = await render({ readOnly: true, backupWarning: 'backup failed' });
  expect(host.textContent).toContain('Permissions backup: backup failed');
  expect(host.querySelector('button')?.disabled).toBe(true);
  await act(async () => host.querySelector('button')?.click());
  expect(onRetry).not.toHaveBeenCalled();
});
it('shows operation refusal even while the snapshot error is unchanged', async () => {
  const { host } = await render({ onRetry: async () => ({ ok: false, error: 'save-failed' }) });
  await act(async () => host.querySelector('button')?.click());
  expect(host.textContent).toContain('Permissions could not be saved (save-failed)');
});
it('is absent when storage is healthy', async () => {
  const { host } = await render({ saveError: null });
  expect(host.childElementCount).toBe(0);
});
it('keeps pending disabled and displays timeout even if a healthy snapshot arrives meanwhile', async () => {
  let resolve!: (value: null) => void;
  const onRetry = () =>
    new Promise<null>((done) => {
      resolve = done;
    });
  const { host } = await render({ onRetry });
  await act(async () => host.querySelector('button')?.click());
  expect(host.querySelector('button')?.disabled).toBe(true);
  await act(async () =>
    root.render(
      <PermissionStoreNotice
        saveError={null}
        backupWarning={null}
        readOnly={false}
        onRetry={onRetry}
      />,
    ),
  );
  await act(async () => resolve(null));
  expect(host.textContent).toContain('Saving timed out');
  expect(host.querySelector('button')?.disabled).toBe(false);
});
