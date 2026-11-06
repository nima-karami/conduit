import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  changelogEntries,
  changelogSection,
  defaultEntryIndex,
  releaseDateLabel,
} from '../../src/changelog';

describe('changelogSection', () => {
  const markdown =
    '## [Unreleased]\n\nNext\n\n## [1.2.3] — 2026-11-03\n\nFeature\n\nFix\n\n## [1.2.2] — 2026-10-01\n\nOld';

  it('returns the requested section body without its heading', () => {
    expect(changelogSection(markdown, '1.2.3')).toBe('Feature\n\nFix');
  });

  it('returns null when the version is missing', () => {
    expect(changelogSection(markdown, '9.9.9')).toBeNull();
  });

  it('reads the last section through end of file', () => {
    expect(changelogSection(markdown, '1.2.2')).toBe('Old');
  });

  it('supports the Unreleased section', () => {
    expect(changelogSection(markdown, 'Unreleased')).toBe('Next');
  });

  it('handles CRLF line endings', () => {
    expect(
      changelogSection(
        '## [1.0.0] — today\r\n\r\nNote\r\n\r\n## [0.9.0] — yesterday\r\nOld',
        '1.0.0',
      ),
    ).toBe('Note');
  });
});

describe('changelogEntries', () => {
  it('lists every released version in file order, skipping Unreleased', () => {
    const md =
      '# Changelog\n\nIntro\n\n## [Unreleased]\n\nNext\n\n## [1.2.3] — 2026-11-03\n\n### Added\n- A\n\n## [1.2.2] — 2026-10-01\n\nOld\n';
    expect(changelogEntries(md)).toEqual([
      { version: '1.2.3', date: '2026-11-03', body: '### Added\n- A', published: true },
      { version: '1.2.2', date: '2026-10-01', body: 'Old', published: true },
    ]);
  });

  it('reads CRLF, a hyphen or no separator, and a missing date', () => {
    const md =
      '## [2.0.0] - 2026-01-02\r\nTwo\r\n## [1.0.0]\r\nOne\r\n## [0.9.0] 2025-12-31\r\nNine';
    expect(changelogEntries(md).map(({ version, date, body }) => [version, date, body])).toEqual([
      ['2.0.0', '2026-01-02', 'Two'],
      ['1.0.0', null, 'One'],
      ['0.9.0', '2025-12-31', 'Nine'],
    ]);
  });

  it('marks a [YANKED] version as unpublished', () => {
    const [entry] = changelogEntries('## [0.41.0] — 2026-09-25 [YANKED]\n\nGone');
    expect(entry).toMatchObject({ version: '0.41.0', date: '2026-09-25', published: false });
  });

  it('ends a section at a heading that names no version, without listing it', () => {
    const md = '## [0.1.0] — 2026-06-16\n\nFirst\n\n## 2026-06-11 — Round 3\n\nDev log\n';
    expect(changelogEntries(md)).toEqual([
      { version: '0.1.0', date: '2026-06-16', body: 'First', published: true },
    ]);
  });

  it('keeps a heading inside a fenced code block as body', () => {
    const md = '## [1.0.0] — 2026-01-01\n\n```md\n## [9.9.9] — fake\n```\n\nAfter';
    const entries = changelogEntries(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe('```md\n## [9.9.9] — fake\n```\n\nAfter');
  });

  it('keeps ### subsections and an empty body', () => {
    expect(
      changelogEntries('## [1.0.0] — 2026-01-01\n## [0.9.0] — 2025-01-01\n### Fixed\n- x'),
    ).toEqual([
      { version: '1.0.0', date: '2026-01-01', body: '', published: true },
      { version: '0.9.0', date: '2025-01-01', body: '### Fixed\n- x', published: true },
    ]);
  });

  it('parses the real CHANGELOG.md: newest first, no Unreleased, every version dated', () => {
    const real = changelogEntries(
      readFileSync(join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8'),
    );
    expect(real.length).toBeGreaterThan(50);
    expect(real.some((e) => e.version.toLowerCase() === 'unreleased')).toBe(false);
    expect(real.every((e) => e.date && /^\d+\.\d+\.\d+$/.test(e.version))).toBe(true);
    expect(real.find((e) => e.version === '0.1.0')?.body).not.toContain('Round 3');
  });
});

describe('defaultEntryIndex', () => {
  const entries = changelogEntries('## [2.0.0] — 2026-01-02\nA\n## [1.0.0] — 2026-01-01\nB');
  it('selects the installed version', () => expect(defaultEntryIndex(entries, '1.0.0')).toBe(1));
  it('falls back to the newest when the installed one is absent', () => {
    expect(defaultEntryIndex(entries, '9.9.9')).toBe(0);
    expect(defaultEntryIndex(entries)).toBe(0);
  });
});

describe('releaseDateLabel', () => {
  it('formats short and long dates in UTC', () => {
    expect(releaseDateLabel('2026-11-04', 'short', undefined, 'en-US')).toBe('Nov 4, 2026');
    expect(releaseDateLabel('2026-11-04', 'long', undefined, 'en-US')).toBe('November 4, 2026');
  });
  it('drops the year only when it matches', () => {
    expect(releaseDateLabel('2026-01-01', 'short', '2026', 'en-US')).toBe('Jan 1');
    expect(releaseDateLabel('2025-12-31', 'short', '2026', 'en-US')).toBe('Dec 31, 2025');
  });
  it('returns an unparseable date as written', () => {
    expect(releaseDateLabel('someday', 'short', undefined, 'en-US')).toBe('someday');
  });
});
