import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No compiler, linter or test notices a raw NUL, BOM or bidi control in a source file 2014 the
 * repo has shipped green over a literal NUL in a string twice. Every one of these has an
 * escape (`\u0000`, `FEFF`, `\x1b`) that says the same thing visibly, so a raw one is always
 * a mistake.
 */

const ROOT = join(__dirname, '..', '..');
const DIRS = ['src', 'webview', 'electron', 'test', 'tools'];
const EXTS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.json',
]);

const FORBIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function* sourceFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (EXTS.has(extname(e.name))) yield p;
  }
}

function forbiddenChars(text: string): { line: number; col: number; code: string }[] {
  const hits: { line: number; col: number; code: string }[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(FORBIDDEN)) {
      const code = (m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      hits.push({ line: i + 1, col: (m.index ?? 0) + 1, code: `U+${code}` });
    }
  });
  return hits;
}

describe('source files carry no invisible or control characters', () => {
  it('detects each forbidden class', () => {
    for (const ch of ['\u0000', '\u001b', '\u007f', '\uFEFF', '\u200B', '\u202E', '\u2066']) {
      expect(forbiddenChars(`a${ch}b`)).toHaveLength(1);
    }
    expect(forbiddenChars('tab\there\r\nnext')).toEqual([]);
  });

  it('finds none in src, webview, electron, test and tools', () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const h of forbiddenChars(readFileSync(file, 'utf8'))) {
          offenders.push(
            `${relative(ROOT, file).replace(/\\/g, '/')}:${h.line}:${h.col} ${h.code}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
