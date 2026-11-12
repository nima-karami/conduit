import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectRunProfiles } from '../e2e/smoke-select.mjs';

const entry = (name: string, directory = true) => ({ name, isDirectory: () => directory });
const runId = '123-abcd1234';
const own = `conduit-ud-${runId}-`;

it('executes the runner when launched through a directory junction or symlink', () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'conduit-unit-'));
  const alias = join(scratchDir, 'checkout');
  let linked = false;
  try {
    symlinkSync(process.cwd(), alias, 'junction');
    linked = true;
    const result = spawnSync(
      process.execPath,
      [join(alias, 'test', 'e2e', 'run-smoke.mjs'), '--not-a-runner-flag'],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    // The runner executed through the alias and rejected the flag; the suite now runs on Linux too,
    // so the same usage error is the proof on every platform.
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('unknown flag --not-a-runner-flag');
  } finally {
    // Remove only the link, never its target (the checkout): a Windows junction is a directory
    // entry, a POSIX symlink is a file entry.
    if (linked) (process.platform === 'win32' ? rmdirSync : unlinkSync)(alias);
    rmdirSync(scratchDir);
  }
});

describe('selectRunProfiles', () => {
  it('selects every profile of this invocation, including retries and hc-only profiles', () => {
    const names = [`${own}abc123`, `${own}retry-def456`, `${own}hc-only-ghi789`];
    expect(
      selectRunProfiles(
        names.map((name) => entry(name)),
        runId,
      ),
    ).toEqual(names);
  });

  it('excludes other invocations, solo runs, and the real user profile', () => {
    expect(
      selectRunProfiles(
        [
          entry('conduit-ud-123-abcd12340-other'),
          entry('conduit-ud-123-abcd1235-other'),
          entry('conduit-ud-solo-123-other'),
          entry('Conduit'),
          entry(`unrelated-${own}abc123`),
        ],
        runId,
      ),
    ).toEqual([]);
  });

  it('excludes files and symlinks reported as non-directories', () => {
    expect(
      selectRunProfiles([entry(`${own}file`, false), entry(`${own}link`, false)], runId),
    ).toEqual([]);
  });

  it('does not select profiles without a run identity', () => {
    expect(selectRunProfiles([entry('conduit-ud--abc123')], '')).toEqual([]);
  });

  it('selects only profiles created since the attempt snapshot', () => {
    const before = new Set([`${own}clean`, `${own}already-swept`]);
    expect(
      selectRunProfiles(
        [
          entry(`${own}clean`),
          entry(`${own}already-swept`),
          entry(`${own}failed-attempt`),
          entry('conduit-ud-other-run-failed'),
        ],
        runId,
        before,
      ),
    ).toEqual([`${own}failed-attempt`]);
  });
});
