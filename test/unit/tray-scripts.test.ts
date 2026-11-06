import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function runSnippet(body: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('tray-check.mjs', () => {
  it('runs fmt, clippy host, clippy msvc, then test in native/tray cwd', () => {
    const r = runSnippet(`
      import { runTrayCheck } from './tools/tray-check.mjs';
      import { join } from 'node:path';
      const wantCwd = join('native', 'tray');
      const calls = [];
      const spawn = (cmd, args, opts) => {
        calls.push({ cmd, args: [...args], cwd: opts?.cwd });
        if (cmd === 'cargo' && args[0] === '--version') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      if (runTrayCheck(spawn) !== 0) process.exit(2);
      const cargo = calls.filter((c) => c.cmd === 'cargo' && c.args[0] !== '--version');
      const kinds = cargo.map((c) => c.args[0]);
      if (JSON.stringify(kinds) !== JSON.stringify(['fmt','clippy','clippy','test'])) process.exit(3);
      if (!cargo.every((c) => c.cwd === wantCwd)) process.exit(4);
      if (!cargo[0].args.includes('--check')) process.exit(5);
      if (!cargo[2].args.includes('--target')) process.exit(6);
      if (!cargo.every((c) => c.args[0] === 'fmt' || c.args.includes('--locked'))) process.exit(7);
    `);
    expect(r.status, r.stderr).toBe(0);
  });

  it('propagates the first failing cargo step (null status becomes 1)', () => {
    const r = runSnippet(`
      import { runTrayCheck } from './tools/tray-check.mjs';
      let n = 0;
      const spawn = (cmd, args) => {
        if (cmd === 'cargo' && args[0] === '--version') return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'cargo' && args[0] === 'fmt') return { status: null, stdout: '', stderr: '' };
        n++;
        return { status: 0, stdout: '', stderr: '' };
      };
      if (runTrayCheck(spawn) !== 1) process.exit(2);
      if (n !== 0) process.exit(3);
    `);
    expect(r.status, r.stderr).toBe(0);
  });
});

describe('tray-build.mjs', () => {
  it('refuses non-win32 platforms', () => {
    const r = runSnippet(`
      import { runTrayBuild } from './tools/tray-build.mjs';
      const spawn = () => ({ status: 0, stdout: '', stderr: '' });
      if (runTrayBuild({ platform: 'linux', spawn }) !== 1) process.exit(2);
    `);
    expect(r.status, r.stderr).toBe(0);
  });

  it('builds in native/tray cwd and rejects binaries over 2 MiB', () => {
    const r = runSnippet(`
      import { runTrayBuild } from './tools/tray-build.mjs';
      import { join } from 'node:path';
      const wantCwd = join('native', 'tray');
      let buildArgs = [];
      const spawn = (cmd, args, opts) => {
        if (cmd === 'cargo' && args[0] === '--version') return { status: 0, stdout: '', stderr: '' };
        if (cmd === 'cargo' && args[0] === 'build') {
          buildArgs = args;
          if (opts?.cwd !== wantCwd) process.exit(2);
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };
      if (runTrayBuild({
        platform: 'win32', spawn,
        stat: () => ({ size: 3 * 1024 * 1024 }),
        mkdir: () => {}, copyFile: () => {},
      }) !== 1) process.exit(3);
      const want = ['build','--release','--locked','--target','x86_64-pc-windows-msvc'];
      if (JSON.stringify(buildArgs) !== JSON.stringify(want)) process.exit(4);
      if (runTrayBuild({
        platform: 'win32', spawn,
        stat: () => ({ size: 1024 }),
        mkdir: () => {}, copyFile: () => {},
      }) !== 0) process.exit(5);
    `);
    expect(r.status, r.stderr).toBe(0);
  });
});
