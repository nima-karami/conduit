import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quickSteps } from '../../tools/verify-quick.mjs';

const ROOT = join(__dirname, '..', '..');

function read(rel: string) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('tray helper packaging and CI', () => {
  it('maps the vendored tray binary into runtime/tray for Windows installs', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.build.win.extraResources).toContainEqual({
      from: 'build/vendor/tray',
      to: 'runtime/tray',
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

  it('verify workflow runs Rust tray helper checks', () => {
    const yml = read('.github/workflows/verify.yml');
    expect(yml).toContain('Rust tray helper checks');
    expect(yml).toContain('npm run tray:check');
  });

  it('release workflow caches the tray crate and builds before packaging', () => {
    const yml = read('.github/workflows/release.yml');
    expect(yml).toContain('native/tray/target');
    expect(yml).toContain('npm run tray:build');
    expect(yml).toContain('Get-AuthenticodeSignature');
    expect(yml).toContain('runtime\\tray\\conduit-tray.exe');
  });

  it('e2e Windows shards build the tray helper after the app bundle', () => {
    const yml = read('.github/workflows/e2e.yml');
    expect(yml).toContain('native/tray/target');
    expect(yml).toContain('npm run tray:build');
    const buildIdx = yml.indexOf('npm run build');
    const trayIdx = yml.lastIndexOf('npm run tray:build');
    expect(trayIdx).toBeGreaterThan(buildIdx);
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
});
