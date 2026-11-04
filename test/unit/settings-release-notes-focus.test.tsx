// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SettingsModal, type SettingsTab } from '../../webview/components/settings-modal';
import { WhatsNewDialog } from '../../webview/components/whats-new-dialog';
import { SettingsProvider } from '../../webview/settings';

const changelog = vi.hoisted(() => ({
  resolve: (_text: string | null) => {},
  read: () =>
    new Promise<string | null>((resolve) => {
      changelog.resolve = resolve;
    }),
}));
vi.mock('../../webview/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webview/bridge')>()),
  readLogTail: () => Promise.resolve({ off: true, tail: '' }),
  readChangelog: () => changelog.read(),
}));

const CHANGELOG = '## [2.0.0] — 2026-11-04\n- New\n## [1.0.0] — 2026-10-01\n- Old';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
});
let root: Root | null = null;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  document.body.innerHTML = '';
});

/** The app's wiring: What's new hands off to Settings opened on Release notes. */
function Workbench({ initial }: { initial: 'whats-new' | SettingsTab }) {
  const [notesOpen, setNotesOpen] = useState(initial === 'whats-new');
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(
    initial === 'whats-new' ? null : initial,
  );
  return (
    <SettingsProvider>
      {notesOpen && (
        <WhatsNewDialog
          release={{ version: '1.0.0', notes: '- Old' }}
          ready={false}
          onClose={() => setNotesOpen(false)}
          onShowAllNotes={() => {
            setNotesOpen(false);
            setSettingsTab('releases');
          }}
        />
      )}
      {settingsTab && (
        <SettingsModal
          agents={[]}
          initialTab={settingsTab}
          about={{ version: '1.0.0' } as never}
          onClose={() => setSettingsTab(null)}
          onSetChangesView={() => {}}
        />
      )}
    </SettingsProvider>
  );
}

async function mount(initial: 'whats-new' | SettingsTab) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<Workbench initial={initial} />));
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === label);
const settings = () => document.querySelector('.modal.settings');

async function handOffAndLoad(trigger: HTMLElement | undefined) {
  trigger?.focus();
  await act(async () => trigger?.click());
  // While the changelog is read, focus waits on the section's own nav button.
  expect(document.activeElement).toBe(document.querySelector('.settings__navitem--active'));
  expect(document.activeElement?.textContent).toBe('Release notes');
  await act(async () => changelog.resolve(CHANGELOG));
  const option = document.activeElement;
  expect(settings()?.contains(option)).toBe(true);
  expect(option?.getAttribute('role')).toBe('option');
  expect(option?.getAttribute('aria-selected')).toBe('true');
  expect(option?.textContent).toContain('v1.0.0');
}

describe('handing off to Settings → Release notes', () => {
  it("What's new → All release notes puts focus inside Settings", async () => {
    await mount('whats-new');
    await handOffAndLoad(button('All release notes'));
  });

  it('About → View all puts focus inside Settings', async () => {
    await mount('about');
    await handOffAndLoad(button('View all'));
  });

  it('a nav click leaves focus on the nav button', async () => {
    await mount('about');
    const nav = button('Release notes');
    nav?.focus();
    await act(async () => nav?.click());
    await act(async () => changelog.resolve(CHANGELOG));
    expect(document.activeElement).toBe(nav);
  });
});
