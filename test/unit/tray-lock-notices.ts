/**
 * P5 lock parsing for tray THIRD_PARTY notices (plan 2026-11-03-tray-helper §P5).
 */

/** Every `[[package]]` name in a Cargo.lock file. */
export function packageNamesFromLock(lockText: string): string[] {
  const names: string[] = [];
  for (const block of lockText.split('[[package]]')) {
    const m = /\nname = "([^"]+)"/.exec(block);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Root package name from Cargo.toml `[package]` table. */
export function rootPackageName(manifestText: string): string | null {
  const m = /^\[package\][^[]*?\nname = "([^"]+)"/ms.exec(manifestText);
  return m?.[1] ?? null;
}

/** Direct `[build-dependencies]` keys (build-only; not shipped in the exe). */
export function buildDependencyNames(manifestText: string): Set<string> {
  const section = /^\[build-dependencies\]\s*\n([\s\S]*?)(?=^\[|\s*$)/m.exec(manifestText);
  if (!section) return new Set();
  const names = new Set<string>();
  for (const line of section[1].split('\n')) {
    const m = /^(\w[\w-]*)\s*=/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return names;
}

/** Runtime lock packages that must appear in THIRD_PARTY_NOTICES. */
export function runtimeLockCrates(lockText: string, manifestText: string): string[] {
  const root = rootPackageName(manifestText);
  if (!root) throw new Error('Cargo.toml missing [package] name');
  const buildOnly = buildDependencyNames(manifestText);
  return packageNamesFromLock(lockText)
    .filter((n) => n !== root && !buildOnly.has(n))
    .sort();
}
