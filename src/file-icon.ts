/**
 * Pure, browser-safe file-type icon mapping for the Explorer. Maps a file name to a
 * coarse icon KIND (which Lucide glyph the renderer shows) and an accent COLOUR (used
 * by the "colored" icon pack). Side-effect free so the mapping is unit-testable; the
 * React component (webview/file-icons.tsx) turns a kind into a concrete icon.
 */

export type FileIconKind =
  | 'code'
  | 'json'
  | 'markdown'
  | 'style'
  | 'web'
  | 'image'
  | 'shell'
  | 'config'
  | 'doc'
  | 'lock'
  | 'generic';

const EXT_KIND: Record<string, FileIconKind> = {
  // code
  ts: 'code',
  tsx: 'code',
  mts: 'code',
  cts: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  go: 'code',
  rs: 'code',
  py: 'code',
  java: 'code',
  kt: 'code',
  kts: 'code',
  scala: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  fs: 'code',
  vb: 'code',
  rb: 'code',
  php: 'code',
  swift: 'code',
  dart: 'code',
  lua: 'code',
  pl: 'code',
  r: 'code',
  jl: 'code',
  clj: 'code',
  ex: 'code',
  exs: 'code',
  sol: 'code',
  tcl: 'code',
  pas: 'code',
  sql: 'code',
  graphql: 'code',
  gql: 'code',
  proto: 'code',
  // data / config that reads as structured
  json: 'json',
  jsonc: 'json',
  yaml: 'json',
  yml: 'json',
  toml: 'json',
  // docs
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  txt: 'doc',
  pdf: 'doc',
  // styles
  css: 'style',
  scss: 'style',
  less: 'style',
  sass: 'style',
  // markup / web
  html: 'web',
  htm: 'web',
  xml: 'web',
  svg: 'web',
  vue: 'web',
  svelte: 'web',
  astro: 'web',
  // images
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  bmp: 'image',
  // shells / scripts
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'shell',
  psm1: 'shell',
  bat: 'shell',
  cmd: 'shell',
  // config
  ini: 'config',
  cfg: 'config',
  conf: 'config',
  env: 'config',
  properties: 'config',
  lock: 'lock',
};

const FILENAME_KIND: Record<string, FileIconKind> = {
  dockerfile: 'config',
  containerfile: 'config',
  makefile: 'config',
  '.gitignore': 'config',
  '.gitattributes': 'config',
  '.editorconfig': 'config',
  '.npmrc': 'config',
  '.env': 'config',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
};

// Per-extension accent for the "colored" pack (VS Code-ish language hues); falls back
// to the kind colour below.
const EXT_COLOR: Record<string, string> = {
  ts: '#3178c6',
  tsx: '#3178c6',
  mts: '#3178c6',
  cts: '#3178c6',
  js: '#e8d44d',
  jsx: '#e8d44d',
  mjs: '#e8d44d',
  cjs: '#e8d44d',
  json: '#cbcb41',
  jsonc: '#cbcb41',
  go: '#00add8',
  rs: '#dea584',
  py: '#4b8bbe',
  rb: '#cc342d',
  php: '#777bb4',
  java: '#e76f00',
  kt: '#a97bff',
  swift: '#f05138',
  c: '#599eff',
  cpp: '#599eff',
  cs: '#9b4f96',
  html: '#e44d26',
  vue: '#42b883',
  svelte: '#ff3e00',
  md: '#62a0ea',
  sh: '#89d185',
  bash: '#89d185',
};

const KIND_COLOR: Record<FileIconKind, string> = {
  code: '#7aa2f7',
  json: '#cbcb41',
  markdown: '#62a0ea',
  style: '#42a5f5',
  web: '#e44d26',
  image: '#c074d6',
  shell: '#89d185',
  config: '#9aa0a6',
  doc: '#9aa0a6',
  lock: '#d7935b',
  generic: '#8a8f98',
};

function baseName(p: string): string {
  return (p.split(/[\\/]/).pop() ?? '').toLowerCase();
}

function ext(name: string): string {
  return name.includes('.') ? (name.split('.').pop() ?? '') : '';
}

/** The coarse icon kind for a file name. */
export function fileIconKind(name: string): FileIconKind {
  const n = baseName(name);
  if (FILENAME_KIND[n]) return FILENAME_KIND[n];
  return EXT_KIND[ext(n)] ?? 'generic';
}

/** The accent colour for the "colored" icon pack. */
export function fileIconColor(name: string): string {
  const n = baseName(name);
  const byExt = EXT_COLOR[ext(n)];
  return byExt ?? KIND_COLOR[fileIconKind(n)];
}
