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
  REQUEST_TOOL_NAMES,
  resolvePolicy,
  TOOL_GROUPS,
  TOOL_NAMES,
  TOOL_SPECS,
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
    expect(TOOL_GROUPS.map((g) => g.group)).toEqual([
      'messaging',
      'requests',
      'sessions',
      'editor',
      'machines',
    ]);
    expect(TOOL_GROUPS.flatMap((g) => g.tools)).toEqual([...TOOL_NAMES]);
  });

  it('request tools default on with no ask', () => {
    for (const t of REQUEST_TOOL_NAMES) {
      expect(DEFAULT_TOOL_POLICY[t]).toEqual({ access: 'on' });
      expect(isValidField(t, 'access', 'ask')).toBe(false);
    }
    expect(coercePolicyLayer({ request_input: { access: 'ask' } })).toBeUndefined();
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
  it('refuses a policy engine denial', () => {
    expect(
      gateToolCall({
        sessionId: 's1',
        messagingOn: true,
        tool: 'open_file',
        decision: { decision: 'deny', rule: { when: 'viewing', reach: null, move: null } },
        ownerReady: () => true,
        onScreen: () => true,
        appConnected: true,
      })?.code,
    ).toBe('tool_disabled');
  });
  // A routed call (CON-40 S3, spec 4.6) is a server action: it runs without a window, and when:viewing
  // never applies to it, because the lead's screen is not what it reaches.
  it('a routed read_screen runs with no ready window and the lead off screen', () => {
    const base = {
      sessionId: 's1',
      messagingOn: true,
      tool: 'read_screen' as const,
      decision: {
        decision: 'allow' as const,
        rule: { when: 'viewing' as const, reach: null, move: null },
      },
      ownerReady: () => false,
      onScreen: () => false,
      appConnected: true,
      routed: true,
    };
    expect(gateToolCall(base)).toBeNull();
  });

  it('a routed call still asks through a ready window, and is not held back by when:viewing', () => {
    const decision = {
      decision: 'ask' as const,
      rule: { when: 'viewing' as const, reach: null, move: null },
    };
    expect(
      gateToolCall({
        sessionId: 's1',
        messagingOn: true,
        tool: 'send_input',
        decision,
        ownerReady: () => true,
        onScreen: () => false,
        appConnected: true,
        routed: true,
      }),
    ).toBeNull();
  });

  it('a routed ask with no ready window is window_not_ready, as any server action ask is', () => {
    expect(
      gateToolCall({
        sessionId: 's1',
        messagingOn: true,
        tool: 'read_screen',
        decision: { decision: 'ask', rule: { when: 'always', reach: null, move: null } },
        ownerReady: () => false,
        onScreen: () => false,
        appConnected: true,
        routed: true,
      })?.code,
    ).toBe('window_not_ready');
  });

  it('a local read_screen with no ready window is still window_not_ready, and when:viewing still applies', () => {
    const base = {
      sessionId: 's1',
      messagingOn: true,
      tool: 'read_screen' as const,
      decision: {
        decision: 'allow' as const,
        rule: { when: 'viewing' as const, reach: null, move: null },
      },
      ownerReady: () => false,
      onScreen: () => true,
      appConnected: true,
    };
    expect(gateToolCall(base)?.code).toBe('window_not_ready');
    expect(gateToolCall({ ...base, ownerReady: () => true, onScreen: () => false })?.code).toBe(
      'caller_not_visible',
    );
  });

  it.each(['open_session', 'open_terminal', 'close_session', 'attach_folder'] as const)(
    '%s with on/viewing runs windowless without consulting visibility',
    (tool) => {
      expect(
        gateToolCall({
          sessionId: 's1',
          messagingOn: true,
          tool,
          decision: makeDecision('on', 'viewing'),
          ownerReady: () => false,
          onScreen: () => false,
          appConnected: true,
        }),
      ).toBeNull();
    },
  );
  const makeDecision = (
    access: 'on' | 'off' | 'ask',
    when: 'viewing' | 'always' | null = null,
  ) => ({
    decision:
      access === 'on'
        ? ('allow' as const)
        : access === 'off'
          ? ('deny' as const)
          : ('ask' as const),
    rule: { when, reach: null, move: null },
  });
  const on = makeDecision('on', 'viewing');
  const base = {
    sessionId: 's1' as string | null,
    messagingOn: true,
    tool: 'open_file' as const,
    decision: on,
    ownerReady: () => true,
    onScreen: () => true,
    appConnected: true,
  };
  const throws = () => {
    throw new Error('thunk ran');
  };

  it('gate order', () => {
    expect(gateToolCall({ ...base, sessionId: null, messagingOn: false })?.code).toBe(
      'not_in_session',
    );
    expect(gateToolCall({ ...base, messagingOn: false, decision: makeDecision('off') })?.code).toBe(
      'messaging_off',
    );
    const off = gateToolCall({ ...base, decision: makeDecision('off'), ownerReady: throws });
    expect(off?.code).toBe('tool_disabled');
    expect(off?.message).toContain('open_file');
    expect(off?.message).not.toContain('Settings');
    const notReady = gateToolCall({ ...base, ownerReady: () => false, onScreen: throws });
    expect(notReady?.code).toBe('window_not_ready');
    expect(notReady?.retryable).toBe(true);
    expect(gateToolCall({ ...base, onScreen: () => false })?.code).toBe('caller_not_visible');
    expect(
      gateToolCall({ ...base, decision: makeDecision('on', 'always'), onScreen: () => false }),
    ).toBeNull();
    expect(gateToolCall({ ...base, decision: makeDecision('ask', 'viewing') })).toBeNull();
    expect(
      gateToolCall({
        ...base,
        tool: 'send_message',
        decision: makeDecision('on'),
        ownerReady: throws,
        onScreen: throws,
      }),
    ).toBeNull();
  });

  it('gate lets a request tool through with no ready window', () => {
    for (const tool of REQUEST_TOOL_NAMES) {
      expect(
        gateToolCall({
          sessionId: 's1',
          messagingOn: true,
          tool,
          decision: makeDecision('on'),
          ownerReady: () => false,
          onScreen: () => false,
          appConnected: true,
        }),
      ).toBeNull();
    }
  });

  it('gate lets an always ask through with no app', () => {
    expect(
      gateToolCall({
        ...base,
        tool: 'open_session',
        decision: makeDecision('ask', 'always'),
        ownerReady: () => false,
        appConnected: false,
      }),
    ).toBeNull();
  });

  it('gate refuses an always ask for a window tool with no app', () => {
    expect(
      gateToolCall({
        ...base,
        tool: 'open_file',
        decision: makeDecision('ask', 'always'),
        ownerReady: () => false,
        appConnected: false,
      })?.code,
    ).toBe('window_not_ready');
  });

  it('gate still refuses a viewing ask with no app', () => {
    expect(
      gateToolCall({
        ...base,
        tool: 'open_session',
        decision: makeDecision('ask', 'viewing'),
        ownerReady: () => false,
        appConnected: false,
      })?.code,
    ).toBe('window_not_ready');
  });

  it('on server actions run without a ready owner window, while viewing still checks visibility', () => {
    expect(
      gateToolCall({
        ...base,
        tool: 'list_agents',
        decision: makeDecision('on'),
        ownerReady: () => false,
      }),
    ).toBeNull();
    expect(
      gateToolCall({
        ...base,
        tool: 'open_session',
        ownerReady: () => false,
      }),
    ).toBeNull();
    expect(
      gateToolCall({
        ...base,
        tool: 'close_session',
        ownerReady: () => true,
        onScreen: () => false,
      })?.code,
    ).toBe('caller_not_visible');
  });

  it('window actions and ask still require a ready owner window', () => {
    expect(gateToolCall({ ...base, tool: 'open_file', ownerReady: () => false })?.code).toBe(
      'window_not_ready',
    );
    expect(
      gateToolCall({
        ...base,
        tool: 'open_session',
        decision: makeDecision('ask', 'viewing'),
        ownerReady: () => false,
      })?.code,
    ).toBe('window_not_ready');
  });
});

describe('Part B catalog rows (app-control spec, tool-policy spec §3.2)', () => {
  it('Part B defaults match spec A §3.2', () => {
    expect(DEFAULT_TOOL_POLICY.close_session).toStrictEqual({
      access: 'ask',
      when: 'viewing',
      reach: 'window',
    });
    expect(DEFAULT_TOOL_POLICY.focus_session).toStrictEqual({
      access: 'on',
      when: 'viewing',
      reach: 'window',
      move: 'yes',
    });
    expect(DEFAULT_TOOL_POLICY.read_screen).toStrictEqual({
      access: 'on',
      when: 'viewing',
      reach: 'opened',
    });
    expect(DEFAULT_TOOL_POLICY.send_input).toStrictEqual({
      access: 'ask',
      when: 'viewing',
      reach: 'opened',
    });
    expect(DEFAULT_TOOL_POLICY.attach_folder).toStrictEqual({
      access: 'ask',
      when: 'viewing',
      reach: 'self',
    });
    for (const t of [
      'close_files',
      'open_review',
      'open_diff',
      'open_git_history',
      'open_url',
    ] as const)
      expect(DEFAULT_TOOL_POLICY[t]).toStrictEqual({ access: 'on', when: 'viewing' });
    expect(TOOL_SPECS.close_session.budget).toBe('act');
    expect(TOOL_SPECS.attach_folder.budget).toBe('act');
    expect(TOOL_SPECS.read_screen.budget).toBe('show');
    expect(TOOL_SPECS.send_input.budget).toBe('act');
    for (const t of [
      'focus_session',
      'close_files',
      'open_review',
      'open_diff',
      'open_git_history',
      'open_url',
    ] as const)
      expect(TOOL_SPECS[t].budget).toBe('show');
  });

  it('reach any only for focus and close', () => {
    expect(isValidField('attach_folder', 'reach', 'any')).toBe(false);
    expect(isValidField('attach_folder', 'reach', 'window')).toBe(true);
    expect(isValidField('close_session', 'reach', 'any')).toBe(true);
    expect(isValidField('focus_session', 'reach', 'any')).toBe(true);
    expect(coercePolicyLayer({ attach_folder: { reach: 'any' } })).toBeUndefined();
    expect(coercePolicyLayer({ open_url: { reach: 'self' } })).toBeUndefined();
    expect(coercePolicyLayer({ open_session: { reach: 'self' } })).toBeUndefined();
    expect(coercePolicyLayer({ close_session: { move: 'no' } })).toBeUndefined();
    expect(coercePolicyLayer({ focus_session: { move: 'no' } })).toStrictEqual({
      focus_session: { move: 'no' },
    });
  });

  it('groups', () => {
    const of = (g: string) => TOOL_GROUPS.find((x) => x.group === g)?.tools;
    expect(of('sessions')).toEqual([
      'list_agents',
      'open_session',
      'open_terminal',
      'read_screen',
      'send_input',
      'close_session',
      'focus_session',
      'attach_folder',
    ]);
    expect(of('editor')).toEqual([
      'open_file',
      'close_files',
      'open_review',
      'open_diff',
      'open_git_history',
      'open_url',
    ]);
  });
});

describe('machine tools (spec 4.6 and 5.1)', () => {
  it('the machines group holds the three tools, in catalog order', () => {
    expect(TOOL_GROUPS.find((g) => g.group === 'machines')?.tools).toEqual([
      'list_machines',
      'connect_machine',
      'disconnect_machine',
    ]);
  });

  it('connect and disconnect offer off, ask and on, and default to ask', () => {
    for (const tool of ['connect_machine', 'disconnect_machine'] as const) {
      expect(TOOL_SPECS[tool].access).toEqual(['off', 'ask', 'on']);
      expect(TOOL_SPECS[tool].defaults).toEqual({ access: 'ask' });
      expect(TOOL_SPECS[tool].budget).toBe('act');
    }
  });

  it('list_machines is a read: off or on, default on, shown in the view budget', () => {
    expect(TOOL_SPECS.list_machines.access).toEqual(['off', 'on']);
    expect(TOOL_SPECS.list_machines.defaults).toEqual({ access: 'on' });
    expect(TOOL_SPECS.list_machines.budget).toBe('show');
  });

  it('an allowed machine tool with no window still runs: it is a server action', () => {
    const allow = { decision: 'allow' as const, rule: { when: null, reach: null, move: null } };
    for (const tool of ['list_machines', 'connect_machine', 'disconnect_machine'] as const) {
      expect(
        gateToolCall({
          sessionId: 's1',
          messagingOn: true,
          tool,
          decision: allow,
          ownerReady: () => false,
          onScreen: () => false,
          appConnected: false,
        }),
        tool,
      ).toBeNull();
    }
  });
});
