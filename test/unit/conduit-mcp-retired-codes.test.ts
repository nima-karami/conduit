import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Renamed in the flexible-agent-contracts S1 slice (spec §4.7): one error vocabulary, no aliases.
const RETIRED = /\b(unknown_handle|invalid_argument|invalid_input)\b/;
const ROOT = join(__dirname, '..', '..');
const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(name) ? [path] : [];
  });
}

describe('retired error codes', () => {
  it.each(['src', 'webview', 'electron', 'resources', 'test/e2e'])(
    'no %s file uses a retired error code',
    (dir) => {
      const root = join(ROOT, dir);
      if (!existsSync(root)) return;
      const hits = sourceFiles(root)
        .filter((f) => RETIRED.test(readFileSync(f, 'utf8')))
        .map((f) => f.slice(ROOT.length + 1));
      expect(hits).toEqual([]);
    },
  );
});
