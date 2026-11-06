import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quickSteps } from '../../tools/verify-quick.mjs';
import { jobSteps, stepIndex } from './gh-workflow-steps';

const ROOT = join(__dirname, '..', '..');

function read(rel: string) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function runIndex(steps: ReturnType<typeof jobSteps>, needle: string | RegExp): number {
  return stepIndex(steps, (s) => {
    const run = s.run ?? '';
    return typeof needle === 'string' ? run.includes(needle) : needle.test(run);
  });
}

describe('tray helper packaging and CI', () => {
  it('maps the vendored tray binary into runtime/tray for Windows installs', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.build.win.extraResources).toContainEqual({
      from: 'build/vendor/tray',
      to: 'runtime/tray',
    });
    expect(pkg.build.win.extraResources).toContainEqual({
      from: 'assets/tray/licenses',
      to: 'licenses/tray',
    });
  });

  it('runs tray:check in verify and tray:build before electron-builder dist', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts.verify).toContain('npm run tray:check');
    expect(scripts.dist).toMatch(/npm run tray:build/);
    expect(scripts.dist.indexOf('tray:build')).toBeLessThan(
      scripts.dist.indexOf('electron-builder'),
    );
  });

  it('verify workflow runs Rust tray helper checks after unit tests', () => {
    const steps = jobSteps(read('.github/workflows/verify.yml'), 'verify');
    const unit = stepIndex(steps, (s) => s.run === 'npm run test:unit');
    const tray = stepIndex(steps, (s) => s.name === 'Rust tray helper checks');
    expect(tray).toBeGreaterThan(-1);
    expect(steps[tray].run).toBe('npm run tray:check');
    expect(tray).toBeGreaterThan(unit);
  });

  it('release workflow builds tray after fetch-runtime and asserts Authenticode after electron-builder', () => {
    const steps = jobSteps(read('.github/workflows/release.yml'), 'build-and-publish');
    const fetch = runIndex(steps, 'node build/fetch-runtime.mjs');
    const tray = runIndex(steps, 'npm run tray:build');
    const builder = runIndex(steps, 'electron-builder');
    const auth = stepIndex(steps, (s) => s.name === 'Assert tray helper Authenticode signature');
    expect(fetch).toBeGreaterThan(-1);
    expect(tray).toBeGreaterThan(fetch);
    expect(builder).toBeGreaterThan(tray);
    expect(auth).toBeGreaterThan(builder);
    const ghCscLink = '$' + '{{ secrets.CSC_LINK }}';
    expect(steps[auth].env?.CSC_LINK).toBe(ghCscLink);
    expect(steps[auth].run).toContain('Get-AuthenticodeSignature');
    expect(steps[auth].run).toContain('$env:CSC_LINK');
    const cache = stepIndex(steps, (s) => (s.uses ?? '').includes('actions/cache'));
    expect(cache).toBeGreaterThan(-1);
    expect(read('.github/workflows/release.yml')).toContain('restore-keys:');
  });

  it('e2e Windows shards build the tray helper after the app bundle', () => {
    const steps = jobSteps(read('.github/workflows/e2e.yml'), 'shard');
    const build = runIndex(steps, 'npm run build');
    const tray = runIndex(steps, 'npm run tray:build');
    expect(build).toBeGreaterThan(-1);
    expect(tray).toBeGreaterThan(build);
    expect(read('.github/workflows/e2e.yml')).toContain('restore-keys:');
  });

  it('ignores native/tray/target in git', () => {
    expect(read('.gitignore')).toMatch(/native\/tray\/target\/?/);
  });

  it('adds tray:check to verify:quick when native/ files changed', () => {
    const steps = quickSteps({
      files: ['native/tray/src/model.rs'],
      base: 'abc',
      cwd: ROOT,
    });
    expect(steps.some((s) => s.name === 'tray:check')).toBe(true);
  });

  it('does not add tray:check to verify:quick when nothing under native/ changed', () => {
    const steps = quickSteps({
      files: ['src/a.ts', 'tools/tray-check.mjs'],
      base: 'abc',
      cwd: ROOT,
    });
    expect(steps.some((s) => s.name === 'tray:check')).toBe(false);
  });
});
