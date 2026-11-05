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

/** The app's wiring: What's new hands off to Settings → About → Release notes. */
function Workbench({
  initial,
}: {
  initial: 'whats-new' | { tab: SettingsTab; releaseNotes?: boolean };
}) {
  const [notesOpen, setNotesOpen] = useState(initial === 'whats-new');
  const [settings, setSettings] = useState<{
    tab: SettingsTab;
    releaseNotes: boolean;
  } | null>(
    initial === 'whats-new' ? null : { tab: initial.tab, releaseNotes: !!initial.releaseNotes },
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
            setSettings({ tab: 'about', releaseNotes: true });
          }}
        />
      )}
      {settings && (
        <SettingsModal
          agents={[]}
          initialTab={settings.tab}
          initialAboutReleaseNotes={settings.releaseNotes}
          about={{ version: '1.0.0' } as never}
          onClose={() => setSettings(null)}
          onSetChangesView={() => {}}
        />
      )}
    </SettingsProvider>
  );
}

async function mount(initial: 'whats-new' | { tab: SettingsTab; releaseNotes?: boolean }) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<Workbench initial={initial} />));
}
const button = (label: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) =>
    typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? ''),
  );
const settings = () => document.querySelector('.modal.settings');
const navLabels = () =>
  [...document.querySelectorAll('.settings__navitem')].map((b) => b.textContent);

async function handOffAndLoad(trigger: HTMLElement | undefined) {
  trigger?.focus();
  await act(async () => trigger?.click());
  expect(document.querySelector('.settings__navitem--active')?.textContent).toBe('About');
  expect(document.querySelector('.about__subtitle')?.textContent).toBe('Release notes');
  await act(async () => changelog.resolve(CHANGELOG));
  const option = document.activeElement;
  expect(settings()?.contains(option)).toBe(true);
  expect(option?.getAttribute('role')).toBe('option');
  expect(option?.getAttribute('aria-selected')).toBe('true');
  expect(option?.textContent).toContain('v1.0.0');
}

describe('Settings About release notes', () => {
  it('has no Release notes tab in the nav', async () => {
    await mount({ tab: 'about' });
    expect(navLabels()).not.toContain('Release notes');
  });

  it('shows a Release notes button beside update controls on About', async () => {
    await mount({ tab: 'about' });
    const updatesRow = [...document.querySelectorAll('.about__row')].find(
      (row) => row.querySelector('.about__rowlabel')?.textContent === 'Updates',
    );
    expect(updatesRow?.querySelector('.about__updatectl')?.textContent).toContain('Release notes');
    expect(
      updatesRow?.querySelector('.about__updatectl')?.querySelectorAll('button').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("What's new → All release notes puts focus on the selected version", async () => {
    await mount('whats-new');
    await handOffAndLoad(button('All release notes'));
  });

  it('About → Release notes puts focus on the selected version', async () => {
    await mount({ tab: 'about' });
    await handOffAndLoad(button('Release notes'));
  });

  it('Back returns to About and focuses the Release notes button', async () => {
    await mount({ tab: 'about' });
    await handOffAndLoad(button('Release notes'));
    await act(async () => button('Back')?.click());
    expect(document.querySelector('.about__subtitle')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Release notes');
  });

  it('Escape on the sub-page goes back before closing Settings', async () => {
    await mount({ tab: 'about' });
    await act(async () => button('Release notes')?.click());
    await act(async () => changelog.resolve(CHANGELOG));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(settings()).toBeTruthy();
    expect(document.querySelector('.about__subtitle')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(settings()).toBeNull();
  });

  it('opening with initialAboutReleaseNotes lands on the sub-page', async () => {
    await mount({ tab: 'about', releaseNotes: true });
    await act(async () => changelog.resolve(CHANGELOG));
    expect(document.querySelector('.about__subtitle')?.textContent).toBe('Release notes');
    expect(document.querySelector('.settings__navitem--active')?.textContent).toBe('About');
  });
});
