import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function checkSnippet(body: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
}

describe('tray Cargo target directory', () => {
  it('shares the target across worktrees of one clone and isolates separate clones', () => {
    checkSnippet(`
      import assert from 'node:assert/strict';
      import { join, resolve } from 'node:path';
      import { resolveTrayTargetDir } from './tools/tray-cargo.mjs';
      const main = resolve('test paths', 'main');
      const worktree = resolve('test paths', 'lane');
      const other = resolve('test paths', 'other clone');
      const common = join(main, '.git');
      const target = join(common, 'tray-target');
      assert.equal(resolveTrayTargetDir(main, '.git'), target);
      assert.equal(resolveTrayTargetDir(worktree, '../main/.git'), target);
      assert.equal(resolveTrayTargetDir(worktree, common), target);
      assert.equal(resolveTrayTargetDir(other, '.git'), join(other, '.git', 'tray-target'));
      assert.equal(resolveTrayTargetDir(worktree, common, '../override'),
        join(worktree, 'native', 'override'));
      assert.equal(resolveTrayTargetDir(worktree, common, target), target);
    `);
  });

  it('passes an override to both scripts and copies the release binary from it', () => {
    checkSnippet(`
      import assert from 'node:assert/strict';
      import { join, resolve } from 'node:path';
      import { runTrayCheck } from './tools/tray-check.mjs';
      import { runTrayBuild } from './tools/tray-build.mjs';
      process.env.CARGO_TARGET_DIR = '../override';
      const targetDir = resolve('native', 'override');
      const artifact = join(targetDir, 'x86_64-pc-windows-msvc', 'release', 'conduit-tray.exe');
      const spawn = (cmd, args, opts) => {
        assert.equal(cmd, 'cargo');
        if (args[0] !== '--version') assert.equal(opts.env?.CARGO_TARGET_DIR, targetDir);
        return { status: 0 };
      };
      assert.equal(runTrayCheck(spawn), 0);
      let copied = false;
      assert.equal(runTrayBuild({
        platform: 'win32', spawn,
        stat: (path) => {
          assert.equal(path, artifact);
          return { size: 1024 };
        },
        mkdir: () => {},
        copyFile: (path, destination) => {
          assert.equal(path, artifact);
          assert.equal(destination, join('build/vendor/tray/conduit-tray.exe'));
          copied = true;
        },
      }), 0);
      assert.equal(copied, true);
    `);
  });
});
