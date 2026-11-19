// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../webview/components/settings-page';
import { SettingsProvider } from '../../webview/settings';

vi.mock('../../webview/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webview/bridge')>()),
  readLogTail: () => Promise.resolve({ off: true, tail: '' }),
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | null = null;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  document.body.innerHTML = '';
});

async function mount(onClose: () => void) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <SettingsProvider>
        <SettingsPage agents={[]} onClose={onClose} onSetChangesView={() => {}} />
      </SettingsProvider>,
    ),
  );
}
const back = () =>
  [...document.querySelectorAll<HTMLElement>('button')].find(
    (b) => b.textContent === 'Back to Conduit',
  );

describe('SettingsPage shell', () => {
  it('renders a labelled region with a Back button and no modal backdrop', async () => {
    await mount(() => {});
    expect(document.querySelector('.modal__backdrop')).toBeNull();
    const region = document.querySelector('[role="region"][aria-label="Settings"]');
    expect(region).not.toBeNull();
    expect(region?.classList.contains('settings-page')).toBe(true);
    expect(back()).toBeDefined();
  });

  it('Back calls onClose once', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await act(async () => back()?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc calls onClose once when nothing nested is open', async () => {
    const onClose = vi.fn();
    await mount(onClose);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focus is on Back after open', async () => {
    await mount(() => {});
    expect(document.activeElement).toBe(back());
  });
});

describe('workbench behind Settings', () => {
  it('app.tsx marks the workbench inert exactly while Settings is open', () => {
    const app = readFileSync(join(__dirname, '../../webview/app.tsx'), 'utf8');
    expect(app).toMatch(/<div className="workbench" inert=\{settingsOpen\}>/);
  });

  it('app.tsx closes Settings only through closeSettings', () => {
    const app = readFileSync(join(__dirname, '../../webview/app.tsx'), 'utf8');
    const closes = app.match(/setSettingsOpen\(false\)/g) ?? [];
    expect(closes).toHaveLength(1);
    expect(app).toMatch(/const closeSettings = useCallback\([\s\S]*?setSettingsOpen\(false\);/);
  });
});
