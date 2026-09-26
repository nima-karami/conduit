// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { fuzzyScore } from '../../src/fuzzy';
import {
  CommandPalette,
  type PaletteEntry,
  rankEntries,
} from '../../webview/components/command-palette';

const entry = (id: string, title: string, keywords?: string[]): PaletteEntry => ({
  id,
  title,
  group: 'Commands',
  keywords,
  run: () => {},
});

const ids = (rows: PaletteEntry[]) => rows.map((r) => r.id);

describe('rankEntries', () => {
  it('finds an entry by a keyword that is not a subsequence of its title', () => {
    const timed = entry('cmd:timedMessage', 'Send timed message…', ['interval', 'schedule']);
    expect(fuzzyScore('interval', timed.title)).toBeNull();
    expect(ids(rankEntries([entry('cmd:new', 'New session'), timed], 'interval'))).toEqual([
      'cmd:timedMessage',
    ]);
  });

  it('ranks a title match above a keyword match with a higher raw score', () => {
    // The keyword is an exact hit (big score) while the title is only a weak scattered
    // subsequence — the tier, not the score, has to decide.
    const kwOnly = entry('kw', 'Send timed message…', ['diff']);
    const titled = entry('title', 'Undiffuse the aggregate reporting pipeline');
    const kwScore = fuzzyScore('diff', 'diff')?.score ?? 0;
    const titleScore = fuzzyScore('diff', titled.title)?.score ?? 0;
    expect(titleScore).toBeLessThan(kwScore);
    expect(ids(rankEntries([kwOnly, titled], 'diff'))).toEqual(['title', 'kw']);
  });

  it('drops entries matching neither title nor keywords', () => {
    const rows = rankEntries(
      [entry('a', 'New session', ['create']), entry('b', 'Save All')],
      'zzqq',
    );
    expect(rows).toEqual([]);
  });

  it('ranks keyword-only matches among themselves by fuzzy score', () => {
    // 'timer' is exact on one, a scattered subsequence on the other.
    const exact = entry('exact', 'Alpha', ['timer']);
    const loose = entry('loose', 'Beta', ['optimizer']);
    expect(fuzzyScore('timer', 'optimizer')).not.toBeNull();
    expect(ids(rankEntries([loose, exact], 'timer'))).toEqual(['exact', 'loose']);
  });

  it('returns every entry, in source order, for an empty term', () => {
    const rows = [entry('a', 'New session', ['create']), entry('b', 'Save All'), entry('c', 'Zzz')];
    expect(ids(rankEntries(rows, ''))).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing keywords array as no keywords', () => {
    expect(rankEntries([entry('a', 'New session')], 'interval')).toEqual([]);
  });
});

describe('palette badge', () => {
  it('badgeTitle renders as the badge title attribute', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = () => {};
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const items: PaletteEntry[] = [
      {
        id: 'file:/w/ci/lib/util.ts',
        title: 'lib/util.ts',
        group: 'Files',
        badge: 'ci-image',
        badgeTone: 'neutral',
        badgeTitle: '/w/ci',
        run: () => {},
      },
      { id: 'file:/w/h/a.ts', title: 'a.ts', group: 'Files', badge: 'rmb', run: () => {} },
    ];
    await act(async () =>
      root.render(
        createElement(CommandPalette, {
          items,
          placeholder: 'x',
          initialQuery: 'u',
          onClose: () => {},
        }),
      ),
    );
    const badges = [...document.querySelectorAll('.palette__badge')];
    expect(badges.map((b) => [b.textContent, b.getAttribute('title')])).toEqual([
      ['ci-image', '/w/ci'],
    ]);
    await act(async () => root.unmount());
    // initialQuery is read once per mount, so the untitled badge gets its own palette.
    const root2 = createRoot(host);
    await act(async () =>
      root2.render(
        createElement(CommandPalette, {
          items,
          placeholder: 'x',
          initialQuery: 'a.ts',
          onClose: () => {},
        }),
      ),
    );
    const plain = document.querySelector('.palette__badge');
    expect(plain?.textContent).toBe('rmb');
    expect(plain?.hasAttribute('title')).toBe(false);
    await act(async () => root2.unmount());
    host.remove();
  });
});

describe('palette match highlight', () => {
  it('marks matched characters with the class the stylesheet styles', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = () => {};
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(CommandPalette, {
          items: [entry('a', 'Open settings')],
          placeholder: 'x',
          initialQuery: 'set',
          onClose: () => {},
        }),
      ),
    );
    const hl = [...document.querySelectorAll('.palette__hl')].map((b) => b.textContent).join('');
    expect(hl).toBe('set');
    const css = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
    expect(css).toMatch(/\n\.palette__hl \{/);
    await act(async () => root.unmount());
    host.remove();
  });
});
