// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PathCandidatePicker } from '../../webview/components/path-candidate-picker';
import {
  FILTER_THRESHOLD,
  type PickerRow,
} from '../../webview/components/path-candidate-picker-model';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
});

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const row = (repo: string): PickerRow => ({
  key: repo,
  cand: {
    absPath: `/w/${repo}/src/index.ts`,
    rootIdx: 0,
    relToRoot: `${repo}/src/index.ts`,
    repoRoot: `/w/${repo}`,
    relToRepo: 'src/index.ts',
    isDir: false,
    strength: 'suffix',
  },
  repoName: repo,
  tag: 'nested',
  accessibleName: `${repo} src/index.ts`,
  workingHere: false,
});

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const activeName = () =>
  document.querySelector('.pathpick__row--active')?.getAttribute('aria-label') ?? null;

const pointerMove = (el: Element, x: number, y: number) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
  });

// Review r2: an armed gate survived a re-filter, so the same-point pointermove Chromium sends a
// row that slides under a resting pointer took the highlight from the top match.
describe('PathCandidatePicker re-filter under a resting pointer', () => {
  it('an armed gate followed by a re-filter keeps row 0 active, and Enter takes it', async () => {
    const repos = Array.from({ length: FILTER_THRESHOLD }, (_, i) =>
      i % 2 === 0 ? `alpha${i}` : `beta${i}`,
    );
    const onPick = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root?.render(
        createElement(PathCandidatePicker, {
          at: { x: 5, y: 5 },
          token: 'src/index.ts',
          rows: repos.map(row),
          total: repos.length,
          truncated: false,
          mode: { kind: 'open' },
          onPick,
          onSearchAll: () => {},
          onClose: () => {},
        }),
      ),
    );
    await pointerMove(options()[3], 40, 90);
    await pointerMove(options()[3], 41, 90);
    expect(activeName()).toBe(`${repos[3]} src/index.ts`);

    const input = document.querySelector('.pathpick__filter') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'beta',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await pointerMove(options()[2], 41, 90);
    expect(activeName()).toBe('beta1 src/index.ts');
    expect(document.querySelector('.pathpick')?.getAttribute('data-pointer')).toBe('resting');

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].repoName).toBe('beta1');
  });
});

// Review r1 SF2: Open Detected Link rows are links, and two links can share a top candidate.
describe('PathCandidatePicker rows keyed by row.key', () => {
  it('two rows with one candidate both render, with no duplicate-key warning', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const shared = row('alpha');
    await act(async () =>
      root?.render(
        createElement(PathCandidatePicker, {
          at: { x: 5, y: 5 },
          token: 'Links on screen',
          rows: [
            { ...shared, key: 'src/index.ts', repoName: 'src/index.ts' },
            { ...shared, key: 'index.ts', repoName: 'index.ts' },
          ],
          total: 12,
          truncated: true,
          mode: { kind: 'open' },
          onPick: () => {},
          onClose: () => {},
        }),
      ),
    );
    expect(options().map((o) => o.querySelector('.pathpick__repo')?.textContent)).toEqual([
      'src/index.ts',
      'index.ts',
    ]);
    // Truncated without onSearchAll: the footer, never a "Search all files…" row.
    expect(document.querySelector('.pathpick__search')).toBeNull();
    expect(document.querySelector('.pathpick__foot')?.textContent).toBe('Showing 2 of 12');
    expect(error.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    error.mockRestore();
  });
});
