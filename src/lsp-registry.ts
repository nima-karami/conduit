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
  /** Each an exact basename or `*.<ext>` (see `compileRootMarker`). */
  rootMarkers: { workspace: readonly string[]; module: readonly string[] };
  /** No marker from the file up to the workspace root → no server, instead of an ad-hoc root. */
  requiresMarker: boolean;
  watchGlobs: readonly string[];
  /** Dir names whose contents never reach the server's watched-files feed — build output the
   *  server's own project load regenerates would otherwise loop reload → regenerate. */
  watchIgnoreDirs: readonly string[];
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

/** Keeps a value the user set, under whatever case Windows has it in. */
function setUnlessPresent(
  env: Record<string, string | undefined>,
  name: string,
  value: string,
  platform: HostPlatform,
): void {
  const key = envKey(env, name, platform);
  if (!env[key]) env[key] = value;
}

/** `GOTOOLCHAIN=local` unless the user set their own: a repo's `toolchain` directive must not
 *  make opening a file download and run a toolchain (ADR 0006 §Trust). */
function withLocalToolchain(
  env: Record<string, string | undefined>,
  platform: HostPlatform,
): Record<string, string | undefined> {
  setUnlessPresent(env, 'GOTOOLCHAIN', 'local', platform);
  return env;
}

export const GO_SERVER: LanguageServerSpec = {
  languageId: 'go',
  displayName: 'Go',
  binary: 'gopls',
  args: [],
  rootMarkers: { workspace: ['go.work'], module: ['go.mod'] },
  requiresMarker: false,
  watchGlobs: ['**/*.go', '**/go.mod', '**/go.sum', '**/go.work'],
  watchIgnoreDirs: [],
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

const DOTNET_FIXED_DIRS: Readonly<Record<HostPlatform, readonly string[]>> = {
  darwin: ['/usr/local/share/dotnet', '/opt/homebrew/bin'],
  linux: ['/usr/share/dotnet', '/usr/lib/dotnet'],
  win32: ['C:\\Program Files\\dotnet'],
};

export const CSHARP_SERVER: LanguageServerSpec = {
  languageId: 'csharp',
  displayName: 'C#',
  binary: 'csharp-ls',
  args: [],
  rootMarkers: { workspace: ['*.sln', '*.slnx'], module: ['*.csproj'] },
  // see docs/specs/2026-10-08-language-support.md §2.6 (requiresMarker)
  requiresMarker: true,
  watchGlobs: [
    '**/*.cs',
    '**/*.csproj',
    '**/*.sln',
    '**/*.slnx',
    '**/*.props',
    '**/*.targets',
    '**/global.json',
  ],
  watchIgnoreDirs: ['bin', 'obj'],
  installHint: 'dotnet tool install --global csharp-ls',
  runsTools: 'csharp-ls, dotnet / MSBuild (evaluates project files)',

  async resolveToolDir(ctx) {
    const home = ctx.homedir ? [joinFor(ctx.platform, ctx.homedir, '.dotnet')] : [];
    const dotnet = await findBinary(
      'dotnet',
      [...pathDirs(ctx), ...DOTNET_FIXED_DIRS[ctx.platform], ...home],
      ctx,
    );
    // findBinary returns the realpath, so this is the real install dir even behind a PATH
    // symlink (/usr/bin/dotnet, Homebrew) — which is what DOTNET_ROOT must name.
    return dotnet ? dirnameFor(ctx.platform, dotnet) : null;
  },

  async extraSearchDirs(ctx) {
    const { platform, env } = ctx;
    const cliHome = env[envKey(env, 'DOTNET_CLI_HOME', platform)]?.trim() || ctx.homedir;
    if (!cliHome) return [];
    const tools = joinFor(platform, joinFor(platform, cliHome, '.dotnet'), 'tools');
    return isAbsoluteFor(tools, platform) ? [tools] : [];
  },

  childEnv(base, toolDir, platform) {
    const env: Record<string, string | undefined> = { ...base };
    const key = envKey(env, 'PATH', platform);
    const entries = pathDirs({ env: base, platform });
    env[key] = (toolDir ? [toolDir, ...entries] : entries).join(pathDelimiter(platform));
    // A global-tool apphost finds the runtime through DOTNET_ROOT when `dotnet` isn't on PATH.
    if (toolDir) setUnlessPresent(env, 'DOTNET_ROOT', toolDir, platform);
    setUnlessPresent(env, 'DOTNET_CLI_TELEMETRY_OPTOUT', '1', platform);
    return env;
  },
};

export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [GO_SERVER, CSHARP_SERVER];

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
const EXT_MARKER = /^\*\.([^*?/\\[\]{}]+)$/;
const NAME_MARKER = /^[^*?/\\[\]{}]+$/;

/** Supports exactly `**\/*.<ext>` and `**\/<basename>` — every registry glob is one of those, and a
 *  registry test compiles them all so an unsupported shape can't ship silently. */
export function compileWatchGlobs(
  globs: readonly string[],
  ignoreDirs: readonly string[] = [],
): (relPath: string) => boolean {
  const exts: string[] = [];
  const names = new Set<string>();
  for (const g of globs) {
    const ext = EXT_GLOB.exec(g);
    const name = NAME_GLOB.exec(g);
    if (ext) exts.push(`.${ext[1]}`);
    else if (name) names.add(name[1] ?? '');
    else throw new Error(`unsupported watch glob: ${g}`);
  }
  const ignored = new Set(ignoreDirs.map((d) => d.toLowerCase()));
  const lowerExts = exts.map((e) => e.toLowerCase());
  return (relPath) => {
    const dirs = relPath.split(/[\\/]/).slice(0, -1);
    if (dirs.some((d) => ignored.has(d.toLowerCase()))) return false;
    const base = basename(relPath);
    const lower = base.toLowerCase();
    return names.has(base) || lowerExts.some((e) => lower.endsWith(e) && base.length > e.length);
  };
}

/** A root marker is an exact basename (case-sensitive) or `*.<ext>` (case-insensitive, non-empty
 *  stem); any other shape throws, and a registry test compiles every marker. */
export function compileRootMarker(marker: string): (base: string) => boolean {
  const ext = EXT_MARKER.exec(marker);
  if (ext) {
    const suffix = `.${ext[1]}`.toLowerCase();
    return (base) => base.length > suffix.length && base.toLowerCase().endsWith(suffix);
  }
  if (NAME_MARKER.test(marker)) return (base) => base === marker;
  throw new Error(`unsupported root marker: ${marker}`);
}

export const isPatternMarker = (marker: string): boolean => EXT_MARKER.test(marker);

/** Whether a path names any of the spec's root markers. */
export function compileRootMarkers(
  spec: Pick<LanguageServerSpec, 'rootMarkers'>,
): (relPath: string) => boolean {
  const matchers = [...spec.rootMarkers.workspace, ...spec.rootMarkers.module].map(
    compileRootMarker,
  );
  return (relPath) => {
    const base = basename(relPath);
    return matchers.some((m) => m(base));
  };
}
