// Node-free. The allow rule that makes Conduit's own tool policy the only approval gate in a CLI
// (spec 2026-10-31-conduit-mcp-single-gate). Codex and OpenCode need none: their entry says so.
import { type AgentCli, ConfigFormatError } from './install-types';
import { type JsonObject, parseJsonConfig, serializeJsonConfig } from './json-config';

export type PermissionCli = 'claude' | 'cursor';

/** Each matches every tool of server `conduit` in that CLI's rule syntax. */
export const PERMISSION_RULES: Readonly<Record<PermissionCli, string>> = {
  claude: 'mcp__conduit',
  cursor: 'Mcp(conduit:*)',
};

export function permissionCli(cli: AgentCli): PermissionCli | null {
  return cli === 'claude' || cli === 'cursor' ? cli : null;
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The file with `rule` appended to permissions.allow; null when it is already allowed. Throws EJSON. */
export function withAllowRule(text: string, rule: string): string | null {
  const json = parseJsonConfig(text);
  const permissions = json.permissions ?? {};
  if (!isObject(permissions)) {
    throw new ConfigFormatError('EJSON', '"permissions" is not an object');
  }
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow))
    throw new ConfigFormatError('EJSON', '"permissions.allow" is not an array');
  if (allow.includes(rule)) return null;
  return serializeJsonConfig({ ...json, permissions: { ...permissions, allow: [...allow, rule] } });
}
