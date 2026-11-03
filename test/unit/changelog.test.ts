import { describe, expect, it } from 'vitest';
import { changelogSection } from '../../src/changelog';

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
