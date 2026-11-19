import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
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

describe('Release workflow', () => {
  it('inspects upstream results explicitly for every publish job descended from e2e', () => {
    const file = resolve('.github/workflows/release.yml');
    const jobs = parse(readFileSync(file, 'utf8')).jobs as Record<
      string,
      {
        needs?: string | string[];
        if?: string;
      }
    >;
    const downstream = new Set(['e2e']);
    for (const parent of downstream) {
      for (const [name, job] of Object.entries(jobs)) {
        if ([job.needs ?? []].flat().includes(parent)) downstream.add(name);
      }
    }
    expect([...downstream]).toEqual(expect.arrayContaining(['build-and-publish', 'build-linux']));
    downstream.delete('e2e');
    for (const name of downstream) {
      expect(jobs[name].if).toMatch(/needs(?:\.[\w-]+|\[['"][\w-]+['"]\])\.result/);
    }
    expect(jobs['build-linux'].if).toContain("needs.build-and-publish.result == 'success'");
  });
});

describe('release command guards', () => {
  const cli = resolve('tools/release.mjs');

  it('rejects dirty releases, wrong tag branches and preparation away from origin/main', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'conduit-release-guard-'));
    const remote = join(fixture, 'origin.git');
    const repo = join(fixture, 'repo');
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const release = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: repo,
        encoding: 'utf8',
      });
    try {
      execFileSync('git', ['init', '-q', '--bare', remote]);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      git('config', 'user.name', 'Release test');
      git('config', 'user.email', 'test@example.com');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'package.json'), '{"version":"0.70.0"}');
      git('add', 'package.json');
      git('commit', '-qm', 'seed');
      git('remote', 'add', 'origin', remote);
      git('push', '-q', 'origin', 'main');
      git('switch', '-qc', 'feature');

      expect(release('tag').stderr).toContain('Tag from the main branch');
      writeFileSync(join(repo, 'feature.txt'), 'change');
      expect(release('patch').stderr).toContain('Commit or stash');
      git('add', 'feature.txt');
      git('commit', '-qm', 'feature');
      expect(release('patch').stderr).toContain('Prepare from origin/main');
      expect(git('branch', '--show-current')).toBe('feature');
      expect(git('tag', '--list')).toBe('');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
