// Per-CLI launch wiring for the conduit MCP server (spec §3.1): per-launch flags only, never an
// edit of the user's CLI config. Renderer-safe like its sibling launch-args.ts.
import type { McpAdapter } from './conduit-mcp/adapters';
import type { McpUnavailableReason } from './conduit-mcp/types';
import { batchGuarded, firstCmdMetachar } from './launch-args';
import type { HostPlatform } from './lsp-binary';

export interface McpServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type McpLaunchWiring =
  | { ok: true; args: string[]; configJson: string | null }
  | { ok: false; reason: Extract<McpUnavailableReason, 'cmd-metachar' | 'unquotable-path'> };

/**
 * ELECTRON_RUN_AS_NODE lives only in the server's own env entry, never the PTY env: otherwise any
 * Electron app started from that shell would run as Node (spec §3.1).
 */
export function mcpServerCommand(
  execPath: string,
  shimPath: string,
  endpoint: string,
): McpServerCommand {
  return {
    command: execPath,
    args: [shimPath, '--endpoint', endpoint],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** A TOML literal string has no escapes, so a quote or newline can't be represented at all. */
const tomlLiteral = (v: string): string | undefined => (/['\r\n]/.test(v) ? undefined : `'${v}'`);

function codexArgs(server: McpServerCommand): string[] | undefined {
  const command = tomlLiteral(server.command);
  const args = server.args.map(tomlLiteral);
  const env = Object.entries(server.env).map(([k, v]) => {
    const lit = tomlLiteral(v);
    return lit === undefined ? undefined : `${k}=${lit}`;
  });
  if (command === undefined || args.includes(undefined) || env.includes(undefined))
    return undefined;
  return [
    `mcp_servers.conduit.command=${command}`,
    `mcp_servers.conduit.args=[${args.join(',')}]`,
    `mcp_servers.conduit.env={${env.join(',')}}`,
    // Codex strips the PTY env from MCP children unless named here (spec §2, measured S0).
    "mcp_servers.conduit.env_vars=['CONDUIT_SESSION_TOKEN']",
    // Conduit's own tools only: no Codex approval prompt on every call.
    "mcp_servers.conduit.default_tools_approval_mode='auto'",
  ].flatMap((pair) => ['-c', pair]);
}

export function mcpLaunchWiring(i: {
  adapter: McpAdapter;
  platform: HostPlatform;
  resolvedCommand: string | undefined;
  server: McpServerCommand;
  configFile: string;
}): McpLaunchWiring {
  let args: string[];
  let configJson: string | null = null;
  switch (i.adapter.wiring) {
    case 'mcp-config-flag':
      args = ['--mcp-config', i.configFile];
      configJson = JSON.stringify({
        mcpServers: {
          conduit: {
            type: 'stdio',
            command: i.server.command,
            args: i.server.args,
            env: i.server.env,
          },
        },
      });
      break;
    case 'codex-c-flags': {
      const c = codexArgs(i.server);
      if (!c) return { ok: false, reason: 'unquotable-path' };
      args = c;
      break;
    }
    case 'cursor-global':
      return { ok: true, args: [], configJson: null };
  }
  // A launch that would trip the metachar guard goes without messaging, never broken (spec §3.1).
  if (
    batchGuarded(i.platform, i.resolvedCommand) &&
    args.some((a) => firstCmdMetachar(a) !== undefined)
  ) {
    return { ok: false, reason: 'cmd-metachar' };
  }
  return { ok: true, args, configJson };
}
