// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReleaseNotesPage } from '../../webview/components/release-notes-page';

const { openExternal, readChangelog } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  readChangelog: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('../../webview/bridge', () => ({ openExternal, readChangelog, post: vi.fn() }));

const CHANGELOG = [
  '# Changelog',
  '## [Unreleased]',
  '- Upcoming',
  '## [0.3.0] — 2026-11-04',
  '### Added',
  '- Third',
  '## [0.2.0] — 2026-10-01 [YANKED]',
  '- Second',
  '## [0.1.0] — 2025-12-31',
  '- First [link](https://example.com/x)',
].join('\n');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
});
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function render(installedVersion?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<ReleaseNotesPage installedVersion={installedVersion} />));
}
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const selected = () => document.querySelector('[role="option"][aria-selected="true"]');
const shownVersion = () =>
  document.querySelector('[data-release-version]')?.getAttribute('data-release-version');
const press = (key: string) =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });

describe('ReleaseNotesPage', () => {
  it('lists released versions only and opens on the installed one', async () => {
    readChangelog.mockResolvedValue(CHANGELOG);
    await render('0.2.0');
    expect(options().map((o) => o.querySelector('.relnotes__vername')?.textContent)).toEqual([
      'v0.3.0',
      'v0.2.0',
      'v0.1.0',
    ]);
    expect(selected()?.textContent).toContain('Installed');
    expect(shownVersion()).toBe('0.2.0');
    expect(options()[2].textContent).toContain('2025');
    expect(options()[0].textContent).not.toContain('2026');
  });

  it('opens on the newest when the installed version is not in the changelog', async () => {
    readChangelog.mockResolvedValue(CHANGELOG);
    await render('9.9.9');
    expect(shownVersion()).toBe('0.3.0');
    expect(document.querySelector('.relnotes__body h3')?.textContent).toBe('Added');
  });

  it('moves the selection and focus with Up, Down, Home and End', async () => {
    readChangelog.mockResolvedValue(CHANGELOG);
    await render('0.3.0');
    act(() => options()[0].focus());
    press('ArrowDown');
    expect(shownVersion()).toBe('0.2.0');
    expect(document.activeElement).toBe(selected());
    press('End');
    expect(shownVersion()).toBe('0.1.0');
    press('ArrowDown');
    expect(shownVersion()).toBe('0.1.0');
    press('Home');
    expect(shownVersion()).toBe('0.3.0');
    press('ArrowUp');
    expect(shownVersion()).toBe('0.3.0');
    expect(options().filter((o) => o.tabIndex === 0)).toEqual([selected()]);
  });

  it('links a published release to GitHub and an unpublished one to nothing', async () => {
    readChangelog.mockResolvedValue(CHANGELOG);
    await render('0.3.0');
    act(() => document.querySelector<HTMLElement>('.relnotes__gh')?.click());
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/nima-karami/conduit/releases/tag/v0.3.0',
    );
    act(() => options()[1].click());
    expect(document.querySelector('.relnotes__gh')).toBeNull();
    expect(document.querySelector('.relnotes__head')?.textContent).toContain('Not published');
  });

  it('resets the notes scroll when the version changes', async () => {
    readChangelog.mockResolvedValue(CHANGELOG);
    await render('0.3.0');
    const body = document.querySelector<HTMLElement>('.relnotes__body');
    if (body) body.scrollTop = 120;
    act(() => options()[2].click());
    expect(document.querySelector<HTMLElement>('.relnotes__body')?.scrollTop).toBe(0);
  });

  it('offers Retry when the read fails, and recovers', async () => {
    readChangelog.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue(CHANGELOG);
    await render('0.3.0');
    expect(document.querySelector('[data-release-notes="failed"]')?.textContent).toContain(
      'Couldn’t load the release notes.',
    );
    await act(async () => document.querySelector<HTMLElement>('.relnotes__status button')?.click());
    expect(shownVersion()).toBe('0.3.0');
  });

  it('says so when the build has no changelog', async () => {
    readChangelog.mockResolvedValue(null);
    await render('0.3.0');
    expect(document.querySelector('[data-release-notes="empty"]')?.textContent).toBe(
      'This build has no release notes.',
    );
  });
});
