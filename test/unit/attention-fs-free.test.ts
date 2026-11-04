import { readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..', '..');
const ENTRY = join(REPO, 'server', 'attention', 'index.ts');
const PROBE_EXTS = ['.ts', '.tsx', '.mts', '.cts'];

const IMPORT_RE =
  /\bimport\s+(type\s+)?[\s\S]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[^\w$])import\s*['"]([^'"]+)['"]/gm;

function scanRuntimeImports(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  IMPORT_RE.lastIndex = 0;
  let m = IMPORT_RE.exec(source);
  while (m) {
    const isTypeOnly = !!m[1];
    const spec = (m[2] ?? m[3] ?? '').trim();
    if (!isTypeOnly && spec && !seen.has(spec)) {
      seen.add(spec);
      out.push(spec);
    }
    m = IMPORT_RE.exec(source);
  }
  return out;
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const exact = extname(base) ? [base] : [];
  const probes = extname(base) ? [] : PROBE_EXTS.map((ext) => `${base}${ext}`);
  const index = extname(base) ? [] : PROBE_EXTS.map((ext) => join(base, `index${ext}`));
  for (const candidate of [...exact, ...probes, ...index]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // Keep probing.
    }
  }
  return null;
}

describe('attention import closure guard', () => {
  it('the attention engine reaches no file-system or git module', () => {
    const queue = [ENTRY];
    const seen = new Set<string>();
    const violations: string[] = [];
    while (queue.length > 0) {
      const file = queue.shift();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const spec of scanRuntimeImports(source)) {
        const lower = spec.toLowerCase();
        if (
          lower === 'node:fs' ||
          lower === 'fs' ||
          lower === 'node:child_process' ||
          lower === 'child_process' ||
          lower === 'chokidar' ||
          /watch-dir|git-exec|project-watcher/.test(lower)
        ) {
          violations.push(`${file} -> ${spec}`);
          continue;
        }
        const next = resolveImport(file, spec);
        if (next) queue.push(next);
      }
    }
    expect(violations).toEqual([]);
  });
});
