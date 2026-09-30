import { describe, expect, it } from 'vitest';
import { quickSteps } from '../../tools/verify-quick.mjs';

describe('quickSteps', () => {
  const o = { files: ['src/a.ts', 'docs/x.md'], base: 'abc123', cwd: 'G:/repo' };

  it('Biome on the changed files, both tsconfigs incrementally, then vitest --changed', () => {
    const steps = quickSteps(o);
    expect(steps.map((s) => s.tool)).toEqual(['biome', 'tsc', 'tsc', 'vitest']);
    expect(steps[0].args).toEqual([
      'check',
      '--no-errors-on-unmatched',
      '--files-ignore-unknown=true',
      'src/a.ts',
      'docs/x.md',
    ]);
    expect(steps[1].args.slice(0, 4)).toEqual(['-p', 'tsconfig.json', '--noEmit', '--incremental']);
    expect(steps[2].args[1]).toBe('tsconfig.webview.json');
    expect(steps[3].args).toEqual(['run', '--changed', 'abc123']);
  });

  it('skips Biome with nothing changed', () => {
    expect(quickSteps({ ...o, files: [] }).map((s) => s.tool)).toEqual(['tsc', 'tsc', 'vitest']);
  });

  it('keeps build info apart per checkout, which may share node_modules through a junction', () => {
    const info = (cwd: string) => quickSteps({ ...o, cwd })[1].args.at(-1);
    expect(info('G:/repo')).not.toBe(info('G:/worktree'));
    expect(info('G:/repo')).toMatch(/verify-quick[\\/]tsconfig\.json-[0-9a-f]{8}\.tsbuildinfo$/);
  });
});
