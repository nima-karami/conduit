import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The e2e harness owns two choke points (spec docs/specs/2026-09-29-remote-e2e-lean-loop.md §A′,
 * §3): `launchElectron` is the only launch, because the local single-instance lock, the priority
 * drop and CI tracing hang off it; `finishScenario` is the only exit, because a bare
 * `process.exit` skips failure capture. A scenario that bypasses either still passes every
 * scenario-level check, so only this guard notices.
 */

const E2E = join(__dirname, '..', 'e2e');

function mjsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? mjsFiles(join(dir, d.name))
      : d.name.endsWith('.mjs')
        ? [join(dir, d.name)]
        : [],
  );
}

const rel = (f: string) => relative(E2E, f).replace(/\\/g, '/');

describe('e2e harness choke points', () => {
  it('nothing but harness.mjs launches Electron through Playwright', () => {
    const offenders = mjsFiles(E2E)
      .filter((f) => rel(f) !== 'harness.mjs')
      .filter((f) => /electron\.launch\s*\(/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('scenarios exit only through finishScenario', () => {
    const scenarioPaths = mjsFiles(E2E).filter(
      (f) => /^[^/]+\.e2e\.mjs$/.test(rel(f)) || rel(f) === 'auto-save-helpers.mjs',
    );
    expect(scenarioPaths.length).toBeGreaterThan(100);
    const offenders = scenarioPaths
      .filter((f) => /\bprocess\.exit\s*\(/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
