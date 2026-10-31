import { describe, expect, it } from 'vitest';
import {
  ACT_RATE_GLOBAL,
  ACT_RATE_PER_CALLER,
  type ControlCallContext,
  type ControlDeps,
  type ControlHandlers,
  createControlHandlers,
  type McpFileRequest,
  type McpOpenOutcome,
  type McpOpenRequest,
  type PathKind,
  type PreparedCall,
  SHOW_RATE_PER_CALLER,
} from '../../src/conduit-mcp/control-tools';
import type { Move } from '../../src/conduit-mcp/tool-policy';
import { toolSchemas } from '../../src/conduit-mcp/tool-schemas';
import type { Caller } from '../../src/conduit-mcp/tools';
import type { Result } from '../../src/conduit-mcp/types';

const HOME = '/home/main';
const noUi: ControlCallContext['ui'] = async () => {
  throw new Error('the open tools never ask the renderer');
};
const ctxOf = (move?: Move): ControlCallContext => ({ move, reach: undefined, ui: noUi });

interface Harness {
  deps: ControlDeps;
  opens: McpOpenRequest[];
  files: McpFileRequest[];
  logs: Array<{ message: string; data: Record<string, unknown> }>;
  clock: { t: number };
  kinds: Record<string, PathKind>;
  outcome: (req: McpOpenRequest) => Promise<McpOpenOutcome>;
}

function harness(over: Partial<ControlDeps> = {}): Harness {
  const h = {
    opens: [] as McpOpenRequest[],
    files: [] as McpFileRequest[],
    logs: [] as Array<{ message: string; data: Record<string, unknown> }>,
    clock: { t: 1_000_000 },
    kinds: {
      [HOME]: 'dir',
      '/home/main/../wt/T1': 'dir',
      '/repo': 'dir',
      '/repo/a.ts': 'file',
      '/home/main/src/a.ts': 'file',
      '/dev/null': 'other',
    } as Record<string, PathKind>,
    outcome: async (req: McpOpenRequest): Promise<McpOpenOutcome> => ({
      ok: true,
      sessionId: `new-${h.opens.length}`,
      label: req.label ?? 'T1',
    }),
  } as Harness;
  let n = 0;
  h.deps = {
    homeOf: (id) => (id.startsWith('caller') ? HOME : undefined),
    resolvePath: (home, p) => (p.startsWith('/') ? p : `${home}/${p}`),
    kindOf: async (abs) => h.kinds[abs] ?? 'missing',
    agentIds: () => ['claude', 'codex'],
    resolveCommand: (c) => (c === 'nope' ? undefined : `/usr/bin/${c}`),
    openSession: async (req) => {
      h.opens.push(req);
      const o = await h.outcome(req);
      return o.ok ? { ...o, sessionId: `${o.sessionId}-${n++}` } : o;
    },
    openFile: async (req) => {
      h.files.push(req);
      return { sessionId: req.callerSessionId };
    },
    claimHandle: (id) => `h-${id}`,
    now: () => h.clock.t,
    info: (message, data) => h.logs.push({ message, data }),
    // The app-control tools' deps: the open tools never reach them.
    foldersOf: () => {
      throw new Error('foldersOf: not an open tool');
    },
    addRoot: () => {
      throw new Error('addRoot: not an open tool');
    },
    activateSession: () => {
      throw new Error('activateSession: not an open tool');
    },
    git: () => {
      throw new Error('git: not an open tool');
    },
    targets: () => {
      throw new Error('targets: not an open tool');
    },
    ownerWindowOf: () => {
      throw new Error('ownerWindowOf: not an open tool');
    },
    windowReady: () => {
      throw new Error('windowReady: not an open tool');
    },
    ...over,
  };
  return h;
}

const caller = (n = 1): Caller => ({ handle: `claude-${n}`, sessionId: `caller-${n}` });
const code = <T>(r: Result<T>) => (r.ok ? 'ok' : r.error.code);
/** The handlers as a call whose policy is on runs them: prepare, then run (call-flow step 2). */
function whenOn(deps: ControlDeps) {
  const c: ControlHandlers = createControlHandlers(deps);
  const NO_MOVE = ctxOf();
  const run = async <T>(p: Promise<Result<PreparedCall<T>>>): Promise<Result<T>> => {
    const r = await p;
    return r.ok ? r.value.run() : r;
  };
  return {
    openSession: (who: Caller, args: unknown) => run(c.prepareOpenSession(who, args, NO_MOVE)),
    openTerminal: (who: Caller, args: unknown) => run(c.prepareOpenTerminal(who, args, NO_MOVE)),
    openFile: (who: Caller, args: unknown) => run(c.prepareOpenFile(who, args, NO_MOVE)),
  };
}
const sessionArgs = (over: Record<string, unknown> = {}) => ({
  path: '/repo',
  agent: 'claude',
  ...over,
});

describe('createControlHandlers', () => {
  it('open_session resolves a relative path against the caller home', async () => {
    const h = harness();
    const r = await whenOn(h.deps).openSession(caller(), sessionArgs({ path: '../wt/T1' }));
    expect(code(r)).toBe('ok');
    expect(h.opens[0].home).toBe('/home/main/../wt/T1');
    expect(h.opens[0].launch).toEqual({ kind: 'agent', agentId: 'claude' });
    expect(h.opens[0].callerSessionId).toBe('caller-1');
  });

  it('missing path → path_missing, file → not_a_directory; openSession never called', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    const missing = await c.openSession(caller(), sessionArgs({ path: '/gone' }));
    expect(code(missing)).toBe('path_missing');
    expect(code(await c.openSession(caller(), sessionArgs({ path: '/repo/a.ts' })))).toBe(
      'not_a_directory',
    );
    expect(code(await c.openTerminal(caller(), { path: '/dev/null', command: 'node' }))).toBe(
      'not_a_directory',
    );
    expect(code(await c.openTerminal(caller(), { path: '/gone', command: 'node' }))).toBe(
      'path_missing',
    );
    expect(h.opens).toEqual([]);
  });

  it('open_file on a dir → not_a_file; missing → path_missing', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    expect(code(await c.openFile(caller(), { path: '/repo' }))).toBe('not_a_file');
    expect(code(await c.openFile(caller(), { path: '/repo/gone.ts' }))).toBe('path_missing');
    expect(h.files).toEqual([]);
  });

  it('open_file resolves relative paths, passes line/column/focus and returns the target session', async () => {
    const h = harness({
      openFile: async (req) => {
        h.files.push(req);
        return { sessionId: 'owner' };
      },
    });
    const r = await whenOn(h.deps).openFile(caller(), {
      path: 'src/a.ts',
      line: 3,
      column: 2,
      focus: false,
    });
    expect(r).toEqual({ ok: true, value: { opened: '/home/main/src/a.ts', session_id: 'owner' } });
    expect(h.files).toEqual([
      {
        callerSessionId: 'caller-1',
        path: '/home/main/src/a.ts',
        line: 3,
        column: 2,
        focus: false,
      },
    ]);
  });

  it('unknown agent → unknown_agent listing the registered ids', async () => {
    const h = harness();
    const r = await whenOn(h.deps).openSession(caller(), sessionArgs({ agent: 'aider' }));
    expect(code(r)).toBe('unknown_agent');
    expect(!r.ok && r.error.message).toContain('claude, codex');
    expect(h.opens).toEqual([]);
  });

  it('command not resolving → command_not_found, nothing opened', async () => {
    const h = harness();
    const r = await whenOn(h.deps).openTerminal(caller(), {
      path: '/repo',
      command: 'nope',
    });
    expect(code(r)).toBe('command_not_found');
    expect(h.opens).toEqual([]);
  });

  it('invalid args', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    const bad = async (p: Promise<Result<unknown>>) => expect(code(await p)).toBe('invalid_args');
    await bad(c.openSession(caller(), sessionArgs({ extra: 1 })));
    await bad(c.openSession(caller(), sessionArgs({ label: 'x'.repeat(81) })));
    await bad(c.openSession(caller(), { path: '/repo' }));
    await bad(c.openSession(caller(), sessionArgs({ focus: 'yes' })));
    await bad(c.openSession(caller(), sessionArgs({ path: '' })));
    await bad(c.openSession(caller(), null));
    await bad(c.openSession(caller(), ['/repo', 'claude']));
    await bad(c.openFile(caller(), { path: '/repo/a.ts', line: 0 }));
    await bad(c.openFile(caller(), { path: '/repo/a.ts', line: 1.5 }));
    await bad(c.openFile(caller(), { path: '/repo/a.ts', column: 0 }));
    await bad(c.openTerminal(caller(), { path: '/repo', command: 'n', args: Array(65).fill('a') }));
    await bad(c.openTerminal(caller(), { path: '/repo', command: 'n', args: ['a', 2] }));
    await bad(c.openTerminal(caller(), { path: '/repo', command: 'n'.repeat(1025) }));
    await bad(c.openTerminal(caller(), { path: '/repo', command: '' }));
    await bad(c.openTerminal(caller(), { path: '/repo', command: 'n', args: null }));
    await bad(
      c.openTerminal(caller(), { path: '/repo', command: 'n', args: ['a'.repeat(8 * 1024 + 1)] }),
    );
    expect(h.opens).toEqual([]);
    expect(h.files).toEqual([]);
  });

  it('label of 80 chars is accepted', async () => {
    const h = harness();
    const r = await whenOn(h.deps).openSession(caller(), sessionArgs({ label: 'x'.repeat(80) }));
    expect(code(r)).toBe('ok');
    expect(h.opens[0].label).toBe('x'.repeat(80));
  });

  it('focus defaults to true', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    await c.openSession(caller(), sessionArgs());
    await c.openSession(caller(), sessionArgs({ focus: false }));
    await c.openFile(caller(), { path: '/repo/a.ts' });
    expect(h.opens.map((o) => o.focus)).toEqual([true, false]);
    expect(h.files[0].focus).toBe(true);
    expect(h.opens[0].label).toBeUndefined();
  });

  it('open_terminal passes {kind:"command", command, args} and the default label is the command leaf', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    const r = await c.openTerminal(caller(), {
      path: '/repo',
      command: '/usr/local/bin/cursor-agent',
      args: ['-p', 'x'],
    });
    expect(h.opens[0].launch).toEqual({
      kind: 'command',
      command: { command: '/usr/local/bin/cursor-agent', args: ['-p', 'x'] },
    });
    expect(r.ok && r.value.agent).toBe('cursor-agent');
    expect(h.opens[0].label).toBe('cursor-agent');
    expect(r.ok && r.value.label).toBe('cursor-agent');
    await c.openTerminal(caller(), { path: '/repo', command: 'node' });
    expect(h.opens[1].launch).toEqual({ kind: 'command', command: { command: 'node', args: [] } });
    await c.openTerminal(caller(), { path: '/repo', command: 'node', label: 'Build' });
    expect(h.opens[2].label).toBe('Build');
  });

  it('success returns {session_id, handle: claimHandle(id), label, agent}', async () => {
    const h = harness();
    const r = await whenOn(h.deps).openSession(caller(), sessionArgs({ label: 'Worker' }));
    expect(r).toEqual({
      ok: true,
      value: { session_id: 'new-1-0', handle: 'h-new-1-0', label: 'Worker', agent: 'claude' },
    });
    expect(h.logs).toEqual([
      {
        message: 'control open',
        data: { tool: 'open_session', caller: 'claude-1', sessionId: 'new-1-0', path: '/repo' },
      },
    ]);
  });

  it('handle null when claimHandle is null', async () => {
    const h = harness({ claimHandle: () => null });
    const r = await whenOn(h.deps).openSession(caller(), sessionArgs());
    expect(r.ok && r.value.handle).toBeNull();
  });

  it('brief_unavailable from openSession maps to the error, rate window not charged', async () => {
    const h = harness();
    h.outcome = async () => ({ ok: false, code: 'brief_unavailable', message: 'brief-io' });
    const c = whenOn(h.deps);
    for (let i = 0; i < ACT_RATE_PER_CALLER + 2; i++) {
      const r = await c.openSession(caller(), sessionArgs());
      expect(r).toEqual({
        ok: false,
        error: { code: 'brief_unavailable', message: 'brief-io', retryable: false },
      });
    }
    h.outcome = async (req) => ({ ok: true, sessionId: 's', label: req.label ?? 'x' });
    expect(code(await c.openSession(caller(), sessionArgs()))).toBe('ok');
  });

  it('openSession throwing → open_failed (logged), the reservation released', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    h.outcome = async () => {
      throw new Error('boom');
    };
    for (let i = 0; i < ACT_RATE_PER_CALLER; i++) {
      const r = await c.openSession(caller(), sessionArgs());
      expect(r).toEqual({
        ok: false,
        error: { code: 'open_failed', message: 'boom', retryable: false },
      });
    }
    expect(h.logs.at(-1)).toEqual({
      message: 'control open failed',
      data: { tool: 'open_session', caller: 'claude-1', path: '/repo', error: 'boom' },
    });
    h.outcome = async () => ({ ok: true, sessionId: 's', label: 'x' });
    expect(code(await c.openSession(caller(), sessionArgs()))).toBe('ok');
  });

  it('openFile throwing → open_failed (logged)', async () => {
    const h = harness({
      openFile: async () => {
        throw new Error('no window');
      },
    });
    const r = await whenOn(h.deps).openFile(caller(), { path: '/repo/a.ts' });
    expect(r).toEqual({
      ok: false,
      error: { code: 'open_failed', message: 'no window', retryable: false },
    });
    expect(h.logs).toEqual([
      {
        message: 'control open failed',
        data: { tool: 'open_file', caller: 'claude-1', path: '/repo/a.ts', error: 'no window' },
      },
    ]);
  });

  it('rate: 10 successful opens by one caller in 60s → 11th rate_limited; at 60s+1 allowed again', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    const start = h.clock.t;
    for (let i = 0; i < ACT_RATE_PER_CALLER; i++) {
      expect(
        code(
          await (i % 2
            ? c.openTerminal(caller(), { path: '/repo', command: 'node' })
            : c.openSession(caller(), sessionArgs())),
        ),
      ).toBe('ok');
      h.clock.t += 1000;
    }
    expect(code(await c.openSession(caller(), sessionArgs()))).toBe('rate_limited');
    expect(code(await c.openTerminal(caller(), { path: '/repo', command: 'node' }))).toBe(
      'rate_limited',
    );
    expect(code(await c.openSession(caller(2), sessionArgs()))).toBe('ok');
    h.clock.t = start + 60_000 + 1;
    expect(code(await c.openSession(caller(), sessionArgs()))).toBe('ok');
  });

  it('failed validations are not charged', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    for (let i = 0; i < ACT_RATE_PER_CALLER + 5; i++) {
      expect(code(await c.openSession(caller(), sessionArgs({ path: '/gone' })))).toBe(
        'path_missing',
      );
      expect(code(await c.openSession(caller(), sessionArgs({ agent: 'aider' })))).toBe(
        'unknown_agent',
      );
    }
    expect(code(await c.openSession(caller(), sessionArgs()))).toBe('ok');
  });

  it('global: 20 across callers → 21st rate_limited for a fresh caller', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    for (let i = 0; i < ACT_RATE_GLOBAL; i++)
      expect(code(await c.openSession(caller(i % 4), sessionArgs()))).toBe('ok');
    expect(code(await c.openSession(caller(99), sessionArgs()))).toBe('rate_limited');
  });

  it('concurrent: 11 opens from one caller in flight together → exactly 10 ok, 1 rate_limited', async () => {
    const h = harness();
    const gates: Array<() => void> = [];
    h.outcome = (req) =>
      new Promise((resolve) =>
        gates.push(() => resolve({ ok: true, sessionId: 's', label: req.label ?? 'x' })),
      );
    const c = whenOn(h.deps);
    const pending = Array.from({ length: ACT_RATE_PER_CALLER + 1 }, () =>
      c.openSession(caller(), sessionArgs()),
    );
    await new Promise((r) => setTimeout(r, 0));
    for (const g of gates) g();
    const codes = (await Promise.all(pending)).map(code);
    expect(codes.filter((x) => x === 'ok')).toHaveLength(ACT_RATE_PER_CALLER);
    expect(codes.filter((x) => x === 'rate_limited')).toHaveLength(1);
    expect(h.opens).toHaveLength(ACT_RATE_PER_CALLER);
  });

  it('concurrent: the global cap holds across callers in flight together', async () => {
    const h = harness();
    const gates: Array<() => void> = [];
    h.outcome = (req) =>
      new Promise((resolve) =>
        gates.push(() => resolve({ ok: true, sessionId: 's', label: req.label ?? 'x' })),
      );
    const c = whenOn(h.deps);
    const pending = Array.from({ length: ACT_RATE_GLOBAL + 5 }, (_, i) =>
      c.openSession(caller(i % 5), sessionArgs()),
    );
    await new Promise((r) => setTimeout(r, 0));
    for (const g of gates) g();
    const codes = (await Promise.all(pending)).map(code);
    expect(codes.filter((x) => x === 'ok')).toHaveLength(ACT_RATE_GLOBAL);
    expect(codes.filter((x) => x === 'rate_limited')).toHaveLength(5);
  });

  it('a reservation released by a failure frees the slot while the others are still in flight', async () => {
    const h = harness();
    const gates: Array<(o: McpOpenOutcome) => void> = [];
    h.outcome = () => new Promise((resolve) => gates.push(resolve));
    const c = whenOn(h.deps);
    const pending = Array.from({ length: ACT_RATE_PER_CALLER }, () =>
      c.openSession(caller(), sessionArgs()),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(code(await c.openSession(caller(), sessionArgs()))).toBe('rate_limited');
    gates[0]({ ok: false, code: 'brief_unavailable', message: 'x' });
    expect(code(await pending[0])).toBe('brief_unavailable');
    const retry = c.openSession(caller(), sessionArgs());
    await new Promise((r) => setTimeout(r, 0));
    expect(code(await c.openSession(caller(), sessionArgs()))).toBe('rate_limited');
    for (const g of gates.slice(1)) g({ ok: true, sessionId: 's', label: 'x' });
    expect((await Promise.all([...pending.slice(1), retry])).map(code)).toEqual(
      Array(ACT_RATE_PER_CALLER).fill('ok'),
    );
  });

  it('open_file does not spend the act budget', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    for (let i = 0; i < ACT_RATE_GLOBAL + 5; i++)
      expect(code(await c.openFile(caller(), { path: '/repo/a.ts' }))).toBe('ok');
    expect(code(await c.openSession(caller(), sessionArgs()))).toBe('ok');
  });

  it('homeOf undefined → not_in_session', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    const stranger: Caller = { handle: 'x-1', sessionId: 'gone' };
    expect(code(await c.openSession(stranger, sessionArgs()))).toBe('not_in_session');
    expect(code(await c.openTerminal(stranger, { path: '/repo', command: 'node' }))).toBe(
      'not_in_session',
    );
    expect(code(await c.openFile(stranger, { path: '/repo/a.ts' }))).toBe('not_in_session');
    expect(code(await c.openFile({ handle: 'x-1', sessionId: null }, { path: '/repo/a.ts' }))).toBe(
      'not_in_session',
    );
    expect(h.opens).toEqual([]);
  });

  it('openedBy is {handle, sessionId} of the caller', async () => {
    const h = harness();
    await whenOn(h.deps).openTerminal(caller(3), { path: '/repo', command: 'node' });
    expect(h.opens[0].openedBy).toEqual({ handle: 'claude-3', sessionId: 'caller-3' });
  });

  it('check order: invalid_args before rate_limited before not_in_session before path checks', async () => {
    const h = harness();
    const c = whenOn(h.deps);
    for (let i = 0; i < ACT_RATE_PER_CALLER; i++) await c.openSession(caller(), sessionArgs());
    expect(code(await c.openSession(caller(), sessionArgs({ extra: 1 })))).toBe('invalid_args');
    expect(code(await c.openSession(caller(), sessionArgs({ path: '/gone' })))).toBe(
      'rate_limited',
    );
    const stranger: Caller = { handle: 'x-1', sessionId: 'gone' };
    expect(
      code(await c.openSession(stranger, sessionArgs({ path: '/gone', agent: 'aider' }))),
    ).toBe('not_in_session');
    expect(
      code(await c.openSession(caller(2), sessionArgs({ path: '/repo/a.ts', agent: 'aider' }))),
    ).toBe('not_a_directory');
  });
});

describe('prepare/run (spec 2026-10-30-conduit-mcp-tool-policy §3.3)', () => {
  const ok = <T>(r: Result<T>): T => {
    if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
    return r.value;
  };
  const NO_MOVE = ctxOf();

  it('prepare resolves and summarises', async () => {
    const h = harness({ agentIds: () => ['a'] });
    h.kinds['/home/main/w'] = 'dir';
    const c = createControlHandlers(h.deps);
    const s = ok(await c.prepareOpenSession(caller(), { path: 'w', agent: 'a' }, NO_MOVE));
    expect(s.summary).toEqual({
      tool: 'open_session',
      path: '/home/main/w',
      agent: 'a',
      focus: true,
    });
    const s2 = ok(await c.prepareOpenSession(caller(), { path: 'w', agent: 'a' }, NO_MOVE));
    expect(h.opens).toEqual([]);
    expect(code(await s2.run())).toBe('ok');
    expect(h.opens).toHaveLength(1);
    const t = ok(
      await c.prepareOpenTerminal(
        caller(),
        { path: '/repo', command: 'node', args: ['-e', '1'], focus: false },
        NO_MOVE,
      ),
    );
    expect(t.summary).toEqual({
      tool: 'open_terminal',
      path: '/repo',
      command: 'node -e 1',
      focus: false,
    });
    const f = ok(await c.prepareOpenFile(caller(), { path: 'src/a.ts', line: 4 }, NO_MOVE));
    expect(f.summary).toEqual({ tool: 'open_file', path: '/home/main/src/a.ts', line: 4 });
    const f2 = ok(await c.prepareOpenFile(caller(), { path: '/repo/a.ts' }, NO_MOVE));
    expect(f2.summary).toEqual({ tool: 'open_file', path: '/repo/a.ts', line: null });
  });

  it('move no forces focus false', async () => {
    const h = harness();
    const c = createControlHandlers(h.deps);
    const s = ok(await c.prepareOpenSession(caller(), sessionArgs({ focus: true }), ctxOf('no')));
    const t = ok(
      await c.prepareOpenTerminal(caller(), { path: '/repo', command: 'node' }, ctxOf('no')),
    );
    expect(s.summary).toMatchObject({ focus: false });
    expect(t.summary).toMatchObject({ focus: false });
    await s.run();
    await t.run();
    expect(h.opens.map((o) => o.focus)).toEqual([false, false]);
    const y = ok(await c.prepareOpenSession(caller(), sessionArgs(), ctxOf('yes')));
    expect(y.summary).toMatchObject({ focus: true });
    await y.run();
    expect(h.opens[2].focus).toBe(true);
  });

  it('act budget', async () => {
    const h = harness();
    const c = createControlHandlers(h.deps);
    for (let i = 0; i < ACT_RATE_PER_CALLER; i++)
      ok(
        await (i % 2
          ? c.prepareOpenTerminal(caller(), { path: '/repo', command: 'node' }, NO_MOVE)
          : c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE)),
      );
    expect(code(await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE))).toBe('rate_limited');
    for (let i = ACT_RATE_PER_CALLER; i < ACT_RATE_GLOBAL; i++)
      ok(await c.prepareOpenSession(caller(2 + (i % 3)), sessionArgs(), NO_MOVE));
    const r = await c.prepareOpenSession(caller(99), sessionArgs(), NO_MOVE);
    expect(code(r)).toBe('rate_limited');
    expect(r.ok ? '' : r.error.message).toBe('too many actions in Conduit this minute');
  });

  it('show budget', async () => {
    const h = harness();
    const c = createControlHandlers(h.deps);
    for (let i = 0; i < SHOW_RATE_PER_CALLER; i++)
      ok(await c.prepareOpenFile(caller(), { path: '/repo/a.ts' }, NO_MOVE));
    expect(code(await c.prepareOpenFile(caller(), { path: '/repo/a.ts' }, NO_MOVE))).toBe(
      'rate_limited',
    );
    expect(code(await c.prepareOpenFile(caller(2), { path: '/repo/a.ts' }, NO_MOVE))).toBe('ok');
    expect(code(await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE))).toBe('ok');
  });

  it('a refusal after the reservation refunds', async () => {
    const h = harness();
    const c = createControlHandlers(h.deps);
    for (let i = 0; i < ACT_RATE_PER_CALLER + 5; i++) {
      expect(
        code(await c.prepareOpenSession(caller(), sessionArgs({ path: '/gone' }), NO_MOVE)),
      ).toBe('path_missing');
      expect(
        code(await c.prepareOpenTerminal(caller(), { path: '/repo', command: 'nope' }, NO_MOVE)),
      ).toBe('command_not_found');
    }
    for (let i = 0; i < SHOW_RATE_PER_CALLER + 5; i++)
      expect(code(await c.prepareOpenFile(caller(), { path: '/repo' }, NO_MOVE))).toBe(
        'not_a_file',
      );
    expect(code(await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE))).toBe('ok');
    expect(code(await c.prepareOpenFile(caller(), { path: '/repo/a.ts' }, NO_MOVE))).toBe('ok');
  });

  it('run failure refunds; success keeps', async () => {
    const h = harness();
    h.outcome = async () => ({ ok: false, code: 'brief_unavailable', message: 'x' });
    const c = createControlHandlers(h.deps);
    for (let i = 0; i < ACT_RATE_PER_CALLER + 5; i++) {
      const p = ok(await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE));
      expect(code(await p.run())).toBe('brief_unavailable');
    }
    h.outcome = async (req) => ({ ok: true, sessionId: 's', label: req.label ?? 'x' });
    for (let i = 0; i < ACT_RATE_PER_CALLER; i++) {
      const p = ok(await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE));
      expect(code(await p.run())).toBe('ok');
      p.release();
    }
    expect(code(await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE))).toBe('rate_limited');
  });

  it('release is idempotent', async () => {
    const h = harness();
    const c = createControlHandlers(h.deps);
    const held = [];
    for (let i = 0; i < ACT_RATE_PER_CALLER; i++)
      held.push(ok(await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE)));
    held[0].release();
    held[0].release();
    held[0].release();
    expect(code(await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE))).toBe('ok');
    expect(code(await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE))).toBe('rate_limited');
  });
});

describe('act budget label', () => {
  it('the act budget says actions', async () => {
    const h = harness();
    const c = createControlHandlers(h.deps);
    const NO_MOVE = ctxOf();
    for (let i = 0; i < ACT_RATE_PER_CALLER; i++)
      await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE);
    const r = await c.prepareOpenSession(caller(), sessionArgs(), NO_MOVE);
    expect(r.ok ? '' : r.error.message).toBe(
      `more than ${ACT_RATE_PER_CALLER} actions in a minute`,
    );
  });
});

describe('tool schemas (plan B5)', () => {
  // Flat JSON Schema only: no combinators or references a CLI's validator might reject.
  const ALLOWED = new Set([
    'type',
    'properties',
    'required',
    'enum',
    'items',
    'minItems',
    'maxItems',
    'maxLength',
    'minimum',
    'maximum',
    'default',
    'additionalProperties',
    'description',
  ]);
  const walk = (node: unknown, path: string, bad: string[]) => {
    if (typeof node !== 'object' || node === null) return;
    for (const [k, v] of Object.entries(node)) {
      if (!ALLOWED.has(k)) bad.push(`${path}.${k}`);
      if (k === 'properties' && typeof v === 'object' && v !== null) {
        for (const [p, sub] of Object.entries(v)) walk(sub, `${path}.properties.${p}`, bad);
      } else if (k === 'items') walk(v, `${path}.items`, bad);
    }
  };

  it('schemas use only the allowed keywords', () => {
    const bad: string[] = [];
    for (const t of toolSchemas(['claude'])) walk(t.inputSchema, t.name, bad);
    expect(bad).toEqual([]);
  });
});

describe('session tool descriptions', () => {
  it('state that focus:true can end on-screen access', () => {
    const sentence =
      " focus:true (default) moves the human's view to it, which can end your on-screen access; when opening several, pass focus:false for all but the last.";
    const byName = new Map(toolSchemas(['claude']).map((t) => [t.name, t.description]));
    for (const name of ['open_session', 'open_terminal'])
      expect(byName.get(name)?.endsWith(sentence)).toBe(true);
    expect(byName.get('open_file')).not.toContain('on-screen access');
  });
});
