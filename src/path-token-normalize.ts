/**
 * String-only path normalisation for terminal path tokens (spec 2026-10-16-terminal-path-links
 * §3.2 "Stats"). Browser-safe: no `node:*`, and the platform is injected, never read, so unit
 * tests on ubuntu cover the win32 forms.
 */

export type PathPlatform = 'win32' | 'posix';

export interface NormalizeCtx {
  platform: PathPlatform;
  /** Forward-slashed. */
  homeDir: string;
}

const fold = (p: string): string => p.replace(/\\/g, '/');
const DRIVE_RE = /^([A-Za-z]):(?:\/|$)/;

/** After folding '\' → '/': starts with '//' — UNC (`//host`) and the device namespaces
 *  (`//?/`, `//./`, `\\?\UNC\`). */
export function isUncLike(p: string): boolean {
  return fold(p).startsWith('//');
}

export function isAbsoluteToken(p: string, _platform: PathPlatform): boolean {
  const f = fold(p);
  return f.startsWith('/') || DRIVE_RE.test(f);
}

/** Splits a folded path into its root (`/`, `G:/`, `//host/share`, '' when relative) and the rest. */
function splitRoot(f: string, platform: PathPlatform): { root: string; rest: string } {
  if (f.startsWith('//')) {
    const segs = f.slice(2).split('/');
    const host = segs.shift() ?? '';
    const share = segs.shift() ?? '';
    return { root: `//${host}${share ? `/${share}` : ''}`, rest: segs.join('/') };
  }
  const drive = DRIVE_RE.exec(f);
  if (drive) {
    const letter = platform === 'win32' ? drive[1].toUpperCase() : drive[1];
    return { root: `${letter}:/`, rest: f.slice(drive[0].length) };
  }
  if (f.startsWith('/')) return { root: '/', rest: f.slice(1) };
  return { root: '', rest: f };
}

/** Backslashes → '/', drive letter upper-cased on win32, `.`/`..` resolved without climbing
 *  above the root, duplicate '/' collapsed (a leading UNC '//' kept), trailing '/' dropped
 *  except on a root. */
export function normalizeAbs(p: string, platform: PathPlatform): string {
  const { root, rest } = splitRoot(fold(p), platform);
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!root) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const body = out.join('/');
  if (!root) return body;
  if (root.startsWith('//')) return body ? `${root}/${body}` : root;
  return `${root}${body}`;
}

/** `~` / `~/x` → homeDir[/x]; on win32, MSYS `/x/…` and WSL `/mnt/x/…` → `X:/…`. Returns the
 *  token forward-slashed and NOT yet normalised. */
export function expandToken(raw: string, ctx: NormalizeCtx): string {
  const t = fold(raw);
  if (t === '~') return ctx.homeDir;
  if (t.startsWith('~/')) return `${ctx.homeDir.replace(/\/+$/, '')}/${t.slice(2)}`;
  if (ctx.platform === 'win32') {
    const mapped = /^\/mnt\/([A-Za-z])(\/|$)(.*)$/.exec(t) ?? /^\/([A-Za-z])(\/|$)(.*)$/.exec(t);
    if (mapped) return `${mapped[1].toUpperCase()}:/${mapped[3]}`;
  }
  return t;
}

/** Segment-aware join, then normalizeAbs. An absolute `rel` replaces the base. */
export function joinAbs(base: string, rel: string, platform: PathPlatform): string {
  if (isAbsoluteToken(rel, platform)) return normalizeAbs(rel, platform);
  return normalizeAbs(`${fold(base)}/${fold(rel)}`, platform);
}
