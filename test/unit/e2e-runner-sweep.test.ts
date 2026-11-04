import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs runner module, no declarations
import { selectRunProfiles } from '../e2e/run-smoke.mjs';

const entry = (name: string, directory = true) => ({ name, isDirectory: () => directory });
const runId = '123-abcd1234';
const own = `conduit-ud-${runId}-`;

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
});
