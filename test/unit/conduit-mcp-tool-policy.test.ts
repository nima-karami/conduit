import { describe, expect, it } from 'vitest';
import {
  coerceCliLayers,
  coerceGlobalPolicy,
  coercePolicyLayer,
  coercePolicyPatch,
  DEFAULT_TOOL_POLICY,
  gateToolCall,
  isValidField,
  migrateToolOverrides,
  type PolicyLayer,
  resolvePolicy,
  TOOL_GROUPS,
  TOOL_NAMES,
  TOOL_SPECS,
  type ToolPolicy,
  withPolicyPatch,
} from '../../src/conduit-mcp/tool-policy';

/** The v0.50 `settings.mcpTools` defaults, as a released build wrote them. */
const v050Defaults = {
  list_sessions: true,
  send_message: true,
  read_inbox: true,
  read_attachment: true,
  open_session: false,
  open_terminal: false,
  open_file: false,
};

const global = () => coerceGlobalPolicy(undefined);

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

describe('tool-policy catalog', () => {
  it('defaults match spec §3.2', () => {
    expect(DEFAULT_TOOL_POLICY.open_session).toEqual({
      access: 'ask',
      when: 'viewing',
      move: 'yes',
    });
    expect(DEFAULT_TOOL_POLICY.open_terminal.access).toBe('off');
    expect(DEFAULT_TOOL_POLICY.open_file).toEqual({ access: 'on', when: 'viewing' });
    expect(DEFAULT_TOOL_POLICY.send_message).toEqual({ access: 'on' });
    for (const t of TOOL_NAMES) expect(TOOL_SPECS[t].defaults).toEqual(DEFAULT_TOOL_POLICY[t]);
  });

  it('groups cover every tool once, in catalog order', () => {
    expect(TOOL_GROUPS.map((g) => g.group)).toEqual(['messaging', 'sessions', 'editor']);
    expect(TOOL_GROUPS.flatMap((g) => g.tools)).toEqual([...TOOL_NAMES]);
  });

  it('messaging tools are never ask', () => {
    expect(isValidField('read_inbox', 'access', 'ask')).toBe(false);
    expect(isValidField('open_session', 'access', 'ask')).toBe(true);
    expect(coercePolicyLayer({ read_inbox: { access: 'ask' } })).toBeUndefined();
  });
});

describe('resolvePolicy', () => {
  it('resolve per field with sources', () => {
    const r = resolvePolicy('open_session', {
      session: { open_session: { access: 'on' } },
      cli: { open_session: { when: 'always' } },
      global: global(),
    });
    expect(r.policy).toEqual({ access: 'on', when: 'always', move: 'yes' });
    expect(r.source).toEqual({ access: 'session', when: 'cli', move: 'global' });
  });

  it('an invalid value falls through', () => {
    const session = { open_file: { access: 'maybe' } } as unknown as PolicyLayer;
    const r = resolvePolicy('open_file', { session, global: global() });
    expect(r.policy.access).toBe('on');
    expect(r.source.access).toBe('global');
  });

  it('a non-applicable field is dropped', () => {
    expect(coercePolicyLayer({ open_file: { move: 'no' } })).toBeUndefined();
    const session = { open_file: { move: 'no' } } as unknown as PolicyLayer;
    const r = resolvePolicy('open_file', { session, global: global() });
    expect(r.policy).toEqual({ access: 'on', when: 'viewing' });
    expect(r.source).toEqual({ access: 'global', when: 'global' });
  });

  it('a corrupt global field resolves to the default rather than throwing', () => {
    const g = { ...global(), open_session: { access: 'x' } } as unknown as ReturnType<
      typeof global
    >;
    expect(resolvePolicy('open_session', { global: g }).policy).toEqual(
      DEFAULT_TOOL_POLICY.open_session,
    );
  });
});

describe('coerceGlobalPolicy and v0.50 migration', () => {
  it('v0.50 migration: true → on/always', () => {
    expect(
      coerceGlobalPolicy(undefined, { ...v050Defaults, open_session: true }).open_session,
    ).toEqual({
      access: 'on',
      when: 'always',
      move: 'yes',
    });
    expect(coerceGlobalPolicy(undefined, v050Defaults).send_message).toEqual({ access: 'on' });
  });

  it('v0.50 migration: a messaging false was user-set', () => {
    expect(
      coerceGlobalPolicy(undefined, { ...v050Defaults, send_message: false }).send_message,
    ).toEqual({
      access: 'off',
    });
  });

  it('v0.50 migration: a control false is the new default', () => {
    const g = coerceGlobalPolicy(undefined, {
      ...v050Defaults,
      open_file: false,
      open_session: false,
    });
    expect(g.open_file).toEqual({ access: 'on', when: 'viewing' });
    expect(g.open_session.access).toBe('ask');
  });

  it('the new key wins over legacy', () => {
    const g = coerceGlobalPolicy({ open_file: { access: 'off' } }, { open_session: true });
    expect(g.open_session.access).toBe('ask');
    expect(g.open_file).toEqual({ access: 'off', when: 'viewing' });
  });

  it('returns a fresh, complete, mutable layer', () => {
    const g = coerceGlobalPolicy(undefined);
    expect(g).toEqual(DEFAULT_TOOL_POLICY);
    g.open_file.access = 'off';
    expect(DEFAULT_TOOL_POLICY.open_file.access).toBe('on');
  });
});

describe('layers', () => {
  it('coercePolicyLayer keeps known tools, applicable fields and valid values', () => {
    expect(
      coercePolicyLayer({
        open_session: { access: 'on', when: 'never', move: 'no', reach: 'any' },
        bogus: { access: 'on' },
        open_file: {},
      }),
    ).toEqual({ open_session: { access: 'on', move: 'no' } });
  });

  it('coerceCliLayers keeps known CLI kinds only', () => {
    expect(
      coerceCliLayers({
        codex: { open_file: { access: 'off' } },
        fake: { open_file: { access: 'off' } },
        claude: { open_file: { access: 'nope' } },
      }),
    ).toEqual({ codex: { open_file: { access: 'off' } } });
    expect(coerceCliLayers({})).toBeUndefined();
  });

  it('migrateToolOverrides', () => {
    expect(migrateToolOverrides({ open_session: true, send_message: false, bogus: true })).toEqual({
      open_session: { access: 'on', when: 'always' },
      send_message: { access: 'off' },
    });
    expect(migrateToolOverrides({})).toBeUndefined();
    expect(migrateToolOverrides('x')).toBeUndefined();
  });

  it('withPolicyPatch', () => {
    const set = withPolicyPatch(undefined, 'open_session', { access: 'on', when: 'always' });
    expect(set).toEqual({ open_session: { access: 'on', when: 'always' } });
    expect(withPolicyPatch(set, 'open_session', { when: 'inherit' })).toEqual({
      open_session: { access: 'on' },
    });
    const two = withPolicyPatch(set, 'open_file', { access: 'off' });
    expect(withPolicyPatch(two, 'open_session', { access: 'inherit', when: 'inherit' })).toEqual({
      open_file: { access: 'off' },
    });
    expect(
      withPolicyPatch(set, 'open_session', { access: 'inherit', when: 'inherit' }),
    ).toBeUndefined();
    const frozen = deepFreeze({ open_session: { access: 'on', when: 'always' } } as PolicyLayer);
    expect(() =>
      withPolicyPatch(frozen, 'open_session', { when: 'inherit', move: 'no' }),
    ).not.toThrow();
    expect(frozen).toEqual({ open_session: { access: 'on', when: 'always' } });
  });

  it('coercePolicyPatch rejects at the boundary', () => {
    expect(coercePolicyPatch('open_file', { move: 'no' })).toBeNull();
    expect(coercePolicyPatch('open_file', { access: 'yes' })).toBeNull();
    expect(coercePolicyPatch('open_file', {})).toBeNull();
    expect(coercePolicyPatch('open_file', 'inherit')).toBeNull();
    expect(coercePolicyPatch('send_message', { access: 'ask' })).toBeNull();
    expect(coercePolicyPatch('open_session', { when: 'inherit', access: 'on' })).toEqual({
      when: 'inherit',
      access: 'on',
    });
  });

  it('coercion never throws', () => {
    for (const v of [null, [], 1, 'x', { open_file: null }, { open_file: [] }, undefined]) {
      expect(() => coerceGlobalPolicy(v, v)).not.toThrow();
      expect(coerceGlobalPolicy(v, v)).toEqual(DEFAULT_TOOL_POLICY);
      expect(coercePolicyLayer(v)).toBeUndefined();
      expect(coerceCliLayers(v)).toBeUndefined();
      expect(migrateToolOverrides(v)).toBeUndefined();
      expect(coercePolicyPatch('open_file', v)).toBeNull();
    }
  });
});

describe('gateToolCall (spec §3.3 steps 1–5)', () => {
  const on: ToolPolicy = { access: 'on', when: 'viewing' };
  const base = {
    sessionId: 's1' as string | null,
    messagingOn: true,
    tool: 'open_file' as const,
    policy: on,
    ownerReady: () => true,
    onScreen: () => true,
  };
  const throws = () => {
    throw new Error('thunk ran');
  };

  it('gate order', () => {
    expect(gateToolCall({ ...base, sessionId: null, messagingOn: false })?.code).toBe(
      'not_in_session',
    );
    expect(gateToolCall({ ...base, messagingOn: false, policy: { access: 'off' } })?.code).toBe(
      'messaging_off',
    );
    const off = gateToolCall({ ...base, policy: { access: 'off' }, ownerReady: throws });
    expect(off?.code).toBe('tool_disabled');
    expect(off?.message).toContain('open_file');
    expect(off?.message).not.toContain('Settings');
    const notReady = gateToolCall({ ...base, ownerReady: () => false, onScreen: throws });
    expect(notReady?.code).toBe('window_not_ready');
    expect(notReady?.retryable).toBe(true);
    expect(gateToolCall({ ...base, onScreen: () => false })?.code).toBe('caller_not_visible');
    expect(
      gateToolCall({ ...base, policy: { access: 'on', when: 'always' }, onScreen: () => false }),
    ).toBeNull();
    expect(gateToolCall({ ...base, policy: { access: 'ask', when: 'viewing' } })).toBeNull();
    expect(
      gateToolCall({
        ...base,
        tool: 'send_message',
        policy: { access: 'on' },
        ownerReady: throws,
        onScreen: throws,
      }),
    ).toBeNull();
  });
});
