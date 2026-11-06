import { describe, expect, it } from 'vitest';
import {
  buildDependencyNames,
  isShippedWindowsTargetCrate,
  normalDependencyNames,
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

[dependencies]
serde = "1"

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
dependencies = []
`;
    expect(runtimeLockCrates(lock, manifest)).toEqual(['serde']);
  });

  it('walks runtime deps only and drops proc-macros and non-shipped Windows targets', () => {
    const manifest = `
[package]
name = "conduit-tray"

[dependencies]
serde = "1"
windows-sys = "0.59"

[build-dependencies]
embed-resource = "2"
`;
    expect(normalDependencyNames(manifest)).toEqual(['serde', 'windows-sys']);
    expect(isShippedWindowsTargetCrate('windows_x86_64_msvc')).toBe(true);
    expect(isShippedWindowsTargetCrate('windows_aarch64_pc_windows_msvc')).toBe(false);

    const lock = `
[[package]]
name = "conduit-tray"
dependencies = ["serde 1", "windows-sys 1"]

[[package]]
name = "embed-resource"
dependencies = ["winres 1"]

[[package]]
name = "winres"
dependencies = []

[[package]]
name = "serde"
version = "1"
dependencies = ["serde_derive 1"]

[[package]]
name = "serde_derive"
dependencies = ["proc-macro2 1", "quote 1", "syn 1"]

[[package]]
name = "proc-macro2"
dependencies = ["unicode-ident 1"]

[[package]]
name = "quote"
dependencies = ["proc-macro2 1"]

[[package]]
name = "syn"
dependencies = ["proc-macro2 1", "quote 1", "unicode-ident 1"]

[[package]]
name = "unicode-ident"
dependencies = []

[[package]]
name = "windows-sys"
dependencies = ["windows-targets 1"]

[[package]]
name = "windows-targets"
dependencies = [
 "windows_x86_64_msvc 1",
 "windows_aarch64_pc_windows_msvc 1",
 "windows_i686_msvc 1",
 "windows_x86_64_gnu 1",
]

[[package]]
name = "windows_x86_64_msvc"
dependencies = []

[[package]]
name = "windows_aarch64_pc_windows_msvc"
dependencies = []

[[package]]
name = "windows_i686_msvc"
dependencies = []

[[package]]
name = "windows_x86_64_gnu"
dependencies = []
`;
    expect(runtimeLockCrates(lock, manifest)).toEqual([
      'serde',
      'windows-sys',
      'windows-targets',
      'windows_x86_64_msvc',
    ]);
  });
});
