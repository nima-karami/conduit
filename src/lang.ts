/** Browser-safe language detection (no Node.js imports). */
const LANG = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  shtml: 'html',
  vue: 'html',
  svelte: 'html',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ksh: 'shell',
  mksh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'dotenv',
  mk: 'makefile',
  mak: 'makefile',
  cmake: 'cmake',
  diff: 'diff',
  patch: 'diff',
  rej: 'diff',
  java: 'java',
  groovy: 'groovy',
  gradle: 'groovy',
  gvy: 'groovy',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  sbt: 'scala',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  ipp: 'cpp',
  inl: 'cpp',
  tpp: 'cpp',
  cu: 'cpp',
  cuh: 'cpp',
  ino: 'cpp',
  // `.m` stays plain: MATLAB/Octave share it (spec 2026-10-08-language-coverage D8).
  mm: 'objective-c',
  cs: 'csharp',
  csx: 'csharp',
  cake: 'csharp',
  cshtml: 'razor',
  razor: 'razor',
  fs: 'fsharp',
  fsx: 'fsharp',
  fsi: 'fsharp',
  fsscript: 'fsharp',
  ml: 'ocaml',
  mli: 'ocaml',
  vb: 'vb',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  ru: 'ruby',
  rbw: 'ruby',
  php: 'php',
  phtml: 'php',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  jl: 'julia',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',
  ex: 'elixir',
  exs: 'elixir',
  sol: 'sol',
  tcl: 'tcl',
  pas: 'pascal',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  hcl: 'hcl',
  tf: 'hcl',
  tfvars: 'hcl',
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  xml: 'xml',
  svg: 'xml',
  xaml: 'xml',
  plist: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  csproj: 'xml',
  fsproj: 'xml',
  vbproj: 'xml',
  props: 'xml',
  targets: 'xml',
  config: 'xml',
  resx: 'xml',
  nuspec: 'xml',
  wxs: 'xml',
  log: 'log',
  coffee: 'coffeescript',
  hbs: 'handlebars',
  handlebars: 'handlebars',
  twig: 'twig',
  pug: 'pug',
  jade: 'pug',
  liquid: 'liquid',
  bicep: 'bicep',
  wgsl: 'wgsl',
  scm: 'scheme',
  ss: 'scheme',
  rkt: 'scheme',
  rst: 'restructuredtext',
  sv: 'systemverilog',
  svh: 'systemverilog',
  v: 'verilog',
  vh: 'verilog',
  tsp: 'typespec',
  cypher: 'cypher',
  cyp: 'cypher',
  pq: 'powerquery',
  pqm: 'powerquery',
  qs: 'qsharp',
  rq: 'sparql',
} as const;

// Extension-less or fixed-name files that still have a known language.
const FILENAME = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
  '.zprofile': 'shell',
  '.zshenv': 'shell',
  '.bash_aliases': 'shell',
  '.bash_logout': 'shell',
  '.envrc': 'shell',
  pkgbuild: 'shell',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  '.swcrc': 'json',
  '.jshintrc': 'json',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.gitattributes': 'ini',
  'tox.ini': 'ini',
  'cargo.lock': 'toml',
  'poetry.lock': 'toml',
  'uv.lock': 'toml',
  pipfile: 'toml',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'makefile.am': 'makefile',
  'makefile.in': 'makefile',
  'cmakelists.txt': 'cmake',
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.npmignore': 'ignore',
  '.prettierignore': 'ignore',
  '.eslintignore': 'ignore',
  '.gcloudignore': 'ignore',
  '.vscodeignore': 'ignore',
  jenkinsfile: 'groovy',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  brewfile: 'ruby',
  guardfile: 'ruby',
  fastfile: 'ruby',
  appfile: 'ruby',
  'go.mod': 'gomod',
  'go.work': 'gomod',
  // Checksum lists: nothing to colour, and `gomod` would mis-paint the hashes.
  'go.sum': 'plaintext',
  'go.work.sum': 'plaintext',
} as const;

export type LanguageId =
  | (typeof LANG)[keyof typeof LANG]
  | (typeof FILENAME)[keyof typeof FILENAME];

const LANG_BY_EXT: Readonly<Record<string, LanguageId>> = LANG;
const LANG_BY_FILENAME: Readonly<Record<string, LanguageId>> = FILENAME;

// Only reached when the extension is not in LANG, so `Makefile.toml` and `.env.json` keep theirs.
const PREFIX_RULES: ReadonlyArray<readonly [string, LanguageId]> = [
  ['dockerfile.', 'dockerfile'],
  ['containerfile.', 'dockerfile'],
  ['.env.', 'dotenv'],
];

// Keys are the interpreter's lowercased basename after `env` and a version suffix are stripped.
const INTERPRETERS: Readonly<Record<string, LanguageId>> = {
  python: 'python',
  python2: 'python',
  python3: 'python',
  pypy: 'python',
  pypy3: 'python',
  uv: 'python',
  uvx: 'python',
  node: 'javascript',
  nodejs: 'javascript',
  bun: 'javascript',
  deno: 'typescript',
  tsx: 'typescript',
  'ts-node': 'typescript',
  sh: 'shell',
  bash: 'shell',
  dash: 'shell',
  ash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  mksh: 'shell',
  fish: 'shell',
  ruby: 'ruby',
  perl: 'perl',
  pwsh: 'powershell',
  powershell: 'powershell',
  php: 'php',
  lua: 'lua',
  luajit: 'lua',
  rscript: 'r',
  julia: 'julia',
  elixir: 'elixir',
  tclsh: 'tcl',
  wish: 'tcl',
  make: 'makefile',
} satisfies Record<string, LanguageId>;

const SHEBANG = /^#!\s*(\S+)(.*)$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_FLAGS_WITH_ARG = new Set(['-u', '-C', '-P', '--unset', '--chdir']);

const GOLDEN = '.golden';
// `app.log.3`, `app.log.2026-10-01_13`; a further `.` (`app.log.1.gz`) is a compressed rotation.
const ROTATED_LOG = /\.log\.(?:\d+|\d{4}-\d{2}-\d{2}[^.]*)$/;

const baseNameLower = (p: string): string => (p.split(/[\\/]/).pop() ?? '').toLowerCase();

/** An expected-output fixture: its bytes are the point (spec 2026-10-08-language-support §2.3). */
export function isGoldenPath(p: string): boolean {
  return baseNameLower(p).endsWith(GOLDEN);
}

function langFromName(name: string): string {
  if (Object.hasOwn(LANG_BY_FILENAME, name)) return LANG_BY_FILENAME[name];
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : '';
  if (Object.hasOwn(LANG_BY_EXT, ext)) return LANG_BY_EXT[ext];
  for (const [prefix, id] of PREFIX_RULES) if (name.startsWith(prefix)) return id;
  return ROTATED_LOG.test(name) ? 'log' : 'plaintext';
}

const nameOf = (p: string): string => {
  const name = baseNameLower(p);
  return name.endsWith(GOLDEN) ? name.slice(0, -GOLDEN.length) : name;
};

export function langFromPath(p: string): string {
  return langFromName(nameOf(p));
}

export const SHEBANG_SNIFF_CHARS = 256;
// Spelled as a code point: source-bytes.test.ts rejects a literal U+FEFF in source.
const BOM = String.fromCharCode(0xfeff);

function envCommand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return args[i + 1] ?? null;
    if (ENV_FLAGS_WITH_ARG.has(arg)) i++;
    else if (!arg.startsWith('-') && !ENV_ASSIGNMENT.test(arg)) return arg;
  }
  return null;
}

function interpreterLang(command: string): LanguageId | null {
  const name = (command.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (Object.hasOwn(INTERPRETERS, name)) return INTERPRETERS[name];
  const stem = name
    .replace(/\.exe$/, '')
    .replace(/-[a-z]+$/, '')
    .replace(/[-.]?[\d.]+$/, '');
  return Object.hasOwn(INTERPRETERS, stem) ? INTERPRETERS[stem] : null;
}

/** Spec 2026-10-08-language-coverage §2.4. */
export function langFromShebang(firstLine: string): LanguageId | null {
  const line = firstLine.startsWith(BOM) ? firstLine.slice(BOM.length) : firstLine;
  const match = SHEBANG.exec(line.replace(/\r$/, ''));
  if (!match) return null;
  const [, command, rest] = match;
  const resolved =
    (command.split(/[\\/]/).pop() ?? '') === 'env' ? envCommand(rest.trim().split(/\s+/)) : command;
  return resolved ? interpreterLang(resolved) : null;
}

/** `langFromPath`, falling back to the shebang only for a plaintext name with no exact-filename
 *  entry (so `go.sum` stays plain). */
export function langFromPathAndText(path: string, text: string): string {
  const name = nameOf(path);
  const lang = langFromName(name);
  if (lang !== 'plaintext' || Object.hasOwn(LANG_BY_FILENAME, name)) return lang;
  const head = text.slice(0, SHEBANG_SNIFF_CHARS);
  const newline = head.indexOf('\n');
  return langFromShebang(newline < 0 ? head : head.slice(0, newline)) ?? 'plaintext';
}

// Typed by LanguageId so a new language in either map fails typecheck until it is named here.
const DISPLAY_NAMES: Record<Exclude<LanguageId, 'plaintext'>, string> = {
  bat: 'Batch',
  bicep: 'Bicep',
  c: 'C',
  clojure: 'Clojure',
  cmake: 'CMake',
  coffeescript: 'CoffeeScript',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  cypher: 'Cypher',
  dart: 'Dart',
  diff: 'Diff',
  dockerfile: 'Dockerfile',
  dotenv: 'Dotenv',
  elixir: 'Elixir',
  fsharp: 'F#',
  go: 'Go',
  gomod: 'Go module',
  graphql: 'GraphQL',
  groovy: 'Groovy',
  handlebars: 'Handlebars',
  hcl: 'HCL',
  html: 'HTML',
  ignore: 'Ignore file',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  julia: 'Julia',
  kotlin: 'Kotlin',
  less: 'Less',
  liquid: 'Liquid',
  log: 'Log',
  lua: 'Lua',
  makefile: 'Makefile',
  markdown: 'Markdown',
  mdx: 'MDX',
  'objective-c': 'Objective-C',
  ocaml: 'OCaml',
  pascal: 'Pascal',
  perl: 'Perl',
  php: 'PHP',
  powerquery: 'Power Query',
  powershell: 'PowerShell',
  proto: 'Protocol Buffers',
  pug: 'Pug',
  python: 'Python',
  qsharp: 'Q#',
  r: 'R',
  razor: 'Razor',
  restructuredtext: 'reStructuredText',
  ruby: 'Ruby',
  rust: 'Rust',
  scala: 'Scala',
  scheme: 'Scheme',
  scss: 'SCSS',
  shell: 'Shell',
  sol: 'Solidity',
  sparql: 'SPARQL',
  sql: 'SQL',
  swift: 'Swift',
  systemverilog: 'SystemVerilog',
  tcl: 'Tcl',
  toml: 'TOML',
  twig: 'Twig',
  typescript: 'TypeScript',
  typespec: 'TypeSpec',
  vb: 'Visual Basic',
  verilog: 'Verilog',
  wgsl: 'WGSL',
  xml: 'XML',
  yaml: 'YAML',
};

const NAME_BY_ID: Readonly<Record<string, string>> = DISPLAY_NAMES;

/** Human name for a Monaco language id, or null for plain text / an id the app never maps. */
export function languageDisplayName(id: string): string | null {
  return Object.hasOwn(NAME_BY_ID, id) ? NAME_BY_ID[id] : null;
}
