import { stat } from 'node:fs/promises';
import { join } from 'node:path';

// See ADR 0007, W9: electron-builder otherwise skips absent extraResources.
export default async function checkRuntime(context) {
  const platform = context.electronPlatformName;
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch] ?? `arch-${context.arch}`;
  if (!((platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64'))) {
    throw new Error(`No pinned runtime for ${platform}-${arch}`);
  }
  const extension = platform === 'win32' ? '.exe' : '';
  const required = [
    `build/vendor/node/node${extension}`,
    'build/vendor/node/LICENSE',
    `build/vendor/hc/hc${extension}`,
    'build/vendor/hc/LICENSE',
    'build/vendor/hc/THIRD-PARTY-NOTICES',
    'out/server/main.js',
    'out/server/supervise.js',
    'resources/conduit-mcp/conduit-mcp-shim.cjs',
    'THIRD_PARTY_NOTICES.txt',
  ];
  const missing = [];
  for (const file of required) {
    try {
      if (!(await stat(join(context.packager.projectDir, file))).isFile()) missing.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(file);
    }
  }
  if (missing.length) {
    throw new Error(
      `Missing ${platform}-${arch} runtime files:\n${missing.join('\n')}\n` +
        `Run npm run build and node build/fetch-runtime.mjs --platform ${platform} --arch ${arch} before packaging.`,
    );
  }
}
