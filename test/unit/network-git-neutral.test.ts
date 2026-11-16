import { describe, expect, it } from 'vitest';
import { neutralEnv, parseConfigList } from '../../server/network/git-neutral';

// B's git reads run with every program-running key overridden (CON-45 G1 re-review finding 1).
// A driver's name is the repo's own choice, so the overrides are built from the listed config.

const REPO = { gitDir: '/w/.git', commonDir: '/w/.git', top: '/w' };

/** The overrides an env carries, as `key=value` in order. */
function overrides(env: Readonly<Record<string, string>>): string[] {
  const n = Number(env.GIT_CONFIG_COUNT);
  return Array.from(
    { length: n },
    (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`,
  );
}

describe('git-neutral', () => {
  it('parses a -z listing, valueless keys included', () => {
    expect(parseConfigList('core.bare\nfalse\0filter.lfs.clean\ngit-lfs clean\0core.x\0')).toEqual([
      'core.bare',
      'filter.lfs.clean',
      'core.x',
    ]);
  });

  it('pins the dirs and empties every program key of each driver, once per driver', () => {
    const r = neutralEnv(REPO, [
      'filter.lfs.clean',
      'filter.lfs.smudge',
      'filter.my.dotted.name.process',
      'diff.conv.textconv',
      'diff.renames',
    ]);
    if (!r.ok) throw new Error('expected an env');
    expect(r.env).toMatchObject({
      GIT_DIR: '/w/.git',
      GIT_COMMON_DIR: '/w/.git',
      GIT_WORK_TREE: '/w',
    });
    expect(overrides(r.env)).toEqual([
      'core.fsmonitor=false',
      'core.hooksPath=/dev/null',
      'log.showSignature=false',
      'filter.lfs.clean=',
      'filter.lfs.smudge=',
      'filter.lfs.process=',
      'filter.lfs.required=false',
      'filter.my.dotted.name.clean=',
      'filter.my.dotted.name.smudge=',
      'filter.my.dotted.name.process=',
      'filter.my.dotted.name.required=false',
      'diff.conv.textconv=',
      'diff.conv.command=',
    ]);
  });

  it('refuses an unknown extension and allows the ones that only change the format', () => {
    expect(neutralEnv(REPO, ['extensions.partialclone']).ok).toBe(false);
    expect(neutralEnv(REPO, ['extensions.objectformat', 'extensions.worktreeconfig']).ok).toBe(
      true,
    );
  });
});
