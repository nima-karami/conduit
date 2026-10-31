import { describe, expect, it } from 'vitest';
import {
  PERMISSION_RULES,
  permissionCli,
  withAllowRule,
} from '../../src/conduit-mcp/cli-permissions';

const RULE = PERMISSION_RULES.claude;
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe('cli-permissions', () => {
  it('rules: every Conduit tool, per CLI syntax; only claude and cursor need one', () => {
    expect(PERMISSION_RULES).toEqual({ claude: 'mcp__conduit', cursor: 'Mcp(conduit:*)' });
    expect(permissionCli('claude')).toBe('claude');
    expect(permissionCli('cursor')).toBe('cursor');
    expect(permissionCli('codex')).toBeNull();
    expect(permissionCli('opencode')).toBeNull();
  });

  it('add to an empty or missing file creates permissions.allow', () => {
    expect(JSON.parse(withAllowRule('', RULE) ?? 'null')).toEqual({
      permissions: { allow: [RULE] },
    });
  });

  it('add appends after the user rules and keeps every other key and the deny list', () => {
    const text = JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'], deny: ['mcp__conduit__open_url'], ask: [] },
      hooks: { Stop: [] },
    });
    expect(JSON.parse(withAllowRule(text, RULE) ?? 'null')).toEqual({
      model: 'opus',
      permissions: {
        allow: ['Bash(ls:*)', RULE],
        deny: ['mcp__conduit__open_url'],
        ask: [],
      },
      hooks: { Stop: [] },
    });
  });

  it('add is idempotent: null when the rule is already there', () => {
    const once = withAllowRule('{}', RULE) ?? '';
    expect(withAllowRule(once, RULE)).toBeNull();
  });

  it('add on a malformed file throws EJSON, and so do non-object permissions or non-array allow', () => {
    expect(codeOf(() => withAllowRule('{ // c\n}', RULE))).toBe('EJSON');
    expect(codeOf(() => withAllowRule('{"permissions":[]}', RULE))).toBe('EJSON');
    expect(codeOf(() => withAllowRule('{"permissions":{"allow":"x"}}', RULE))).toBe('EJSON');
  });
});
