import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import checkRuntime from '../../build/check-runtime.mjs';

let projectDir = '';
afterEach(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

function fixture(platform: 'win32' | 'darwin') {
  projectDir = mkdtempSync(join(tmpdir(), 'check-runtime-'));
  const extension = platform === 'win32' ? '.exe' : '';
  const files = [
    `build/vendor/node/node${extension}`,
    'build/vendor/node/LICENSE',
    `build/vendor/hc/hc${extension}`,
    'build/vendor/hc/LICENSE',
    // The shapes hc's real archives have: a folder on Windows, a file on macOS.
    platform === 'win32'
      ? 'build/vendor/hc/THIRD-PARTY-NOTICES/herdr-core.txt'
      : 'build/vendor/hc/THIRD-PARTY-NOTICES',
    'out/server/main.js',
    'out/server/supervise.js',
    'resources/conduit-mcp/conduit-mcp-shim.cjs',
    'THIRD_PARTY_NOTICES.txt',
  ];
  for (const file of files) {
    mkdirSync(dirname(join(projectDir, file)), { recursive: true });
    writeFileSync(join(projectDir, file), 'fixture');
  }
  return {
    electronPlatformName: platform,
    arch: platform === 'darwin' ? 3 : 1,
    packager: { projectDir },
  };
}

describe('electron-builder runtime preflight', () => {
  it.each(['win32', 'darwin'] as const)('accepts a complete %s runtime', async (platform) => {
    await expect(checkRuntime(fixture(platform))).resolves.toBeUndefined();
  });

  it.each(['win32', 'darwin'] as const)(
    'rejects missing %s binaries with the fetch command',
    async (platform) => {
      const context = fixture(platform);
      rmSync(join(projectDir, 'build/vendor/hc'), { recursive: true });
      await expect(checkRuntime(context)).rejects.toThrow(/node build\/fetch-runtime\.mjs/);
    },
  );

  it('rejects a missing server build with the build command', async () => {
    const context = fixture('darwin');
    rmSync(join(projectDir, 'out/server'), { recursive: true });
    await expect(checkRuntime(context)).rejects.toThrow(/npm run build/);
    await expect(checkRuntime(context)).rejects.toThrow('out/server/main.js');
  });

  it('rejects a directory in place of a binary', async () => {
    const context = fixture('darwin');
    const binary = join(projectDir, 'build/vendor/node/node');
    rmSync(binary);
    mkdirSync(binary);
    await expect(checkRuntime(context)).rejects.toThrow(/node build\/fetch-runtime\.mjs/);
  });

  it.each(['win32', 'darwin'] as const)('rejects missing %s hc notices', async (platform) => {
    const context = fixture(platform);
    rmSync(join(projectDir, 'build/vendor/hc/THIRD-PARTY-NOTICES'), { recursive: true });
    await expect(checkRuntime(context)).rejects.toThrow('build/vendor/hc/THIRD-PARTY-NOTICES');
  });

  it('rejects Intel macOS instead of shipping arm64 binaries', async () => {
    const context = fixture('darwin');
    await expect(checkRuntime({ ...context, arch: 1 })).rejects.toThrow(/darwin.*x64/);
  });
});
