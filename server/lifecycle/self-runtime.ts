import path from 'node:path';
import { SHIM_LEAF } from '../../src/conduit-mcp/install-entries';
import { LINK_PROTOCOL } from '../../src/contracts/link-protocol';
import { runtimeBinaryName } from '../../src/runtime-binary';
import type { NetworkBootstrapDeps } from '../network';

type SelfRuntime = Omit<NetworkBootstrapDeps, 'noDownload'>;

/**
 * Where this server's own files are, for the bootstrap that pushes them to a remote (plan 4.2.3).
 * The server dir is the bundle dir main.js runs from. Packaged, the prepared shim dir holds this
 * build's node beside the shim (runtime-dir/prepare.ts). Dev, the node is named by the environment,
 * because the server runs under electron, which is not a node to push.
 */
export function selfRuntimeOf(o: {
  version: string;
  serverDir: string;
  shimDir: string | undefined;
  devShim: string;
  hcBin: string;
  platform: NodeJS.Platform;
  arch: string;
  env: Readonly<Record<string, string | undefined>>;
}): SelfRuntime {
  const node = runtimeBinaryName('node', o.platform);
  return {
    local: {
      version: o.version,
      linkMajor: LINK_PROTOCOL.major,
      platform: o.platform === 'linux' ? 'linux' : o.platform === 'win32' ? 'win32' : 'other',
      arch: o.arch === 'x64' ? 'x64' : 'other',
    },
    runtime: {
      nodeExe: o.shimDir ? path.join(o.shimDir, node) : o.env.CONDUIT_NODE_BINARY || null,
      serverDir: o.serverDir,
      hcExe: o.hcBin,
      shimFile: o.shimDir ? path.join(o.shimDir, SHIM_LEAF) : o.devShim,
    },
  };
}
