import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreStartEnv } from '../../src/contracts/session-identity';

/**
 * herdr-core 0.1.16 reaches the network only through `hc update`, `hc machine add|update` and
 * `--on <machine>` (release server and the user's own ssh hosts; audit 2026-11-02). Conduit must
 * never run them, so hc stays offline under Conduit.
 */
const ROOT = join(__dirname, '..', '..');
const DIRS = ['server', 'src', 'electron'];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'contracts' ? [] : sources(p);
    return /\.(ts|tsx|mjs|cjs|js)$/.test(d.name) ? [p] : [];
  });
}

describe('hc stays offline under Conduit', () => {
  it('no code runs hc update, hc machine or --on', () => {
    const offenders: string[] = [];
    for (const dir of DIRS)
      for (const file of sources(join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        // An hc argv starts with its subcommand: ['update', …] / ['machine', …].
        if (/\[\s*['"`](update|machine)['"`]/.test(text))
          offenders.push(`${relative(ROOT, file)}: update/machine argv`);
        if (/['"`]--on['"`]/.test(text)) offenders.push(`${relative(ROOT, file)}: --on`);
        if (/['"`]machine\.[a-z]+['"`]/.test(text))
          offenders.push(`${relative(ROOT, file)}: machine.* RPC`);
      }
    expect(offenders).toEqual([]);
  });

  it('the core never inherits a release-server override', () => {
    const names = { hcSession: 'conduit-x', hcConfigHome: '/c', hcStateHome: '/s' };
    const env = coreStartEnv(
      { PATH: '/bin', HERDR_RELEASES_URL: 'https://evil.example' },
      names,
      false,
    );
    expect(env).not.toHaveProperty('HERDR_RELEASES_URL');
  });
});
