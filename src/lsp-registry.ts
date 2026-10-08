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

/** Heavy servers index the whole project in memory; see spec 2026-10-08-language-coverage §2.6. */
export type ServerWeight = 'light' | 'heavy';

export interface LanguageServerSpec {
  /** `[0]` keys records, statuses, the absent TTL and restart; any id routes a doc here. */
  languageIds: readonly [string, ...string[]];
  displayName: string;
  weight: ServerWeight;
  binary: string;
  /** Searched in order when `binary` is not found; user-facing copy still names `binary`. */
  altBinaries?: readonly string[];
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
  /** Sent as `initialize.initializationOptions` when set. */
  initializationOptions?: unknown;
  /** Answers `workspace/configuration` items by exact `section`; anything else gets null. */
  settings?: Readonly<Record<string, unknown>>;
  /** Run at resolve (tmpdir cwd); a failure means the server is absent — a proxy binary can
   *  exist without the tool behind it. */
  versionProbe?: readonly string[];
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

/** A copy of `base` whose PATH holds only absolute entries, `toolDir` first. The server's cwd is
 *  the repo, so a relative entry would let it run a repo-local tool (ADR 0006 §Trust). */
function serverEnv(
  base: Readonly<Record<string, string | undefined>>,
  toolDir: string | null,
  platform: HostPlatform,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  const key = envKey(env, 'PATH', platform);
  const entries = pathDirs({ env: base, platform });
  env[key] = (toolDir ? [toolDir, ...entries] : entries).join(pathDelimiter(platform));
  return env;
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
  languageIds: ['go'],
  displayName: 'Go',
  weight: 'light',
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
    return go ? dirnameFor(ctx.platform, go.realPath) : null;
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
    return withLocalToolchain(serverEnv(base, toolDir, platform), platform);
  },
};

const DOTNET_FIXED_DIRS: Readonly<Record<HostPlatform, readonly string[]>> = {
  darwin: ['/usr/local/share/dotnet', '/opt/homebrew/bin'],
  linux: ['/usr/share/dotnet', '/usr/lib/dotnet'],
  win32: ['C:\\Program Files\\dotnet'],
};

export const CSHARP_SERVER: LanguageServerSpec = {
  languageIds: ['csharp'],
  displayName: 'C#',
  weight: 'heavy',
  binary: 'csharp-ls',
  args: [],
  rootMarkers: { workspace: ['*.sln', '*.slnx'], module: ['*.csproj'] },
  // see docs/specs/archive/2026-10-08-language-support.md §2.6 (requiresMarker)
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
    // The realpath's dir is the real install dir even behind a PATH symlink (/usr/bin/dotnet,
    // Homebrew) — which is what DOTNET_ROOT must name.
    return dotnet ? dirnameFor(ctx.platform, dotnet.realPath) : null;
  },

  async extraSearchDirs(ctx) {
    const { platform, env } = ctx;
    const cliHome = env[envKey(env, 'DOTNET_CLI_HOME', platform)]?.trim() || ctx.homedir;
    if (!cliHome) return [];
    const tools = joinFor(platform, joinFor(platform, cliHome, '.dotnet'), 'tools');
    return isAbsoluteFor(tools, platform) ? [tools] : [];
  },

  childEnv(base, toolDir, platform) {
    const env = serverEnv(base, toolDir, platform);
    // A global-tool apphost finds the runtime through DOTNET_ROOT when `dotnet` isn't on PATH.
    if (toolDir) setUnlessPresent(env, 'DOTNET_ROOT', toolDir, platform);
    setUnlessPresent(env, 'DOTNET_CLI_TELEMETRY_OPTOUT', '1', platform);
    return env;
  },
};

// see spec 2026-10-08-language-coverage §2.5 for every value below
const PY_ANALYSIS = { typeCheckingMode: 'off', diagnosticMode: 'openFilesOnly' };

export const PYTHON_SERVER: LanguageServerSpec = {
  languageIds: ['python'],
  displayName: 'Python',
  weight: 'light',
  binary: 'basedpyright-langserver',
  altBinaries: ['pyright-langserver'],
  args: ['--stdio'],
  rootMarkers: {
    workspace: ['pyrightconfig.json'],
    module: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
  },
  requiresMarker: false,
  watchGlobs: ['**/*.py', '**/*.pyi', '**/pyproject.toml', '**/pyrightconfig.json', '**/setup.cfg'],
  watchIgnoreDirs: [
    '.venv',
    'venv',
    '__pycache__',
    '.tox',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
  ],
  installHint: 'pip install basedpyright',
  runsTools: "basedpyright, python (reads the interpreter's import paths)",
  settings: { 'basedpyright.analysis': PY_ANALYSIS, 'python.analysis': PY_ANALYSIS },

  async resolveToolDir() {
    return null;
  },

  async extraSearchDirs(ctx) {
    if (!ctx.homedir) return [];
    const local = joinFor(ctx.platform, joinFor(ctx.platform, ctx.homedir, '.local'), 'bin');
    return isAbsoluteFor(local, ctx.platform) ? [local] : [];
  },

  childEnv(base, toolDir, platform) {
    return serverEnv(base, toolDir, platform);
  },
};

const cargoBins = (ctx: SearchContext): string[] => {
  const { platform, env } = ctx;
  const dirs: string[] = [];
  const cargoHome = env[envKey(env, 'CARGO_HOME', platform)]?.trim();
  if (cargoHome) dirs.push(joinFor(platform, cargoHome, 'bin'));
  if (ctx.homedir) dirs.push(joinFor(platform, joinFor(platform, ctx.homedir, '.cargo'), 'bin'));
  return [...new Set(dirs.filter((d) => isAbsoluteFor(d, platform)))];
};

export const RUST_SERVER: LanguageServerSpec = {
  languageIds: ['rust'],
  displayName: 'Rust',
  weight: 'heavy',
  binary: 'rust-analyzer',
  args: [],
  rootMarkers: { workspace: ['Cargo.lock'], module: ['Cargo.toml'] },
  requiresMarker: true,
  watchGlobs: ['**/*.rs', '**/Cargo.toml', '**/Cargo.lock', '**/rust-toolchain.toml'],
  watchIgnoreDirs: ['target'],
  installHint: 'rustup component add rust-analyzer',
  runsTools: 'rust-analyzer, cargo metadata, build scripts and proc-macros',
  initializationOptions: { checkOnSave: false },
  settings: { 'rust-analyzer': { checkOnSave: false } },
  versionProbe: ['--version'],

  async resolveToolDir(ctx) {
    const cargo = await findBinary('cargo', [...pathDirs(ctx), ...cargoBins(ctx)], ctx);
    // `.path`, not `.realPath`: rustup's argv0 dispatch (spec §2.5 toolDir row).
    return cargo ? dirnameFor(ctx.platform, cargo.path) : null;
  },

  async extraSearchDirs(ctx) {
    return cargoBins(ctx);
  },

  childEnv(base, toolDir, platform) {
    const env = serverEnv(base, toolDir, platform);
    setUnlessPresent(env, 'RUSTUP_AUTO_INSTALL', '0', platform);
    return env;
  },
};

const LLVM_FIXED_DIRS: Readonly<Record<'darwin' | 'linux', readonly string[]>> = {
  darwin: [
    '/opt/homebrew/opt/llvm/bin',
    '/usr/local/opt/llvm/bin',
    '/Library/Developer/CommandLineTools/usr/bin',
  ],
  linux: [],
};

export const CLANGD_SERVER: LanguageServerSpec = {
  languageIds: ['cpp', 'c'],
  displayName: 'C/C++',
  weight: 'heavy',
  binary: 'clangd',
  args: ['--background-index', '-j=2', '--header-insertion=never'],
  rootMarkers: {
    workspace: ['compile_commands.json', 'compile_flags.txt', '.clangd'],
    module: ['CMakeLists.txt', 'meson.build', 'Makefile'],
  },
  requiresMarker: false,
  watchGlobs: [
    ...['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ipp', 'inl', 'cu', 'cuh'].map(
      (ext) => `**/*.${ext}`,
    ),
    '**/compile_commands.json',
    '**/compile_flags.txt',
    '**/.clangd',
  ],
  watchIgnoreDirs: ['CMakeFiles'],
  installHint: 'winget install LLVM.LLVM',
  runsTools: 'clangd (reads compile_commands.json; writes .cache/clangd)',

  async resolveToolDir() {
    return null;
  },

  async extraSearchDirs(ctx) {
    const { platform, env } = ctx;
    if (platform !== 'win32') return [...LLVM_FIXED_DIRS[platform]];
    // From %ProgramFiles% rather than a literal C:\, so a non-C: install is found too.
    const programFiles = env[envKey(env, 'PROGRAMFILES', platform)]?.trim();
    if (!programFiles || !isAbsoluteFor(programFiles, platform)) return [];
    return [joinFor(platform, programFiles, 'LLVM\\bin')];
  },

  childEnv(base, toolDir, platform) {
    return serverEnv(base, toolDir, platform);
  },
};

export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [
  GO_SERVER,
  CSHARP_SERVER,
  PYTHON_SERVER,
  RUST_SERVER,
  CLANGD_SERVER,
];

export const primaryLanguageId = (spec: Pick<LanguageServerSpec, 'languageIds'>): string =>
  spec.languageIds[0];

export function serverSpecFor(
  languageId: string,
  registry: readonly LanguageServerSpec[] = LANGUAGE_SERVERS,
): LanguageServerSpec | null {
  return registry.find((s) => s.languageIds.includes(languageId)) ?? null;
}

export function languageInfo(spec: LanguageServerSpec): LspLanguageInfo {
  return {
    languageId: primaryLanguageId(spec),
    languageIds: [...spec.languageIds],
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
