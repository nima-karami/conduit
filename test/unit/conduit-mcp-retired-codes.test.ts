import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Renamed in the flexible-agent-contracts S1 slice (spec §4.7): one error vocabulary, no aliases.
const RETIRED = /\b(unknown_handle|invalid_argument|invalid_input)\b/;
const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('retired error codes', () => {
  it.each(['src', 'webview'])('no %s file uses a retired error code', (dir) => {
    const hits = sourceFiles(join(ROOT, dir))
      .filter((f) => RETIRED.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1));
    expect(hits).toEqual([]);
  });
});
