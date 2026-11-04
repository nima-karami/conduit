import { readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..', '..');
const ENTRY = join(REPO, 'server', 'attention', 'index.ts');
const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
// A TS source may name its sibling by the emitted extension (`./x.js` is `./x.ts` on disk).
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const FORBIDDEN = [
  /^(node:)?(fs|child_process)(\/|$)/,
  /^chokidar(\/|$)/,
  /watch-dir|git-exec|project-watcher/,
];

const Q = `['"\`]`;
const SPEC = `([^'"\`]+)`;
const FORMS: { re: RegExp; typeGroup?: number; specGroup: number }[] = [
  // `import … from 'x'` / `export … from 'x'`; `[^'";]` keeps a match inside one statement.
  {
    re: new RegExp(`\\b(?:import|export)\\s+(type\\s+)?[^'";]*?\\bfrom\\s*${Q}${SPEC}${Q}`, 'g'),
    typeGroup: 1,
    specGroup: 2,
  },
  { re: new RegExp(`(?:^|[;\\s])import\\s*${Q}${SPEC}${Q}`, 'gm'), specGroup: 1 },
  { re: new RegExp(`\\bimport\\s*\\(\\s*${Q}${SPEC}${Q}`, 'g'), specGroup: 1 },
  { re: new RegExp(`\\brequire\\s*\\(\\s*${Q}${SPEC}${Q}`, 'g'), specGroup: 1 },
];

/** Every module specifier the source loads at runtime; `import type` / `export type` are erased. */
function runtimeSpecifiers(source: string): string[] {
  const out = new Set<string>();
  for (const { re, typeGroup, specGroup } of FORMS) {
    for (const m of source.matchAll(re)) {
      if (typeGroup !== undefined && m[typeGroup]) continue;
      out.add(m[specGroup].trim());
    }
  }
  return [...out];
}

const isForbidden = (spec: string) => FORBIDDEN.some((re) => re.test(spec.toLowerCase()));

function onDisk(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function resolveRelative(fromFile: string, spec: string, exists: (f: string) => boolean) {
  const base = resolve(dirname(fromFile), spec);
  const ext = extname(base);
  const swapped = (JS_TO_TS[ext] ?? []).map((ts) => base.slice(0, -ext.length) + ts);
  const candidates = [
    ...swapped,
    base,
    ...TS_EXTS.map((e) => base + e),
    ...TS_EXTS.map((e) => join(base, `index${e}`)),
  ];
  return candidates.find(exists) ?? null;
}

/** Walk the relative-import closure from `entry`; collect every forbidden or unresolvable edge. */
function walk(entry: string, read: (file: string) => string, exists: (file: string) => boolean) {
  const queue = [entry];
  const seen = new Set<string>();
  const violations: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeSpecifiers(read(file))) {
      if (isForbidden(spec)) {
        violations.push(`${file} -> ${spec}`);
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const next = resolveRelative(file, spec, exists);
      // An edge the walk cannot follow would hide whatever sits behind it.
      if (next) queue.push(next);
      else violations.push(`${file} -> ${spec} (unresolved)`);
    }
  }
  return { violations, reached: [...seen] };
}

describe('attention import closure guard', () => {
  it('the scanner flags every runtime import form and skips type-only ones', () => {
    const flagged = [
      `import { readFileSync } from 'node:fs';`,
      `import * as fs from "fs";`,
      `import fsp from 'node:fs/promises';`,
      `import 'node:child_process';`,
      `;import "chokidar"`,
      `export { watch } from 'fs';`,
      `export * from '../electron/watch-dir';`,
      `const cp = await import('child_process');`,
      'const p = import(`node:fs/promises`);',
      `const g = require('../src/git-exec');`,
      `import {\n  a,\n  b,\n} from '../electron/project-watcher';`,
      `import x, { type Y } from 'fs';`,
    ];
    for (const src of flagged) {
      const specs = runtimeSpecifiers(src);
      expect(specs.some(isForbidden), `not flagged: ${src} → ${JSON.stringify(specs)}`).toBe(true);
    }
    const clean = [
      `import type { Stats } from 'node:fs';`,
      `export type { Stats } from 'fs';`,
      `import { a } from './fs-free';`,
      `import { b } from 'fsevents';`,
      `const s = 'import fs';`,
    ];
    for (const src of clean) {
      expect(runtimeSpecifiers(src).filter(isForbidden), src).toEqual([]);
    }
  });

  it('the walk follows `.js`-suffixed and re-exported relative specifiers to their `.ts` sources', () => {
    const root = resolve('/virtual');
    const files: Record<string, string> = {
      [join(root, 'entry.ts')]: `import { a } from './a.js';`,
      [join(root, 'a.ts')]: `export * from './deep/index.js';`,
      [join(root, 'deep', 'index.ts')]: `export { b } from './b';`,
      [join(root, 'deep', 'b.ts')]: `import 'node:fs';`,
    };
    const read = (f: string) => files[f];
    expect(walk(join(root, 'entry.ts'), read, (f) => f in files).violations).toEqual([
      `${join(root, 'deep', 'b.ts')} -> node:fs`,
    ]);
    expect(
      walk(join(root, 'entry.ts'), read, (f) => f in files && !f.endsWith('b.ts')).violations,
    ).toEqual([`${join(root, 'deep', 'index.ts')} -> ./b (unresolved)`]);
  });

  it('the attention engine reaches no file-system or git module', () => {
    const { violations, reached } = walk(ENTRY, (f) => readFileSync(f, 'utf8'), onDisk);
    // An empty violation list proves nothing unless the walk left the entry.
    expect(reached).toContain(join(REPO, 'src', 'session-activity.ts'));
    expect(violations).toEqual([]);
  });
});
