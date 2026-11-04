import { describe, expect, it } from 'vitest';
import {
  buildDependencyNames,
  packageNamesFromLock,
  rootPackageName,
  runtimeLockCrates,
} from './tray-lock-notices';

describe('tray lock notice helpers', () => {
  it('parses package names from lock blocks', () => {
    const lock = `
version = 3

[[package]]
name = "serde"
version = "1.0.0"

[[package]]
name = "itoa"
version = "1.0.0"
`;
    expect(packageNamesFromLock(lock)).toEqual(['serde', 'itoa']);
  });

  it('reads root and build-dependencies from a manifest', () => {
    const manifest = `
[package]
name = "conduit-tray"
version = "0.0.0"

[build-dependencies]
embed-resource = "2"
`;
    expect(rootPackageName(manifest)).toBe('conduit-tray');
    expect([...buildDependencyNames(manifest)]).toEqual(['embed-resource']);
    const lock = `
[[package]]
name = "conduit-tray"
[[package]]
name = "embed-resource"
[[package]]
name = "serde"
`;
    expect(runtimeLockCrates(lock, manifest)).toEqual(['serde']);
  });
});
