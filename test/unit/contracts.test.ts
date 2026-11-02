import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ControlDeps, McpOpenOutcome } from '../../src/conduit-mcp/control-tools';
import { FRAME_HEADER_BYTES, FrameKind } from '../../src/contracts/frames';
import {
  HC_MIN_CORE_VERSION,
  HC_PINNED_VERSION,
  HC_PROTOCOL_GENERATION,
  HC_USED_METHODS,
  isCompatibleCore,
} from '../../src/contracts/hc';
import schema from '../../src/contracts/hc/hc.openrpc.json';
import type {
  AttentionPort,
  DomainOpenFailureCode,
  DomainOpenOutcome,
  DomainPort,
  LaunchPort,
  McpHostDeps,
  ScrollbackPort,
  SessionStorePort,
  TokenStorePort,
  TypingPort,
  TypingWriteOptions,
} from '../../src/contracts/server-ports';
import {
  APP_SESSION_FIELDS,
  FROZEN_SHAPES,
  mergeAppOverlay,
  SERVER_ERROR_RPC_CODE,
  SERVER_EVENT_METHOD,
  SERVER_PROTOCOL_GENERATION,
  SERVER_SETTINGS_KEYS,
  type ServerErrorKind,
  type ServerEventNotification,
  type ServerEvents,
  type ServerMethods,
  type ServerNotifications,
  type ServerRpcError,
  type ServerSettings,
  type SessionView,
  STOP_ALL_ANSWER_TIMEOUT_MS,
  STOP_ALL_CONNECT_TIMEOUT_MS,
  STOP_TRANSITION_BUDGET_MS,
  versionOrder,
} from '../../src/contracts/server-protocol';
import {
  type ConduitLabels,
  coreStartEnv,
  judgePersistedVersion,
  SERVER_FILE_VERSION,
  type TokenRecord,
  USER_XDG_CAPTURED_ENV,
} from '../../src/contracts/session-identity';
import {
  parseShimHello,
  SHIM_ERRORS,
  SHIM_FROZEN_FIELDS,
  SHIM_HELLO_MAX_BYTES,
  SHIM_PROTOCOL_GENERATION,
  type ShimErrorCode,
  type ShimHelloV1,
  type ShimHelloV2,
  type ShimInitPhase,
  type ShimResume,
  type ShimState,
  type ShimWelcome,
  shimErrorReply,
} from '../../src/contracts/shim-protocol';
import type { LaunchIds, TerminalRuntime } from '../../src/contracts/terminal-runtime';
import * as terminalRuntime from '../../src/contracts/terminal-runtime';
import { coreStartCwd } from '../../src/instance-names';
import type { PtyWriter } from '../../src/pty-writer';
import type { SessionActivity } from '../../src/session-activity';
import type { AppSettings } from '../../src/settings';
import type { SpawnSpec } from '../../src/types';

type Fields<T> = T extends unknown ? keyof T : never;
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

interface JsonSchema {
  type?: string | string[];
  $ref?: string;
  anyOf?: JsonSchema[];
  properties?: Record<string, unknown>;
}

const components: Record<string, JsonSchema> = schema.components.schemas;

function resolve(s: JsonSchema): JsonSchema {
  if (!s.$ref) return s;
  const target = components[s.$ref.replace('#/components/schemas/', '')];
  expect(target, s.$ref).toBeDefined();
  return resolve(target);
}

function typesOf(s: JsonSchema): Set<string> {
  const r = resolve(s);
  if (r.anyOf) return new Set(r.anyOf.flatMap((x) => [...typesOf(x)]));
  return new Set(r.type === undefined ? [] : [r.type].flat());
}

describe('hc subset', () => {
  const byName = new Map(schema.methods.map((m) => [m.name, m]));

  it('pins the version the vendored schema was generated for', () => {
    expect(schema.info.version).toBe(HC_PINNED_VERSION);
  });

  it('sends only params the schema has, with its JSON type', () => {
    for (const [method, used] of Object.entries(HC_USED_METHODS)) {
      const m = byName.get(method);
      expect(m, method).toBeDefined();
      const params = new Map((m?.params ?? []).map((p) => [p.name, p.schema as JsonSchema]));
      for (const [name, type] of Object.entries(used.params)) {
        const p = params.get(name);
        expect(p, `${method}.${name}`).toBeDefined();
        if (p) expect([...typesOf(p)], `${method}.${name}`).toContain(type);
      }
    }
  });

  it('reads only result fields the schema returns', () => {
    for (const [method, used] of Object.entries(HC_USED_METHODS)) {
      const result = byName.get(method)?.result.schema as JsonSchema | undefined;
      expect(result, method).toBeDefined();
      const fields = new Set(Object.keys(result ? (resolve(result).properties ?? {}) : {}));
      for (const f of used.result)
        expect(fields.has(String(f)), `${method} → ${String(f)}`).toBe(true);
    }
  });

  // D21's fence is hc's refusal of a duplicate live name; the error kind we branch on must exist.
  it('lists name_taken as a terminal.run error', () => {
    const run = byName.get('terminal.run') as
      | { errors?: { data?: { kind?: string } }[] }
      | undefined;
    expect(run?.errors?.map((e) => e.data?.kind)).toContain('name_taken');
  });

  // D30: compatibility is the served subset, not the version, so a bump never strands live agents.
  it('judges a core by generation and methods, not version', () => {
    const methods = [...byName.keys()];
    expect(HC_MIN_CORE_VERSION).toBe('0.1.16');
    expect(isCompatibleCore({ generation: HC_PROTOCOL_GENERATION, methods })).toBe(true);
    expect(isCompatibleCore({ generation: HC_PROTOCOL_GENERATION + 1, methods })).toBe(false);
    expect(
      isCompatibleCore({
        generation: HC_PROTOCOL_GENERATION,
        methods: methods.filter((m) => m !== 'terminal.attach'),
      }),
    ).toBe(false);
  });

  // Revision 3 declared these envelopes; the checks above must refuse them.
  it('rejects the wrapped run/get results and boolean history', () => {
    const run = resolve(byName.get('terminal.run')?.result.schema as JsonSchema);
    const get = resolve(byName.get('terminal.get')?.result.schema as JsonSchema);
    expect(Object.keys(run.properties ?? {})).not.toContain('terminal');
    expect(Object.keys(get.properties ?? {})).not.toContain('terminal');
    const history = byName.get('terminal.attach')?.params.find((p) => p.name === 'history');
    expect([...typesOf(history?.schema as JsonSchema)]).not.toContain('boolean');
  });
});

describe('shared framing', () => {
  // hc schema/README.md "Framed mode": channel u32 · kind u8 · len u32; kinds 0–5.
  it('matches the herdr-core frame layout', () => {
    expect(FRAME_HEADER_BYTES).toBe(4 + 1 + 4);
    expect(Object.values(FrameKind)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

// The frozen surfaces are the ones an older peer still speaks after an update (D11, D12): a
// changed required field here breaks a live agent's shim or an older server's restart, while an
// added optional one is ignored by older readers. A required-field change that isn't mirrored in
// the field lists fails typecheck; a list change fails the literal below.
describe('frozen server calls', () => {
  it('match the declared required fields', () => {
    expectTypeOf<RequiredKeys<ServerMethods['hello']['params']>>().toEqualTypeOf<
      (typeof FROZEN_SHAPES)['hello']['params'][number]
    >();
    expectTypeOf<RequiredKeys<ServerMethods['hello']['result']>>().toEqualTypeOf<
      (typeof FROZEN_SHAPES)['hello']['result'][number]
    >();
    expectTypeOf<RequiredKeys<ServerMethods['server.restart']['params']>>().toEqualTypeOf<
      (typeof FROZEN_SHAPES)['server.restart']['params'][number]
    >();
    // keyof an empty record is `string`, so the empty params are pinned by type instead.
    expectTypeOf<ServerMethods['server.stopAll']['params']>().toEqualTypeOf<
      Record<string, never>
    >();
    expectTypeOf<RequiredKeys<ServerMethods['server.stopAll']['result']>>().toEqualTypeOf<
      (typeof FROZEN_SHAPES)['server.stopAll']['result'][number]
    >();
  });

  // If an optional field counted, adding one would read as a frozen change and the rule would be moot.
  it('count only required fields as frozen', () => {
    expectTypeOf<RequiredKeys<{ a: string; b?: number }>>().toEqualTypeOf<'a'>();
  });

  it('keep their field names within generation 1', () => {
    expect(SERVER_PROTOCOL_GENERATION).toBe(1);
    expect(FROZEN_SHAPES).toEqual({
      hello: {
        params: ['appVersion', 'generation'],
        result: ['serverVersion', 'generation', 'instance', 'pid'],
      },
      'server.restart': { params: ['reason'], result: [] },
      'server.stopAll': { params: [], result: ['killed'] },
    });
  });
});

// The server's PtyWriter is today's, unchanged (R9 lane rule): only its sink moves to C1 `input`.
describe('server ports', () => {
  it('type through the existing PtyWriter', () => {
    expectTypeOf<TypingPort['submit']>().toEqualTypeOf<PtyWriter['submit']>();
    expectTypeOf<TypingPort['forget']>().toEqualTypeOf<PtyWriter['forget']>();
  });

  // W0b and W5 wire today's control tools to it; a drifted member would fork the host's deps.
  it('give the control tools their own ControlDeps members', () => {
    expectTypeOf<DomainPort['openSession']>().parameters.toEqualTypeOf<
      Parameters<ControlDeps['openSession']>
    >();
    expectTypeOf<DomainPort['addRoot']>().toEqualTypeOf<ControlDeps['addRoot']>();
    expectTypeOf<DomainPort['git']>().toEqualTypeOf<ControlDeps['git']>();
  });

  // F3: an unconfirmed MCP launch must reach its caller with the session to close; today's outcome
  // stays a subset until W0b makes McpOpenOutcome equal this one.
  it('carry launch uncertainty and stopping in the MCP open outcome', () => {
    expectTypeOf<McpOpenOutcome>().toExtend<DomainOpenOutcome>();
    expectTypeOf<DomainOpenFailureCode>().toEqualTypeOf<
      'unknown_agent' | 'brief_unavailable' | 'spawn_unconfirmed' | 'server_stopping'
    >();
    expectTypeOf<
      Extract<DomainOpenOutcome, { code: 'spawn_unconfirmed' }>['sessionId']
    >().toEqualTypeOf<string>();
  });

  // B1: close_session works with no window, so the domain closes without the renderer.
  it('close a session server-side', () => {
    expectTypeOf<DomainPort['closeSession']>().parameter(0).toEqualTypeOf<string>();
  });

  // The host types only through TypingPort, and TypingPort never calls back into W5 (F8).
  it('keep raw input and draft callbacks out of the host', () => {
    expectTypeOf<keyof McpHostDeps['runtime']>().toEqualTypeOf<'get' | 'screen' | 'on'>();
    expectTypeOf<keyof TypingWriteOptions>().toEqualTypeOf<'generation'>();
  });

  it("carry visibility into attention with today's signatures", () => {
    expectTypeOf<AttentionPort['setVisible']>().toEqualTypeOf<SessionActivity['setVisible']>();
    expectTypeOf<AttentionPort['dropWindow']>().toEqualTypeOf<SessionActivity['dropWindow']>();
  });

  // The ids have one producer (W4) and travel explicitly; the reserve behind prepareLaunch persists.
  it('pass launch ids explicitly through an async launch seam', () => {
    expectTypeOf<SessionStorePort['allocateLaunch']>().returns.toEqualTypeOf<LaunchIds>();
    expectTypeOf<LaunchPort['prepareLaunch']>().parameter(3).toEqualTypeOf<LaunchIds>();
    expectTypeOf<LaunchPort['prepareLaunch']>().returns.toEqualTypeOf<Promise<SpawnSpec>>();
    expectTypeOf<Parameters<TerminalRuntime['spawn']>[3]>().toEqualTypeOf<LaunchIds>();
  });

  // D21: an unresolved launch is a state of its own, never inferred from hc's absence.
  it('keep every launch outcome in the token row', () => {
    expectTypeOf<TokenRecord['state']>().toEqualTypeOf<
      'reserved' | 'live' | 'unconfirmed' | 'superseded'
    >();
  });

  // One focus producer: xterm's own reports inside term.input.
  it('carry focus only as input bytes', () => {
    expectTypeOf<keyof ServerNotifications>().toEqualTypeOf<
      'term.input' | 'term.resize' | 'term.facts' | 'folders.suspect'
    >();
    expectTypeOf<TerminalRuntime>().not.toHaveProperty('focus');
  });

  // A clock would mark a merely slow run unconfirmed; only a reply or a connection loss resolves it.
  it('resolve a spawn without a timeout', () => {
    expect(Object.keys(terminalRuntime)).not.toContain('SPAWN_CONFIRM_TIMEOUT_MS');
  });

  // stopAll must not leave a pending launch adoptable by the next server (D32).
  it('settle a stop by its mode', () => {
    expectTypeOf<Parameters<TerminalRuntime['beginStopping']>[0]>().toEqualTypeOf<
      'restart' | 'stopAll'
    >();
    expectTypeOf<TokenStorePort>().toHaveProperty('markSuperseded');
  });

  // Host-composed bytes reach the pane and the ring together, never as typed input.
  it('show host-composed bytes through the scrollback port', () => {
    expectTypeOf<ScrollbackPort['show']>().parameters.toEqualTypeOf<[string, string]>();
    expectTypeOf<ServerEvents['term.show']>().toEqualTypeOf<{ sessionId: string; data: string }>();
  });

  // Exactly one subscriber per concern: W6 feeds attention from its own stream.
  it('keep output recording inside the runtime', () => {
    expectTypeOf<AttentionPort>().not.toHaveProperty('recordOutput');
  });
});

describe('server protocol', () => {
  // timer:state can't tell a fire from an edit; the toasts need the pre-fire record.
  it('carry timer fires as their own event', () => {
    expectTypeOf<ServerEvents>().toHaveProperty('timers.fired');
  });

  it('name no error kind nothing produces', () => {
    expectTypeOf<'generation_mismatch'>().not.toExtend<ServerErrorKind>();
  });

  // D26 and F6 branch on this; a string compare would order 0.10.0 before 0.9.0.
  it('order versions by generation, then semver', () => {
    const at = (version: string, generation = 1) => ({ generation, version });
    expect(versionOrder(at('0.52.0'), at('0.52.0'))).toBe('same');
    expect(versionOrder(at('0.10.0'), at('0.9.0'))).toBe('appNewer');
    expect(versionOrder(at('0.52.0'), at('0.53.0'))).toBe('appOlder');
    expect(versionOrder(at('0.52.0'), at('0.52.0-rc.1'))).toBe('appNewer');
    expect(versionOrder(at('0.52.0-rc.1'), at('0.52.0'))).toBe('appOlder');
    expect(versionOrder(at('0.1.0', 2), at('9.0.0', 1))).toBe('appNewer');
    expect(versionOrder(at('0.52.0+build.9'), at('0.52.0+build.1'))).toBe('same');
  });

  // semver §11: an RC update must not take D26's downgrade branch.
  it('order pre-releases by semver identifier rules', () => {
    const at = (version: string) => ({ generation: 1, version });
    const ascending = [
      '0.52.0-alpha',
      '0.52.0-alpha.1',
      '0.52.0-alpha.beta',
      '0.52.0-beta',
      '0.52.0-beta.2',
      '0.52.0-beta.11',
      '0.52.0-rc.1',
      '0.52.0-rc.2',
      '0.52.0-rc.10',
      '0.52.0',
    ];
    for (let i = 0; i + 1 < ascending.length; i++) {
      const [lo, hi] = [ascending[i] ?? '', ascending[i + 1] ?? ''];
      expect(versionOrder(at(hi), at(lo)), `${hi} > ${lo}`).toBe('appNewer');
      expect(versionOrder(at(lo), at(hi)), `${lo} < ${hi}`).toBe('appOlder');
    }
    expect(versionOrder(at('0.52.0-rc.10'), at('0.52.0-rc.2'))).toBe('appNewer');
    expect(versionOrder(at('0.52.0-rc.2'), at('0.52.0-rc.2'))).toBe('same');
  });

  // An accepted stop may settle a launch for 10 s before it replies; the fallback must not race it.
  it('wait for an accepted stop longer than the whole transition', () => {
    expect(STOP_ALL_ANSWER_TIMEOUT_MS).toBeGreaterThan(STOP_TRANSITION_BUDGET_MS);
    expect(STOP_TRANSITION_BUDGET_MS).toBeGreaterThan(terminalRuntime.LAUNCH_SETTLE_ON_STOP_MS);
    expect(STOP_ALL_CONNECT_TIMEOUT_MS).toBeLessThan(STOP_ALL_ANSWER_TIMEOUT_MS);
  });

  // B3: repo state is the app's; a server snapshot must never clobber it.
  it('merge the app overlay over every server snapshot', () => {
    expectTypeOf<SessionView>().not.toHaveProperty('repos');
    expectTypeOf<SessionView>().not.toHaveProperty('activeRepoRoot');
    const view = { id: 's1', cwd: '/a/sub', repos: [{ root: '/stale' }] } as unknown as SessionView;
    const merged = mergeAppOverlay(view, { activeRepoRoot: '/a/sub', repoPinned: false });
    expect(merged.activeRepoRoot).toBe('/a/sub');
    expect(merged.repoPinned).toBe(false);
    expect(merged.cwd).toBe('/a/sub');
    expect(merged).not.toHaveProperty('repos');
    const bare = mergeAppOverlay(view, undefined);
    for (const k of APP_SESSION_FIELDS) expect(bare, k).not.toHaveProperty(k);
  });
});

describe('session identity', () => {
  it('drop the unused parent label', () => {
    expectTypeOf<ConduitLabels>().not.toHaveProperty('conduit.parent');
  });

  // The fourth cross-version edge: an older server must not misread a newer server's file.
  it('refuse a persisted file from a newer version', () => {
    for (const file of Object.keys(SERVER_FILE_VERSION) as (keyof typeof SERVER_FILE_VERSION)[]) {
      const v = SERVER_FILE_VERSION[file];
      expect(judgePersistedVersion(file, v), file).toBe('read');
      expect(judgePersistedVersion(file, v + 1), file).toBe('newer');
      expect(judgePersistedVersion(file, undefined), file).toBe('invalid');
      expect(judgePersistedVersion(file, 'x'), file).toBe('invalid');
      expect(judgePersistedVersion(file, 0), file).toBe('invalid');
    }
    // Scrollback v2 still reads v1 files (src/scrollback-persistence.ts).
    expect(judgePersistedVersion('scrollback-<id>.json', 1)).toBe('read');
  });

  const names = {
    hcSession: 'conduit-abc',
    hcConfigHome: '/u/hc/config',
    hcStateHome: '/u/hc/state',
  };

  // Windows env names are case-insensitive, so a lower-case HC_ key would leak the parent session.
  it('start the core with one env: HC_* stripped, XDG isolated, originals passed through', () => {
    const env = coreStartEnv(
      { PATH: '/bin', hc_terminal_id: 't1', HC_SESSION: 'theirs', XDG_CONFIG_HOME: '/mine' },
      names,
      true,
    );
    expect(env).toEqual({
      PATH: '/bin',
      HC_SESSION: 'conduit-abc',
      XDG_CONFIG_HOME: '/u/hc/config',
      XDG_STATE_HOME: '/u/hc/state',
      CONDUIT_USER_XDG_CONFIG_HOME: '/mine',
      CONDUIT_USER_XDG_STATE_HOME: '',
      [USER_XDG_CAPTURED_ENV]: '1',
    });
  });

  // The server runs under our isolated XDG; re-capturing there would pass ours off as the user's.
  it('keep the captured originals when the server restarts the core', () => {
    const first = coreStartEnv({ PATH: '/bin' }, names, true);
    const again = coreStartEnv(first, names, true);
    expect(again).toEqual(first);
    expect(again.CONDUIT_USER_XDG_CONFIG_HOME).toBe('');
  });

  // terminal.run.env can't unset, and the XDG spec reads empty as unset (M22).
  it('pass an absent user XDG variable through as empty under isolation', () => {
    const env = coreStartEnv({ PATH: '/bin', XDG_STATE_HOME: '/s' }, names, true);
    expect(env.CONDUIT_USER_XDG_CONFIG_HOME).toBe('');
    expect(env.CONDUIT_USER_XDG_STATE_HOME).toBe('/s');
  });

  it('start the core in the version dir of the runtime root (M21)', () => {
    expect(coreStartCwd('/u/runtime', '0.1.16')).toBe(path.join('/u/runtime', 'hc', '0.1.16'));
  });

  it("leave the user's XDG alone when isolation is off (M22 fail)", () => {
    const env = coreStartEnv({ XDG_STATE_HOME: '/s' }, names, false);
    expect(env.XDG_STATE_HOME).toBe('/s');
    expect(env.CONDUIT_USER_XDG_STATE_HOME).toBe('/s');
  });
});

// D7: a key the app consumes in the server's file would freeze it with the server down.
describe('server settings', () => {
  it('leave the app-consumed keys to the app', () => {
    for (const k of ['osAttention', 'logging', 'logLevel'])
      expect(SERVER_SETTINGS_KEYS as readonly string[]).not.toContain(k);
    expectTypeOf<ServerMethods['server.setLogging']['params']>().toEqualTypeOf<
      Pick<AppSettings, 'logging' | 'logLevel'>
    >();
    expectTypeOf<ServerSettings>().not.toHaveProperty('osAttention');
  });
});

interface TransitionCase {
  name: string;
  phaseBefore: ShimInitPhase;
  event: string;
  phaseAfter: ShimInitPhase;
  answeredLocally: boolean;
  initializeResponses: number;
  hellos: string[];
  initializedRead?: boolean;
  stateAfter?: ShimState;
  errorSent?: ShimErrorCode;
}
interface WireFixture {
  valid: { name: string; line: string }[];
  invalid: { name: string; line: string }[];
  unsupported: { name: string; line: string }[];
  transitions: TransitionCase[];
}
const wire: WireFixture = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/contracts/shim-hello.json'), 'utf8'),
);
const wireLine = (name: string) => {
  const line = wire.valid.find((f) => f.name === name)?.line;
  expect(line, name).toBeDefined();
  return line ?? '';
};

describe('frozen shim protocol', () => {
  it('match the declared types', () => {
    expectTypeOf<keyof ShimHelloV1>().toEqualTypeOf<
      (typeof SHIM_FROZEN_FIELDS)['helloV1'][number]
    >();
    expectTypeOf<keyof ShimHelloV2>().toEqualTypeOf<(typeof SHIM_FROZEN_FIELDS)['hello'][number]>();
    expectTypeOf<keyof ShimResume>().toEqualTypeOf<(typeof SHIM_FROZEN_FIELDS)['resume'][number]>();
    expectTypeOf<Fields<ShimWelcome>>().toEqualTypeOf<
      (typeof SHIM_FROZEN_FIELDS)['welcome'][number]
    >();
  });

  it('keep their field names within generation 2', () => {
    expect(SHIM_PROTOCOL_GENERATION).toBe(2);
    expect(SHIM_FROZEN_FIELDS).toEqual({
      helloV1: ['conduit', 'token'],
      hello: ['conduit', 'token', 'shim', 'resume'],
      resume: ['initialize', 'initialized'],
      welcome: ['conduit', 'ok', 'reason'],
    });
  });

  it('parses every recorded hello line', () => {
    for (const f of wire.valid) expect(parseShimHello(f.line)?.ok, f.name).toBe(true);
    expect(parseShimHello(wireLine('gen-2 resume'))).toEqual({
      ok: true,
      hello: {
        conduit: 2,
        token: 'tok_3f9a1c',
        shim: '0.52.0',
        resume: {
          initialize: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'claude-code', version: '2.1.0' },
          },
          initialized: true,
        },
      },
    });
  });

  it('accepts a v0.51 hello without resume', () => {
    expect(parseShimHello(wireLine('gen-1 v0.51 hello'))).toEqual({
      ok: true,
      hello: { conduit: 1, token: 'tok_3f9a1c' },
    });
    expect(parseShimHello(wireLine('gen-1 v0.51 tokenless'))).toEqual({
      ok: true,
      hello: { conduit: 1, token: null },
    });
  });

  // Without this answer a newer shim could only time out; the welcome lets it fall back at once.
  it('answers a newer generation with unsupported_generation', () => {
    expect(wire.unsupported.length).toBeGreaterThan(0);
    for (const f of wire.unsupported)
      expect(parseShimHello(f.line), f.name).toEqual({
        ok: false,
        reason: 'unsupported_generation',
      });
  });

  // The pending initialize is answered once; a resume without a successful initialize would invent one.
  it('resumes in each recorded transition exactly when the handshake is done', () => {
    const phases: readonly ShimInitPhase[] = ['idle', 'init-pending', 'init-done'];
    expect(wire.transitions.length).toBeGreaterThan(0);
    for (const t of wire.transitions) {
      expect(phases, t.name).toContain(t.phaseBefore);
      expect(phases, t.name).toContain(t.phaseAfter);
      if (t.answeredLocally) expect(t.phaseAfter, t.name).toBe('init-done');
      expect(t.initializeResponses, t.name).toBe(t.phaseAfter === 'init-done' ? 1 : 0);
      if (t.stateAfter === 'permanent_fallback') continue;
      expect(t.hellos.length, t.name).toBeGreaterThan(0);
      const parsed = t.hellos.map((h) => parseShimHello(h));
      for (const p of parsed) expect(p?.ok && p.hello.conduit, t.name).toBe(2);
      const last = parsed.at(-1);
      const resume = last?.ok && last.hello.conduit === 2 ? last.hello.resume : undefined;
      expect(resume === null, t.name).toBe(t.phaseAfter !== 'init-done');
    }
  });

  // The server waits for notifications/initialized only when told it hasn't been read yet.
  it('resumes with initialized as actually read', () => {
    const local = wire.transitions.filter((t) => t.answeredLocally);
    expect(local.some((t) => t.initializedRead === false)).toBe(true);
    for (const t of local) {
      expect(typeof t.initializedRead, t.name).toBe('boolean');
      const last = parseShimHello(t.hellos.at(-1) ?? '');
      const resume = last?.ok && last.hello.conduit === 2 ? last.hello.resume : null;
      expect(resume?.initialized, t.name).toBe(t.initializedRead);
    }
  });

  // An oversized resume can't be sent, and retrying would only fail again.
  it('falls back for good after one reinitialize_required', () => {
    const cases = wire.transitions.filter((t) => t.errorSent === 'reinitialize_required');
    expect(cases.length).toBeGreaterThan(0);
    for (const t of cases) {
      expect(t.stateAfter, t.name).toBe('permanent_fallback');
      expect(t.hellos, t.name).toEqual([]);
      expect(SHIM_ERRORS.reinitialize_required.retryable).toBe(false);
    }
  });

  // A hello sent before a local initialize answer would promote a socket that never initialized.
  it('abandons an attempt whose hello predates a local initialize', () => {
    const abandoned = wire.transitions.filter((t) => t.answeredLocally && t.hellos.length > 1);
    expect(abandoned.some((t) => t.phaseBefore === 'idle')).toBe(true);
    for (const t of abandoned) {
      const [first, last] = [t.hellos[0], t.hellos.at(-1)].map((h) => parseShimHello(h ?? ''));
      expect(first?.ok && first.hello.conduit === 2 && first.hello.resume, t.name).toBeNull();
      expect(last?.ok && last.hello.conduit === 2 && last.hello.resume, t.name).toBeTruthy();
    }
  });

  it('refuses every recorded invalid line', () => {
    for (const f of wire.invalid) expect(parseShimHello(f.line), f.name).toBeNull();
  });

  it('refuses a hello past the size limit', () => {
    const big = {
      conduit: 2,
      token: null,
      shim: 'x',
      resume: { initialize: {}, initialized: true },
    };
    const pad = 'a'.repeat(SHIM_HELLO_MAX_BYTES);
    expect(
      parseShimHello(JSON.stringify({ ...big, resume: { ...big.resume, initialize: { pad } } })),
    ).toBeNull();
    expect(parseShimHello(JSON.stringify({ conduit: 1, token: 'a'.repeat(5000) }))).toBeNull();
  });

  it('answers tools/call as a tool error and anything else as a JSON-RPC error', () => {
    expect(shimErrorReply(1, 'tools/call', 'outcome_unknown')).toMatchObject({
      id: 1,
      result: { isError: true },
    });
    expect(shimErrorReply('1', 'tools/list', 'host_unavailable')).toMatchObject({
      id: '1',
      error: { code: -32000, data: { code: 'host_unavailable', retryable: true } },
    });
  });
});

describe('C2 wire wrappers', () => {
  it('sends every event as one notification method carrying the envelope', () => {
    const wire: ServerEventNotification<'runtime.changed'> = JSON.parse(
      '{"jsonrpc":"2.0","method":"event","params":{"seq":4,"type":"runtime.changed","data":{"state":"ready","hcVersion":"0.1.16"}}}',
    );
    expect(wire.method).toBe(SERVER_EVENT_METHOD);
    expect(wire.params.seq).toBe(4);
  });
  it('puts a domain refusal kind under one code', () => {
    const err: ServerRpcError = {
      code: SERVER_ERROR_RPC_CODE,
      message: 'server is stopping',
      data: { kind: 'server_stopping' },
    };
    expect(err.code).toBe(-32000);
    expectTypeOf(err.data.kind).toEqualTypeOf<ServerErrorKind>();
  });
});
