// Language-server binary resolution. Pure: every file-system and process touch is injected, and
// the platform is a parameter, so the Windows rules unit-test on the Linux CI runner.
// See docs/specs/2026-09-22-language-server-go.md §3.4.
import type { LanguageServerSpec } from './lsp-registry';

export type HostPlatform = 'win32' | 'darwin' | 'linux';

export interface SearchContext {
  env: Readonly<Record<string, string | undefined>>;
  platform: HostPlatform;
  homedir: string;
  tmpdir: string;
  isFile(p: string): Promise<boolean>;
  realpath(p: string): Promise<string>;
  execFile(
    file: string,
    args: readonly string[],
    opts: { cwd: string; env: Record<string, string | undefined>; timeout: number },
  ): Promise<string>;
}

export interface ResolvedServer {
  binary: string;
  toolDir: string | null;
}

const WIN_ABSOLUTE = /^([a-zA-Z]:[\\/]|\\\\)/;

export function isAbsoluteFor(p: string, platform: HostPlatform): boolean {
  return platform === 'win32' ? WIN_ABSOLUTE.test(p) : p.startsWith('/');
}

export const pathDelimiter = (platform: HostPlatform): string => (platform === 'win32' ? ';' : ':');

/** The key holding `name` in `env` — Windows env keys are case-insensitive (PATH is usually `Path`). */
export function envKey(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: HostPlatform,
): string {
  if (platform !== 'win32') return name;
  return Object.keys(env).find((k) => k.toUpperCase() === name) ?? name;
}

/** Absolute, non-empty PATH entries. A relative entry would resolve against whatever cwd the
 *  lookup runs in — a repo, for a spawned server (ADR 0006 §Trust). */
export function pathDirs(ctx: Pick<SearchContext, 'env' | 'platform'>): string[] {
  const raw = ctx.env[envKey(ctx.env, 'PATH', ctx.platform)] ?? '';
  return raw
    .split(pathDelimiter(ctx.platform))
    .map((d) => d.trim())
    .filter((d) => d !== '' && isAbsoluteFor(d, ctx.platform));
}

export function joinFor(platform: HostPlatform, dir: string, name: string): string {
  const sep = platform === 'win32' ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Windows candidates are `.exe` only: Node refuses to spawn `.cmd`/`.bat` without a shell
 *  (CVE-2024-27980), and a shell is forbidden here. */
export async function findBinary(
  name: string,
  dirs: readonly string[],
  ctx: SearchContext,
): Promise<string | null> {
  const file = ctx.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    const candidate = joinFor(ctx.platform, dir, file);
    if (await ctx.isFile(candidate)) return ctx.realpath(candidate);
  }
  return null;
}

export async function resolveServerBinary(
  spec: LanguageServerSpec,
  ctx: SearchContext,
): Promise<ResolvedServer | null> {
  const toolDir = await spec.resolveToolDir(ctx);
  const dirs = [...pathDirs(ctx), ...(await spec.extraSearchDirs(ctx, toolDir))];
  const binary = await findBinary(spec.binary, dirs, ctx);
  return binary ? { binary, toolDir } : null;
}
