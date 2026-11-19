import { describe, expect, it } from 'vitest';
import { changelogSection } from '../../src/changelog';
import { nextReleaseVersion, releaseChangelog, releaseReadme } from '../../tools/release.mjs';

describe('release preparation', () => {
  const date = '2026-11-18';

  it('bumps patch or minor and resets patch on a minor bump', () => {
    expect(nextReleaseVersion('0.70.9', 'patch')).toBe('0.70.10');
    expect(nextReleaseVersion('0.70.9', 'minor')).toBe('0.71.0');
    expect(nextReleaseVersion('0.70.9', 'major')).toBe('1.0.0');
    expect(() => nextReleaseVersion('0.70.9-dev', 'patch')).toThrow();
  });

  it('preserves older notes and moves Unreleased bullets into the new dated version', () => {
    const older = '## [0.70.0] — 2026-11-17\n\n- An older change.\n';
    const prepared = releaseChangelog(
      `# Changelog\n\n## [Unreleased]\n\n### Fixed\n- Shipping this fix.\n\n${older}`,
      '0.70.1',
      date,
    );
    expect(prepared).toContain('## [Unreleased]\n\n## [0.70.1] — 2026-11-18');
    expect(changelogSection(prepared, '0.70.1')).toContain('- Shipping this fix.');
    expect(prepared.endsWith(older)).toBe(true);
  });

  it('redates the already authored next version and rejects conflicting or missing notes', () => {
    const planned = '## [0.70.1] — 2026-11-17\n\n- Planned fix.\n';
    expect(releaseChangelog(`## [Unreleased]\n\n${planned}`, '0.70.1', date)).toContain(
      '## [0.70.1] — 2026-11-18\n\n- Planned fix.',
    );
    expect(() =>
      releaseChangelog(`## [Unreleased]\n\n- New fix.\n\n${planned}`, '0.70.1', date),
    ).toThrow(/resolve/i);
    expect(() => releaseChangelog('## [Unreleased]\n\n', '0.70.1', date)).toThrow(/release note/i);
  });

  it('only edits the version on the README status line and rejects a stale marker', () => {
    const readme =
      '# Conduit\n\n> **Status:** early releases (`v0.70.0`).\n\nAlso v0.70.0 in prose.\n';
    expect(releaseReadme(readme, '0.70.0', '0.70.1')).toBe(
      readme.replace('(`v0.70.0`)', '(`v0.70.1`)'),
    );
    expect(() => releaseReadme(readme, '0.70.1', '0.70.2')).toThrow(/status/);
  });
});
