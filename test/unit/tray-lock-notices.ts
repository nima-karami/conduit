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
  const body = manifestTableBody(manifestText, 'build-dependencies');
  if (!body) return new Set();
  const names = new Set<string>();
  for (const line of body.split('\n')) {
    const m = /^(\w[\w-]*)\s*=/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return names;
}

/** Direct `[dependencies]` keys (runtime roots for the lock graph walk). */
export function normalDependencyNames(manifestText: string): string[] {
  const body = manifestTableBody(manifestText, 'dependencies');
  if (!body) return [];
  const names: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^(\w[\w-]*)\s*=/.exec(line.trim());
    if (m) names.push(m[1]);
  }
  return names;
}

function manifestTableBody(manifestText: string, table: string): string | null {
  const head = new RegExp(`^\\[${table}\\]\\s*\\n`, 'm');
  const m = head.exec(manifestText);
  if (!m) return null;
  const rest = manifestText.slice(m.index + m[0].length);
  const nextSection = /^\[/m.exec(rest);
  return nextSection ? rest.slice(0, nextSection.index) : rest;
}

const KNOWN_PROC_MACRO = new Set(['serde_derive', 'proc-macro2', 'quote', 'syn', 'unicode-ident']);

type LockPackage = { name: string; version: string; deps: string[] };

function parseLockPackages(lockText: string): Map<string, LockPackage[]> {
  const byName = new Map<string, LockPackage[]>();
  for (const block of lockText.split('[[package]]')) {
    const nameM = /\nname = "([^"]+)"/.exec(block);
    if (!nameM) continue;
    const versionM = /\nversion = "([^"]+)"/.exec(block);
    const name = nameM[1];
    const version = versionM?.[1] ?? '';
    const deps: string[] = [];
    const depSection = /\ndependencies = \[([\s\S]*?)\]/m.exec(block);
    if (depSection) {
      for (const line of depSection[1].split('\n')) {
        const m = /"([^"]+)"/.exec(line.trim());
        if (m) deps.push(m[1]);
      }
    }
    const list = byName.get(name) ?? [];
    list.push({ name, version, deps });
    byName.set(name, list);
  }
  return byName;
}

function resolveLockPackage(
  ref: string,
  byName: Map<string, LockPackage[]>,
): LockPackage | undefined {
  const [name, ver] = ref.trim().split(/\s+/);
  const list = byName.get(name);
  if (!list?.length) return undefined;
  if (ver) return list.find((p) => p.version === ver) ?? list[0];
  return list[0];
}

function dependencyNameFromRef(ref: string): string {
  return ref.trim().split(/\s+/)[0] ?? ref;
}

/** Shipped Windows target crate for x86_64-pc-windows-msvc (plan P5). */
export function isShippedWindowsTargetCrate(name: string): boolean {
  if (name === 'windows-sys' || name === 'windows-targets' || name === 'windows_x86_64_msvc') {
    return true;
  }
  if (/^windows_[a-z0-9_]+$/.test(name)) return false;
  return true;
}

function skipNoticeCrate(name: string, manifestText: string): boolean {
  if (KNOWN_PROC_MACRO.has(name)) return true;
  if (buildDependencyNames(manifestText).has(name)) return true;
  if (!isShippedWindowsTargetCrate(name)) return true;
  return false;
}

/** Runtime lock packages that must appear in THIRD_PARTY_NOTICES. */
export function runtimeLockCrates(lockText: string, manifestText: string): string[] {
  const root = rootPackageName(manifestText);
  if (!root) throw new Error('Cargo.toml missing [package] name');
  const byName = parseLockPackages(lockText);
  const visited = new Set<string>();
  const queue = [...normalDependencyNames(manifestText)];

  while (queue.length) {
    const name = queue.pop();
    if (!name || name === root || visited.has(name)) continue;
    if (skipNoticeCrate(name, manifestText)) continue;
    visited.add(name);
    const pkg = resolveLockPackage(name, byName);
    if (!pkg) continue;
    for (const depRef of pkg.deps) {
      queue.push(dependencyNameFromRef(depRef));
    }
  }
  return [...visited].sort();
}
