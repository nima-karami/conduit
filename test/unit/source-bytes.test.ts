import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGit } from '../../src/git-exec';

/**
 * No compiler, linter or test notices a raw NUL, BOM or bidi control in a source file; the
 * repo has shipped green over a literal NUL in a string twice. Every one of these has an
 * escape (`\u0000`, `\uFEFF`, `\x1b`) that says the same thing visibly, so a raw one is always
 * a mistake.
 */

const ROOT = join(__dirname, '..', '..');
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
  '.yml',
  '.yaml',
]);

const FORBIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFFE\uFFFF]/g;

// Tracked files only, so a stray local file never fails it; one missing from the working tree
// is a pending deletion.
async function sourceFiles(): Promise<string[]> {
  const res = await runGit(['ls-files', '-z'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  if (!res.ok) throw new Error(`git ls-files failed: ${res.stderr}`);
  return res.stdout.split('\0').filter((f) => EXTS.has(extname(f)) && existsSync(join(ROOT, f)));
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
    for (const ch of [
      '\u0000',
      '\u001b',
      '\u007f',
      '\uFEFF',
      '\u200B',
      '\u202E',
      '\u2066',
      '\uFFFE',
    ]) {
      expect(forbiddenChars(`a${ch}b`)).toHaveLength(1);
    }
    expect(forbiddenChars('tab\there\r\nnext')).toEqual([]);
  });

  it('finds none in any tracked source or config file', async () => {
    const files = await sourceFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        'src/protocol.ts',
        'types/css.d.ts',
        'esbuild.mjs',
        '.github/workflows/verify.yml',
      ]),
    );
    const offenders: string[] = [];
    for (const file of files) {
      for (const h of forbiddenChars(readFileSync(join(ROOT, file), 'utf8'))) {
        offenders.push(`${file}:${h.line}:${h.col} ${h.code}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
