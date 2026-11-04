import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveHcBinary } from '../e2e/hc-binary.mjs';

const repo = join('repo', 'root');
const vendored = (exe: string) => join(repo, 'build', 'vendor', 'hc', exe);
const pathHc = (dir: string, exe: string) => join(dir, exe);

describe('resolveHcBinary', () => {
  it('prefers CONDUIT_HC_BINARY over the vendored copy and PATH', () => {
    expect(
      resolveHcBinary({
        env: { CONDUIT_HC_BINARY: 'override', PATH: 'bin' },
        platform: 'win32',
        exists: () => true,
        repo,
      }),
    ).toBe('override');
  });

  it('prefers the vendored hc over PATH when it exists', () => {
    expect(
      resolveHcBinary({ env: { PATH: 'bin' }, platform: 'win32', exists: () => true, repo }),
    ).toBe(vendored('hc.exe'));
  });

  it('uses the platform executable name for the vendored copy', () => {
    expect(resolveHcBinary({ env: {}, platform: 'linux', exists: () => true, repo })).toBe(
      vendored('hc'),
    );
  });

  it('falls back to the first PATH entry holding hc', () => {
    const second = pathHc('b', 'hc.exe');
    const found = resolveHcBinary({
      env: { PATH: ['a', 'b', 'c'].join(process.platform === 'win32' ? ';' : ':') },
      platform: 'win32',
      exists: (p) => p === second || p === pathHc('c', 'hc.exe'),
      repo,
    });
    expect(found).toBe(second);
  });

  it('is undefined when nothing provides hc', () => {
    expect(
      resolveHcBinary({ env: { PATH: 'a' }, platform: 'win32', exists: () => false, repo }),
    ).toBeUndefined();
  });
});
