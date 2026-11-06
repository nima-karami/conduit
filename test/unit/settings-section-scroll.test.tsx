// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../webview/components/settings-modal';
import { SettingsProvider } from '../../webview/settings';

vi.mock('../../webview/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webview/bridge')>()),
  readLogTail: () => Promise.resolve({ off: true, tail: '' }),
  readChangelog: () => Promise.resolve(null),
  listSkills: () => Promise.resolve([]),
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

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <SettingsProvider>
        <SettingsModal
          agents={[]}
          initialTab="appearance"
          onClose={() => {}}
          onSetChangesView={() => {}}
        />
      </SettingsProvider>,
    ),
  );
}
const pane = () => document.querySelector<HTMLElement>('.settings__pane');
const nav = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.settings__navitem')].find(
    (b) => b.textContent === label,
  );

describe('Settings sections', () => {
  it('start scrolled to the top, not where the previous section was left', async () => {
    await mount();
    const before = pane();
    if (before) before.scrollTop = 400;
    await act(async () => nav('About')?.click());
    expect(pane()).toBe(before);
    expect(pane()?.scrollTop).toBe(0);
  });
});
