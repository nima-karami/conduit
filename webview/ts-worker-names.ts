/**
 * Reconciling the two spellings of a file name inside the TypeScript worker.
 *
 * Project sources reach the worker as extraLibs keyed by their URI string (see
 * `webview/ts-project.ts`), so a path segment containing `#`, `?`, `%` or a space arrives
 * percent-escaped — `with%20space`. TypeScript resolves a module by string-joining the
 * *importing* file's name with the RAW specifier out of the source text, which yields
 * `file:///c%3A/…/with space/mod.ts`: the escaped prefix it inherited, the unescaped segment
 * it was handed. That matches no key, `fileExists` says no, and the import silently resolves
 * to its own clause — the "Go to Definition does nothing" of spec 2026-08-21 rows 43/43b.
 *
 * Lives apart from `webview/ts.worker.ts` because that module is a worker ENTRY (it installs
 * `self.onmessage` at import time) and apart from `webview/project-index.ts` because that one
 * pulls in monaco, which has no business in the worker bundle.
 */

/** `file:///c%3A` — the drive marker, which TypeScript never re-spells because it only ever
 *  arrives as part of the importing file's own name. */
const ENCODED_DRIVE = /^file:\/\/\/[a-zA-Z]%3A/i;

/**
 * The spelling TypeScript will ask for, derived from an extraLib key: decoding everything
 * after the drive marker reproduces its string join exactly. A key with nothing to escape
 * decodes to itself.
 */
export function rawForm(key: string): string {
  const head = ENCODED_DRIVE.exec(key)?.[0] ?? '';
  try {
    return head + decodeURIComponent(key.slice(head.length));
  } catch {
    return key; // a lone `%` isn't valid escaping — the key is already its own spelling
  }
}

/**
 * Raw spelling → the extraLib key holding it, for the keys that need one.
 *
 * A key is never aliased onto itself, so on a project with no escaped path the map comes out
 * empty and every lookup stays a plain hit. Real keys win over aliases: a directory literally
 * named `pct%20dir` must not be shadowed by one named `pct dir`.
 */
export function buildFileNameAliases(keys: Iterable<string>): Map<string, string> {
  const aliases = new Map<string, string>();
  const real = new Set<string>();
  for (const key of keys) {
    real.add(key);
    const raw = rawForm(key);
    if (raw !== key) aliases.set(raw, key);
  }
  for (const key of real) aliases.delete(key);
  return aliases;
}
