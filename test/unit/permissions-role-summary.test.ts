import { expect, it } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import { TOOL_GROUPS } from '../../src/conduit-mcp/tool-policy';
import {
  groupCounts,
  groupState,
  groupText,
} from '../../webview/components/permissions-role-summary';

it('writes counts in allow, ask, deny order and omits zeros', () => {
  expect(groupText({ allow: 3, ask: 4, deny: 1 })).toBe('3 allow · 4 ask · 1 deny');
  expect(groupText({ allow: 5, ask: 0, deny: 0 })).toBe('5 allow');
});

it('names a group allowed or denied only when every tool agrees', () => {
  expect(groupState({ allow: 0, ask: 2, deny: 0 })).toBe('mixed');
  expect(groupState({ allow: 5, ask: 0, deny: 0 })).toBe('allowed');
  expect(groupState({ allow: 0, ask: 0, deny: 6 })).toBe('denied');
  expect(groupState({ allow: 1, ask: 0, deny: 1 })).toBe('mixed');
});

it('counts a built-in role per group', () => {
  const observer = BUILT_IN_PROFILES.find((p) => p.id === 'observer');
  const sessions = TOOL_GROUPS.find((g) => g.group === 'sessions');
  if (!observer || !sessions) throw new Error('fixture missing');
  expect(groupCounts(observer, sessions.tools)).toEqual({ allow: 1, ask: 0, deny: 7 });
});
