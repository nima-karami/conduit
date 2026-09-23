// The code-defined language-server registry. Never read from a workspace: no repo file can name
// a binary, args or env (ADR 0006 §Trust). Nothing downstream of this file special-cases a
// language — see docs/specs/2026-09-22-language-server-go.md §3.1.
import { posix, win32 } from 'node:path';
import {
  envKey,
  findBinary,
  type HostPlatform,
  isAbsoluteFor,
  joinFor,
  pathDelimiter,
  pathDirs,
  type SearchContext,
} from './lsp-binary';
import type { LspLanguageInfo } from './lsp-protocol';

export interface LanguageServerSpec {
  languageId: string;
  displayName: string;
  binary: string;
  args: readonly string[];
  rootMarkers: { workspace: readonly string[]; module: readonly string[] };
  watchGlobs: readonly string[];
  installHint: string;
  /** What starting it runs in the project, for the Workspace Trust prompt's one-line why. */
  runsTools: string;
  /** Directory of the toolchain the server needs on its PATH, or null. */
  resolveToolDir(ctx: SearchContext): Promise<string | null>;
  /** Dirs searched after PATH. */
  extraSearchDirs(ctx: SearchContext, toolDir: string | null): Promise<string[]>;
  /** The server's env — a copy of `base`; never mutates it. */
  childEnv(
    base: Readonly<Record<string, string | undefined>>,
    toolDir: string | null,
    platform: HostPlatform,
  ): Record<string, string | undefined>;
}

export const GO_FIXED_DIRS: Readonly<Record<HostPlatform, readonly string[]>> = {
  darwin: ['/usr/local/go/bin', '/opt/homebrew/bin'],
  linux: ['/usr/local/go/bin'],
  win32: ['C:\\Program Files\\Go\\bin'],
};

const GO_ENV_TIMEOUT_MS = 5_000;

const dirnameFor = (platform: HostPlatform, p: string): string =>
  (platform === 'win32' ? win32 : posix).dirname(p);

const goExe = (platform: HostPlatform): string => (platform === 'win32' ? 'go.exe' : 'go');

/** `GOTOOLCHAIN=local` unless the user set their own: a repo's `toolchain` directive must not
 *  make opening a file download and run a toolchain (ADR 0006 §Trust). */
function withLocalToolchain(
  env: Record<string, string | undefined>,
  platform: HostPlatform,
): Record<string, string | undefined> {
  const key = envKey(env, 'GOTOOLCHAIN', platform);
  if (!env[key]) env[key] = 'local';
  return env;
}

export const GO_SERVER: LanguageServerSpec = {
  languageId: 'go',
  displayName: 'Go',
  binary: 'gopls',
  args: [],
  rootMarkers: { workspace: ['go.work'], module: ['go.mod'] },
  watchGlobs: ['**/*.go', '**/go.mod', '**/go.sum', '**/go.work'],
  installHint: 'go install golang.org/x/tools/gopls@latest',
  runsTools: 'gopls, go list',

  async resolveToolDir(ctx) {
    const go = await findBinary('go', [...pathDirs(ctx), ...GO_FIXED_DIRS[ctx.platform]], ctx);
    return go ? dirnameFor(ctx.platform, go) : null;
  },

  async extraSearchDirs(ctx, toolDir) {
    const { platform, env } = ctx;
    const bin = (d: string) => joinFor(platform, d, 'bin');
    const gopathBins = (v: string | undefined) =>
      (v ?? '')
        .split(pathDelimiter(platform))
        .map((d) => d.trim())
        .filter(Boolean)
        .map(bin);
    const dirs: string[] = [];
    const gobin = env[envKey(env, 'GOBIN', platform)]?.trim();
    if (gobin) dirs.push(gobin);
    dirs.push(...gopathBins(env[envKey(env, 'GOPATH', platform)]));
    if (toolDir) {
      try {
        const out = await ctx.execFile(
          joinFor(platform, toolDir, goExe(platform)),
          ['env', 'GOPATH'],
          {
            cwd: ctx.tmpdir,
            env: withLocalToolchain({ ...env }, platform),
            timeout: GO_ENV_TIMEOUT_MS,
          },
        );
        dirs.push(...gopathBins(out));
      } catch {
        // `go env` is one hint among several; the remaining dirs are still searched.
      }
    }
    if (ctx.homedir) dirs.push(joinFor(platform, joinFor(platform, ctx.homedir, 'go'), 'bin'));
    return [...new Set(dirs.filter((d) => isAbsoluteFor(d, platform)))];
  },

  childEnv(base, toolDir, platform) {
    const env: Record<string, string | undefined> = { ...base };
    const key = envKey(env, 'PATH', platform);
    const entries = pathDirs({ env: base, platform });
    env[key] = (toolDir ? [toolDir, ...entries] : entries).join(pathDelimiter(platform));
    return withLocalToolchain(env, platform);
  },
};

export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [GO_SERVER];

export function serverSpecFor(
  languageId: string,
  registry: readonly LanguageServerSpec[] = LANGUAGE_SERVERS,
): LanguageServerSpec | null {
  return registry.find((s) => s.languageId === languageId) ?? null;
}

export function languageInfo(spec: LanguageServerSpec): LspLanguageInfo {
  return {
    languageId: spec.languageId,
    displayName: spec.displayName,
    binary: spec.binary,
    installHint: spec.installHint,
    moduleMarker: spec.rootMarkers.module[0] ?? '',
  };
}

const basename = (rel: string): string =>
  rel.slice(Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\')) + 1);

const EXT_GLOB = /^\*\*\/\*\.([^*?/\\[\]{}]+)$/;
const NAME_GLOB = /^\*\*\/([^*?/\\[\]{}]+)$/;

/** Supports exactly `**\/*.<ext>` and `**\/<basename>` — every registry glob is one of those, and a
 *  registry test compiles them all so an unsupported shape can't ship silently. */
export function compileWatchGlobs(globs: readonly string[]): (relPath: string) => boolean {
  const exts: string[] = [];
  const names = new Set<string>();
  for (const g of globs) {
    const ext = EXT_GLOB.exec(g);
    const name = NAME_GLOB.exec(g);
    if (ext) exts.push(`.${ext[1]}`);
    else if (name) names.add(name[1] ?? '');
    else throw new Error(`unsupported watch glob: ${g}`);
  }
  return (relPath) => {
    const base = basename(relPath);
    return names.has(base) || exts.some((e) => base.endsWith(e) && base.length > e.length);
  };
}

export function isRootMarker(
  spec: Pick<LanguageServerSpec, 'rootMarkers'>,
  relPath: string,
): boolean {
  const base = basename(relPath);
  return spec.rootMarkers.workspace.includes(base) || spec.rootMarkers.module.includes(base);
}
