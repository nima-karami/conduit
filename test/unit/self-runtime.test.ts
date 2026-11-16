import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { selfRuntimeOf } from '../../server/lifecycle/self-runtime';

const base = {
  version: '1.2.3',
  serverDir: '/app/out/server',
  devShim: '/app/resources/conduit-mcp/conduit-mcp-shim.cjs',
  hcBin: '/app/build/vendor/hc/conduit-hc',
  arch: 'x64',
};

describe('selfRuntimeOf', () => {
  it('packaged: node and shim come from the prepared shim dir, the server from its bundle', () => {
    const r = selfRuntimeOf({
      ...base,
      shimDir: '/home/u/.config/conduit/runtime/shim',
      platform: 'linux',
      env: {},
    });
    expect(r.runtime).toEqual({
      nodeExe: path.join('/home/u/.config/conduit/runtime/shim', 'node'),
      serverDir: '/app/out/server',
      hcExe: '/app/build/vendor/hc/conduit-hc',
      shimFile: path.join('/home/u/.config/conduit/runtime/shim', 'conduit-mcp-shim.cjs'),
    });
    expect(r.local).toEqual({
      version: '1.2.3',
      linkMajor: r.local.linkMajor,
      platform: 'linux',
      arch: 'x64',
    });
  });

  it('dev: the shim is the repo copy, and the node is the one the environment names', () => {
    const r = selfRuntimeOf({
      ...base,
      shimDir: undefined,
      platform: 'linux',
      env: { CONDUIT_NODE_BINARY: '/opt/node/bin/node' },
    });
    expect(r.runtime.nodeExe).toBe('/opt/node/bin/node');
    expect(r.runtime.shimFile).toBe(base.devShim);
  });

  it('dev without a named node has none to push, so the shim step refuses rather than guesses', () => {
    const r = selfRuntimeOf({ ...base, shimDir: undefined, platform: 'linux', env: {} });
    expect(r.runtime.nodeExe).toBeNull();
  });

  it('a platform this build cannot push to is "other", never a match for a remote', () => {
    const r = selfRuntimeOf({ ...base, shimDir: undefined, platform: 'darwin', env: {} });
    expect(r.local.platform).toBe('other');
  });
});
