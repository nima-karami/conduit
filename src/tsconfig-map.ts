/**
 * Read a project's `tsconfig.json` and reduce it to the handful of options Monaco's
 * TypeScript worker actually honours. Pure (no fs) so the parsing + path rewriting — the
 * part that decides whether an aliased import resolves at all — is unit-testable.
 *
 * Enum-valued options stay STRINGS here. The host has no business importing monaco, and
 * the numeric enum values differ between TypeScript releases; the renderer maps them
 * against the monaco build it is actually running (see webview/ts-project.ts).
 *
 * See docs/specs/archive/2026-08-07-editor-navigation-parity.md §3c.
 */

/** The subset of compilerOptions we forward to Monaco. */
export interface TsconfigDTO {
  target?: string;
  module?: string;
  moduleResolution?: string;
  jsx?: string;
  /** Absolute, forward-slash directory. Already resolved against the tsconfig's own dir. */
  baseUrl?: string;
  paths?: Record<string, string[]>;
  strict?: boolean;
  allowJs?: boolean;
  checkJs?: boolean;
  esModuleInterop?: boolean;
  allowSyntheticDefaultImports?: boolean;
  resolveJsonModule?: boolean;
  experimentalDecorators?: boolean;
  useDefineForClassFields?: boolean;
  allowImportingTsExtensions?: boolean;
}

/** How deep an `extends` chain is followed before giving up. */
export const MAX_EXTENDS_DEPTH = 3;

/**
 * Strip `//` and block comments and trailing commas so `JSON.parse` accepts a real-world
 * tsconfig. String literals are respected — a `//` inside a path string survives.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  // Trailing commas, now that comments can't hide one.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export interface RawTsconfig {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
}

/** Parse tsconfig text; returns null rather than throwing on malformed input. */
export function parseTsconfig(text: string): RawTsconfig | null {
  try {
    const v = JSON.parse(stripJsonc(text)) as unknown;
    return v && typeof v === 'object' ? (v as RawTsconfig) : null;
  } catch {
    return null;
  }
}

/** Join a POSIX dir with a possibly-relative path, collapsing `.` and `..`. */
export function joinPosix(dir: string, rel: string): string {
  if (/^([a-zA-Z]:)?\//.test(rel)) return normalizePosix(rel);
  return normalizePosix(`${dir}/${rel}`);
}

export function normalizePosix(p: string): string {
  const s = p.replace(/\\/g, '/');
  const drive = /^[a-zA-Z]:/.exec(s)?.[0] ?? '';
  const rest = s.slice(drive.length);
  const absolute = rest.startsWith('/');
  const out: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  return `${drive}${absolute ? '/' : ''}${out.join('/')}`;
}

const STRING_OPTS = ['target', 'module', 'moduleResolution', 'jsx'] as const;
const BOOL_OPTS = [
  'strict',
  'allowJs',
  'checkJs',
  'esModuleInterop',
  'allowSyntheticDefaultImports',
  'resolveJsonModule',
  'experimentalDecorators',
  'useDefineForClassFields',
  'allowImportingTsExtensions',
] as const;

/**
 * Reduce merged compilerOptions to the DTO, resolving `baseUrl` against `configDir`.
 *
 * `paths` without a `baseUrl` is legal since TS 4.4 and resolves against the config's own
 * directory — so baseUrl is defaulted rather than dropped, otherwise every alias in a
 * modern config silently fails to resolve.
 */
export function toTsconfigDTO(
  options: Record<string, unknown> | undefined,
  configDir: string,
): TsconfigDTO {
  const dto: TsconfigDTO = {};
  if (!options) return dto;
  for (const key of STRING_OPTS) {
    const v = options[key];
    if (typeof v === 'string') dto[key] = v;
  }
  for (const key of BOOL_OPTS) {
    const v = options[key];
    if (typeof v === 'boolean') dto[key] = v;
  }
  const paths = options.paths;
  if (paths && typeof paths === 'object') {
    const mapped: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(paths as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const targets = v.filter((t): t is string => typeof t === 'string');
        if (targets.length) mapped[k] = targets;
      }
    }
    if (Object.keys(mapped).length) dto.paths = mapped;
  }
  const baseUrl = options.baseUrl;
  if (typeof baseUrl === 'string') dto.baseUrl = joinPosix(normalizePosix(configDir), baseUrl);
  else if (dto.paths) dto.baseUrl = normalizePosix(configDir);
  return dto;
}

/**
 * Merge an `extends` chain, nearest-wins. `chain` is ordered outermost-first (the file the
 * project actually names, then what it extends, …) — the caller resolves and reads it.
 */
export function mergeCompilerOptions(chain: readonly RawTsconfig[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const cfg of [...chain].reverse()) Object.assign(merged, cfg.compilerOptions ?? {});
  return merged;
}

// Numeric enum values of the TypeScript build bundled inside monaco's language worker.
// They are read off `lib/typescriptServices.js`, NOT off monaco's public
// `languages.typescript.*` enums — those expose only a subset (no Bundler, no NodeNext), and
// the options are passed through to the worker as plain numbers anyway.
export const TS_SCRIPT_TARGET: Record<string, number> = {
  es3: 0,
  es5: 1,
  es6: 2,
  es2015: 2,
  es2016: 3,
  es2017: 4,
  es2018: 5,
  es2019: 6,
  es2020: 7,
  es2021: 8,
  es2022: 9,
  es2023: 10,
  es2024: 11,
  esnext: 99,
  latest: 99,
};

export const TS_MODULE_KIND: Record<string, number> = {
  none: 0,
  commonjs: 1,
  amd: 2,
  umd: 3,
  system: 4,
  es6: 5,
  es2015: 5,
  es2020: 6,
  es2022: 7,
  esnext: 99,
  node16: 100,
  node18: 101,
  node20: 102,
  nodenext: 199,
  preserve: 200,
};

export const TS_MODULE_RESOLUTION: Record<string, number> = {
  classic: 1,
  node: 2,
  nodejs: 2,
  node10: 2,
  node16: 3,
  nodenext: 99,
  bundler: 100,
};

export const TS_JSX: Record<string, number> = {
  none: 0,
  preserve: 1,
  react: 2,
  'react-native': 3,
  'react-jsx': 4,
  'react-jsxdev': 5,
};

/** Structurally what monaco's `CompilerOptions` accepts, without importing monaco here. */
export type CompilerOptionValue = string | number | boolean | string[] | Record<string, string[]>;

/**
 * Options Monaco's TS worker runs with when the project says nothing. `allowNonTsExtensions`
 * is monaco-specific (its file names are URIs, not paths) and must survive any merge.
 */
export const BASE_COMPILER_OPTIONS: Record<string, CompilerOptionValue> = {
  allowJs: true,
  allowNonTsExtensions: true,
  esModuleInterop: true,
  jsx: TS_JSX.react,
  module: TS_MODULE_KIND.esnext,
  moduleResolution: TS_MODULE_RESOLUTION.node,
  target: TS_SCRIPT_TARGET.es2020,
};

/**
 * Merge a project's tsconfig over the baseline, into the shape Monaco's
 * `typescriptDefaults.setCompilerOptions` wants.
 *
 * `toFileUri` maps an absolute forward-slash path to the worker's file-name space. It has to
 * be applied to `baseUrl` — the worker's "paths" are `file:///…` URI strings, so a raw
 * `G:/repo/src` baseUrl would make every alias resolve against a directory that, as far as
 * the worker is concerned, does not exist.
 */
export function toCompilerOptions(
  dto: TsconfigDTO | undefined,
  toFileUri: (posixAbsPath: string) => string,
): Record<string, CompilerOptionValue> {
  const out: Record<string, CompilerOptionValue> = { ...BASE_COMPILER_OPTIONS };
  if (!dto) return out;
  for (const key of BOOL_OPTS) {
    const v = dto[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  const enums: [keyof TsconfigDTO, Record<string, number>][] = [
    ['target', TS_SCRIPT_TARGET],
    ['module', TS_MODULE_KIND],
    ['moduleResolution', TS_MODULE_RESOLUTION],
    ['jsx', TS_JSX],
  ];
  for (const [key, table] of enums) {
    const raw = dto[key];
    if (typeof raw !== 'string') continue;
    const mapped = table[raw.toLowerCase()];
    if (mapped !== undefined) out[key] = mapped;
  }
  if (dto.baseUrl) out.baseUrl = toFileUri(dto.baseUrl);
  if (dto.paths) out.paths = dto.paths;
  // Never let a project's tsconfig turn this off: monaco addresses files by URI, and without
  // it the worker refuses every one of them.
  out.allowNonTsExtensions = true;
  return out;
}
