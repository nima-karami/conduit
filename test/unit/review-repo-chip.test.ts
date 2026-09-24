// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewRepoChip } from '../../webview/components/review-repo-chip';
import type { RepoChipRow } from '../../webview/review-repos';

const rows: RepoChipRow[] = [
  { root: null, label: 'All repos', checked: true },
  { root: 'G:/p/app', label: 'app', checked: false, hint: '2 files' },
  { root: 'G:/p/proto', label: 'proto', checked: false, hint: 'clean' },
  { root: 'G:/p/web', label: 'web', checked: false, hint: '…' },
];

function render(compact: boolean): HTMLButtonElement {
  const html = renderToStaticMarkup(
    createElement(ReviewRepoChip, {
      rows,
      label: 'All repos',
      title: 'Reviewing all 3 repos',
      compact,
      onPick: () => {},
    }),
  );
  const host = new DOMParser().parseFromString(html, 'text/html').body;
  const chip = host.querySelector<HTMLButtonElement>('button.gh__reffilter.review__chip');
  if (!chip) throw new Error(`no chip in ${html}`);
  return chip;
}

describe('ReviewRepoChip', () => {
  it('label "All repos", aria-label "Review repo: All repos", aria-haspopup menu, title "Reviewing all 3 repos"', () => {
    const chip = render(false);
    expect(chip.querySelector('.gh__reffilter-label')?.textContent).toBe('All repos');
    expect(chip.getAttribute('aria-label')).toBe('Review repo: All repos');
    expect(chip.getAttribute('aria-haspopup')).toBe('menu');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(chip.getAttribute('title')).toBe('Reviewing all 3 repos');
    expect(chip.querySelector('.gh__reffilter-caret')).not.toBeNull();
  });

  it('compact → no .gh__reffilter-label, label still in aria-label and title', () => {
    const chip = render(true);
    expect(chip.querySelector('.gh__reffilter-label')).toBeNull();
    expect(chip.textContent).toBe('');
    expect(chip.getAttribute('aria-label')).toBe('Review repo: All repos');
    expect(chip.getAttribute('title')).toBe('Reviewing all 3 repos');
    expect(chip.querySelector('.gh__reffilter-caret')).not.toBeNull();
  });
});
