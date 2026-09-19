import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  deriveStatus,
  parseSkillFrontmatter,
  SKILL_ID_RE,
} from '../../src/skills';

describe('parseSkillFrontmatter', () => {
  it('reads name/description/version from a leading --- block', () => {
    const md = [
      '---',
      'name: Conduit Architecture',
      'description: Read and update the diagram.',
      'version: 1.2.0',
      '---',
      '',
      '# Body',
    ].join('\n');
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'Conduit Architecture',
      description: 'Read and update the diagram.',
      version: '1.2.0',
    });
  });

  it('tolerates CRLF and surrounding whitespace on values', () => {
    const md = '---\r\nname:  Padded \r\ndescription: d\r\nversion: 0.1.0\r\n---\r\nbody';
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'Padded',
      description: 'd',
      version: '0.1.0',
    });
  });

  it('defaults a missing version to 0.0.0 but still needs name', () => {
    const md = '---\nname: X\ndescription: y\n---\n';
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'X', description: 'y', version: '0.0.0' });
  });

  it('returns null when there is no frontmatter block', () => {
    expect(parseSkillFrontmatter('# Just a heading\n')).toBeNull();
  });

  it('returns null when the block has no name', () => {
    expect(parseSkillFrontmatter('---\ndescription: d\nversion: 1.0.0\n---\n')).toBeNull();
  });

  it('ignores keys other than the three it cares about', () => {
    const md = '---\nname: X\ndescription: d\nversion: 1.0.0\nextra: nope\n---\n';
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'X', description: 'd', version: '1.0.0' });
  });
});

describe('compareVersions', () => {
  it('orders dotted-numeric versions', () => {
    expect(compareVersions('1.0.0', '1.2.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.0.0')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.1', '1.0.9')).toBe(1);
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });
});

describe('deriveStatus', () => {
  it('is not-installed when nothing is installed', () => {
    expect(deriveStatus('1.0.0', null)).toBe('not-installed');
  });

  it('is update when the bundled version is newer', () => {
    expect(deriveStatus('1.1.0', '1.0.0')).toBe('update');
  });

  it('is installed when versions match', () => {
    expect(deriveStatus('1.0.0', '1.0.0')).toBe('installed');
  });

  it('is installed (not update) when the installed copy is somehow newer', () => {
    expect(deriveStatus('1.0.0', '1.1.0')).toBe('installed');
  });
});

describe('bundled skills', () => {
  const skillsDir = join(__dirname, '..', '..', 'resources', 'skills');

  /** Mirrors electron/skills-service.ts `bundledIds` — registration is directory discovery. */
  const bundledIds = (): string[] =>
    readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SKILL_ID_RE.test(e.name))
      .filter((e) => existsSync(join(skillsDir, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();

  const frontmatterOf = (id: string) =>
    parseSkillFrontmatter(readFileSync(join(skillsDir, id, 'SKILL.md'), 'utf8'));

  it('include conduit-interactive-plan and conduit-plan is marked deprecated', () => {
    expect(bundledIds()).toEqual(
      expect.arrayContaining(['conduit-interactive-plan', 'conduit-plan']),
    );

    expect(frontmatterOf('conduit-interactive-plan')).toEqual({
      name: 'Conduit Interactive Plan',
      description:
        "Write feature plans as plain Markdown to .conduit/plans/<slug>.md; Conduit renders them as an editable document with live ts and mermaid blocks. Read .conduit/plans/<slug>.comments.json each turn and address the human's comments.",
      version: '1.0.0',
    });

    const deprecated = frontmatterOf('conduit-plan');
    expect(deprecated?.version).toBe('1.1.0');
    expect(deprecated?.description).toMatch(
      /^Deprecated — superseded by Conduit Interactive Plan\. /,
    );
  });
});
