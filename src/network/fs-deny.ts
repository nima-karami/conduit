// The credential and agent-config stores B never serves, even inside a session's own folders
// (spec 5.3, plan decision 3). Matched on segments, not substrings, so `.sshd_config` or
// `myenv/` are not caught by accident; the lone exception is `.env*`, which is a prefix on the
// basename on purpose (`.env`, `.env.local`, `.env.production`).

// `.git` too: a peer that could read or write it could point the served git reads anywhere, or
// craft objects that show denied content under a harmless name (CON-45 G1 re-review).
const SEGMENT_DENY = new Set(['.ssh', '.gnupg', '.codex', '.cursor', '.git']);
const SEGMENT_PREFIX_DENY = ['.claude'];
const BASENAME_PREFIX_DENY = ['.env'];
/** Consecutive segment runs that deny a path wherever they sit. */
const RUN_DENY: readonly (readonly string[])[] = [
  ['.config', 'opencode'],
  ['appdata', 'roaming', 'microsoft', 'credentials'],
  ['appdata', 'roaming', 'microsoft', 'protect'],
  ['appdata', 'local', 'microsoft', 'credentials'],
];

/** Windows spellings are case-insensitive and use backslashes; POSIX paths are compared as given. */
const isWindowsStyle = (p: string): boolean => /^[a-zA-Z]:/.test(p) || p.includes('\\');

const startsWithRun = (segs: readonly string[], i: number, run: readonly string[]): boolean =>
  run.every((s, k) => segs[i + k] === s);

/** True when an absolute path names a deny-listed entry, lexically. The caller checks the real path too. */
export function isDenied(absPath: string): boolean {
  const windows = isWindowsStyle(absPath);
  const normal = windows ? absPath.replace(/\\/g, '/').toLowerCase() : absPath;
  const segs = normal.split('/').filter((s) => s !== '');
  if (segs.length === 0) return false;
  const basename = segs[segs.length - 1];
  if (BASENAME_PREFIX_DENY.some((p) => basename.startsWith(p))) return true;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (SEGMENT_DENY.has(s)) return true;
    if (SEGMENT_PREFIX_DENY.some((p) => s.startsWith(p))) return true;
    if (RUN_DENY.some((run) => startsWithRun(segs, i, run))) return true;
  }
  return false;
}
