import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcp, type ServerMcp } from '../../server/mcp';
import type { McpOpenRequest } from '../../src/conduit-mcp/control-tools';
import { DEFAULT_TOOL_POLICY } from '../../src/conduit-mcp/tool-policy';
import type { McpHostDeps } from '../../src/contracts/server-ports';
import type { ServerEvents, WindowPresence } from '../../src/contracts/server-protocol';
import type {
  LaunchIds,
  RuntimeEvent,
  RuntimeTerminal,
} from '../../src/contracts/terminal-runtime';
import type { SubmitHooks } from '../../src/pty-writer';
import type { AgentDefinition, Session, SpawnSpec } from '../../src/types';
import { testEndpoint } from '../helpers/test-endpoint';

const FAKE: AgentDefinition = {
  id: 'e2e-fake-mcp',
  label: 'Fake MCP',
  command: '/usr/bin/node',
  args: ['fake.mjs'],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
};
const SHELL: AgentDefinition = { ...FAKE, id: 'pwsh', command: 'pwsh' };
const spec = (): SpawnSpec => ({
  command: '/usr/bin/node',
  args: ['fake.mjs'],
  cwd: '/w',
  env: {},
});
const noLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const dirs: string[] = [];
const mcps: ServerMcp[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const m of mcps.splice(0)) await m.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function harness(opts: { manualTimers?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-wiring-'));
  dirs.push(dir);
  const ep = testEndpoint();
  const clock = { t: 1_000_000 };
  const sessions = new Map<string, Session>();
  const terminals = new Map<string, RuntimeTerminal>();
  const screens = new Map<string, string>();
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const events: Array<{ type: string; data: unknown }> = [];
  const log: string[] = [];
  const submits: Array<{ sessionId: string; text: string; hooks: SubmitHooks | undefined }> = [];
  const opens: McpOpenRequest[] = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let timerN = 0;
  const advance = (ms: number) => {
    clock.t += ms;
    for (const [id, t] of [...timers])
      if (t.at <= clock.t) {
        timers.delete(id);
        t.fn();
      }
  };
  const manual = opts.manualTimers
    ? {
        setTimer: (fn: () => void, ms: number) => {
          timers.set(++timerN, { fn, at: clock.t + ms });
          return timerN;
        },
        clearTimer: (h: unknown) => {
          timers.delete(h as number);
        },
      }
    : {};
  let launchN = 0;
  const gens = new Map<string, number>();
  const allocateLaunch = (id: string): LaunchIds => {
    const generation = (gens.get(id) ?? 0) + 1;
    gens.set(id, generation);
    return { generation, launchId: (++launchN).toString(16).padStart(32, '0') };
  };
  const deps = {
    sessions: {
      get: (id: string) => sessions.get(id),
      list: () => [...sessions.values()],
      setMcp: (id: string, patch: Partial<Session>) => {
        const s = sessions.get(id);
        if (s) Object.assign(s, patch);
        return s !== undefined;
      },
      setMcpToolPolicy: () => true,
      touch: (id: string, minIntervalMs?: number) => {
        log.push(`touch ${id} ${minIntervalMs}`);
        return true;
      },
      setStatus: () => true,
      onChange: () => ({ dispose: () => [] }),
      allocateLaunch,
    } as McpHostDeps['sessions'],
    domain: {
      homeOf: (id: string) => sessions.get(id)?.home,
      resolvePath: (h: string, rel: string) => (rel.startsWith('/') ? rel : `${h}/${rel}`),
      kindOf: async () => 'dir' as const,
      agentIds: () => [FAKE.id],
      resolveCommand: (c: string) => `/usr/bin/${c}`,
      openSession: async (req: McpOpenRequest) => {
        opens.push(req);
        return { ok: true as const, sessionId: 'n1', label: 'N1' };
      },
      closeSession: async () => ({ ok: true as const }),
      foldersOf: (id: string) => {
        const s = sessions.get(id);
        return s ? { home: s.home, roots: [...s.roots] } : undefined;
      },
      addRoot: async () => ({ ok: true as const }),
      git: async () => ({ ok: false as const, stdout: '', stderr: '' }),
      defOf: (id: string) => (sessions.get(id)?.agentId === SHELL.id ? SHELL : FAKE),
      projectName: () => null,
      installState: () => 'not-installed' as const,
      messagingOn: () => true,
      toolPolicy: () => ({ global: DEFAULT_TOOL_POLICY, byCli: {} }),
    },
    attention: {
      statusOf: () => ({ busy: false, needsAttention: false, completedRun: false }),
      lastOutputAt: () => undefined,
      setVisible: (w: number, ids: readonly string[]) => {
        log.push(`visible ${w} ${ids.join(',')}`);
        return false;
      },
      dropWindow: (w: number) => {
        log.push(`drop ${w}`);
      },
      recordInput: (id: string, at: number) => {
        log.push(`input ${id} ${at}`);
      },
      clearAll: () => {
        log.push('clearAll');
      },
      onEdge: () => () => undefined,
      onChange: () => () => undefined,
    },
    typing: {
      submit: async (sessionId: string, text: string, hooks?: SubmitHooks) => {
        submits.push({ sessionId, text, hooks });
        // Held at the queue: the test plays the writer and runs the hooks at the slot itself.
        return new Promise<'withheld'>(() => undefined);
      },
      write: (id: string, data: string, opts?: { generation?: number }) => {
        log.push(`write ${id} ${JSON.stringify(data)} g${opts?.generation}`);
        return true;
      },
      forget: () => undefined,
    },
    screens: { ensure: () => undefined, keepTail: () => undefined, release: () => undefined },
    runtime: {
      get: (id: string) => terminals.get(id),
      screen: async (id: string) => {
        const line = screens.get(id);
        return line === undefined
          ? null
          : {
              lines: [line],
              cursorY: 0,
              cursorX: line.length,
              cursorRowStyles: '.'.repeat(line.length),
            };
      },
      on: (l: (e: RuntimeEvent) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    emit: <E extends keyof ServerEvents>(type: E, data: ServerEvents[E]) => {
      events.push({ type, data });
    },
  };
  const make = () =>
    createMcp({
      ...deps,
      dir,
      endpointPath: ep,
      shim: { execPath: '/rt/shim/node', shimPath: '/rt/shim/conduit-mcp-shim.cjs' },
      homeDir: dir,
      platform: 'linux',
      e2e: true,
      log: noLog,
      install: {
        env: {},
        userDataDir: dir,
        onPath: () => false,
        knownHome: () => null,
      },
      host: { now: () => clock.t, tickMs: 0, sleep: async () => undefined, ...manual },
    });
  let mcp = make();
  mcps.push(mcp);
  /** A server restart: the same userData, terminals and app, a fresh process. */
  const restart = async () => {
    await mcp.stop();
    mcp = make();
    mcps.push(mcp);
    await mcp.start();
  };
  /** C1 `spawned` for a terminal the new server adopted: no prepareLaunch in this run. */
  const adopt = (id: string) => {
    const t = terminals.get(id);
    if (!t) throw new Error(`no terminal ${id}`);
    for (const l of listeners)
      l({ type: 'spawned', sessionId: id, generation: t.generation, size: t.size });
  };
  const spawn = (id: string, generation: number) => {
    terminals.set(id, {
      sessionId: id,
      generation,
      launchId: 'x'.repeat(32),
      state: 'live',
      size: { cols: 40, rows: 24 },
      target: { hcSession: 'hc', terminal: id },
    });
    for (const l of listeners)
      l({ type: 'spawned', sessionId: id, generation, size: { cols: 40, rows: 24 } });
  };
  const addSession = (id: string, def = FAKE) =>
    sessions.set(id, {
      id,
      name: `S ${id}`,
      agentId: def.id,
      home: '/w',
      roots: [],
      status: 'running',
      createdAt: 0,
      lastActiveAt: 0,
    });
  const launch = async (id: string, def = FAKE) => {
    if (!sessions.has(id)) addSession(id, def);
    const ids = allocateLaunch(id);
    const out = await mcp.launch.prepareLaunch(id, def, spec(), ids);
    spawn(id, ids.generation);
    return { out, ids, token: out.env?.CONDUIT_SESSION_TOKEN ?? null };
  };
  return {
    get mcp() {
      return mcp;
    },
    restart,
    adopt,
    advance,
    dir,
    ep,
    clock,
    sessions,
    screens,
    events,
    log,
    submits,
    opens,
    launch,
    of: <E extends keyof ServerEvents>(type: E) =>
      events.filter((e) => e.type === type).map((e) => e.data as ServerEvents[E]),
  };
}

/** A gen-2 shim's side of the wire, by hand. */
async function client(
  ep: string,
  token: string | null,
  opts: { name?: string; resume?: boolean } = {},
) {
  const params = {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: opts.name ?? 'fake' },
  };
  const sock = net.connect(ep);
  sockets.push(sock);
  sock.setEncoding('utf8');
  const lines: Array<Record<string, unknown>> = [];
  let buf = '';
  sock.on('data', (d: string) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
    }
  });
  const resume = opts.resume ? { initialize: params, initialized: true } : null;
  sock.write(`${JSON.stringify({ conduit: 2, token, shim: 'test', resume })}\n`);
  await expect.poll(() => lines[0]).toEqual({ conduit: 2, ok: true });
  const send = (m: Record<string, unknown>) =>
    sock.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  if (resume) {
    await expect
      .poll(() => lines.some((l) => l.method === 'notifications/tools/list_changed'))
      .toBe(true);
    return { lines, send, sock };
  }
  send({ id: 0, method: 'initialize', params });
  await expect.poll(() => lines.some((l) => l.id === 0)).toBe(true);
  send({ method: 'notifications/initialized' });
  return { lines, send, sock };
}

const win = (windowId: number, over: Partial<WindowPresence> = {}): WindowPresence => ({
  windowId,
  focused: true,
  ready: true,
  visibleSessionIds: [],
  ownedSessionIds: [],
  ...over,
});

describe('LaunchPort', () => {
  it('reserves a persisted token row and injects the MCP env and argv', async () => {
    const h = harness();
    await h.mcp.start();
    await h.mcp.launch.whenLaunchReady();
    const { out, ids, token } = await h.launch('s1');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(out.env?.CONDUIT_MCP_ENDPOINT).toBe(h.ep);
    expect(out.args.length).toBeGreaterThan(spec().args.length);
    const disk = JSON.parse(fs.readFileSync(path.join(h.dir, 'tokens.json'), 'utf8'));
    expect(disk.rows).toEqual([
      expect.objectContaining({ sessionId: 's1', launchId: ids.launchId, state: 'reserved' }),
    ]);
    expect(JSON.stringify(disk)).not.toContain(token);
    expect(h.mcp.tokens.rows()).toMatchObject({ state: 'loaded' });
  });

  it('a new launch resets the session: the earlier token stops resolving', async () => {
    const h = harness();
    await h.mcp.start();
    const first = await h.launch('s1');
    const second = await h.launch('s1');
    expect(second.token).not.toBe(first.token);
    const rows = h.mcp.tokens.rows();
    expect(rows.state === 'loaded' && rows.rows.map((r) => r.launchId)).toEqual([
      second.ids.launchId,
    ]);
    const sock = net.connect(h.ep);
    sockets.push(sock);
    const got: string[] = [];
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => got.push(d));
    sock.write(`${JSON.stringify({ conduit: 2, token: first.token, shim: 't', resume: null })}\n`);
    await expect.poll(() => got.join('')).toContain('unknown_token');
  });

  it('onSessionDeleted revokes every row of the session', async () => {
    const h = harness();
    await h.mcp.start();
    await h.launch('s1');
    await h.mcp.launch.onSessionDeleted('s1');
    expect(h.mcp.tokens.rows()).toEqual({ state: 'loaded', rows: [] });
  });
});

describe('term.input', () => {
  it('does the host bookkeeping, reports input and touches, then writes through TypingPort', async () => {
    const h = harness();
    await h.mcp.start();
    const { ids } = await h.launch('s1');
    h.log.length = 0;
    h.mcp.termInput({ sessionId: 's1', generation: ids.generation, data: 'x' });
    expect(h.log).toEqual([
      `input s1 ${h.clock.t}`,
      'touch s1 30000',
      `write s1 "x" g${ids.generation}`,
    ]);
  });

  it('a stale generation is neither written nor counted', async () => {
    const h = harness();
    await h.mcp.start();
    const { ids } = await h.launch('s1');
    h.log.length = 0;
    h.mcp.termInput({ sessionId: 's1', generation: ids.generation - 1, data: 'x' });
    expect(h.log).toEqual([]);
  });
});

describe('notices through TypingPort', () => {
  it('submitNotice gates at the queue slot: input typed after the enqueue closes it', async () => {
    const h = harness();
    await h.mcp.start();
    const { token, ids } = await h.launch('s1');
    await client(h.ep, token);
    h.screens.set('s1', 'fake❯ ');
    h.clock.t += 10_000;
    const handle = h.sessions.get('s1')?.mcpHandle;
    expect(handle).toBeTruthy();
    await h.mcp.fromRenderer(
      {},
      {
        windowId: 1,
        message: {
          type: 'mcp:compose',
          requestId: 1,
          to: [handle ?? ''],
          body: 'hello',
          priority: 'normal',
          kind: 'inform',
        },
      },
    );
    void h.mcp.tick();
    await expect.poll(() => h.submits.length).toBe(1);
    const hooks = h.submits[0]?.hooks;
    expect(hooks?.beforeText && hooks.beforeEnter).toBeTruthy();
    expect(await hooks?.beforeText?.()).toBe(true);
    h.mcp.termInput({ sessionId: 's1', generation: ids.generation, data: 'd' });
    expect(await hooks?.beforeText?.()).toBe(false);
  });
});

describe('approvals', () => {
  const OPEN = { path: '/w', agent: FAKE.id };

  async function asking() {
    const h = harness();
    await h.mcp.start();
    const { token } = await h.launch('s1');
    const app = {};
    h.mcp.presence(app, [win(1, { ownedSessionIds: ['s1'], visibleSessionIds: ['s1'] })]);
    const c = await client(h.ep, token);
    c.send({ id: 5, method: 'tools/call', params: { name: 'open_session', arguments: OPEN } });
    await expect.poll(() => h.mcp.pendingAsks().length).toBe(1);
    return { h, c, app };
  }

  it('an open ask is in the pending list and approvals.changed', async () => {
    const { h } = await asking();
    const ask = h.mcp.pendingAsks()[0];
    expect(ask).toMatchObject({ callerSessionId: 's1', tool: 'open_session' });
    expect(h.of('approvals.changed').at(-1)?.pending).toEqual([ask]);
  });

  it('an app disconnect keeps the ask; the reconnected window answers it from the snapshot', async () => {
    const { h, c, app } = await asking();
    h.mcp.appDisconnected(app);
    expect(h.mcp.pendingAsks()).toHaveLength(1);
    const back = {};
    h.mcp.presence(back, [win(1, { ownedSessionIds: ['s1'], visibleSessionIds: ['s1'] })]);
    const askId = h.mcp.pendingAsks()[0]?.askId ?? '';
    await h.mcp.fromRenderer(back, {
      windowId: 1,
      message: { type: 'mcp:askAnswer', askId, answer: 'approve' },
    });
    await expect.poll(() => h.opens.length).toBe(1);
    await expect.poll(() => c.lines.some((l) => l.id === 5)).toBe(true);
    expect(h.mcp.pendingAsks()).toEqual([]);
    expect(h.of('approvals.changed').at(-1)?.pending).toEqual([]);
  });

  it('a window that does not own the session cannot answer', async () => {
    const { h, app } = await asking();
    h.mcp.presence(app, [win(1, { ownedSessionIds: ['s1'], visibleSessionIds: ['s1'] }), win(2)]);
    const askId = h.mcp.pendingAsks()[0]?.askId ?? '';
    await h.mcp.fromRenderer(app, {
      windowId: 2,
      message: { type: 'mcp:askAnswer', askId, answer: 'approve' },
    });
    expect(h.opens).toEqual([]);
    expect(h.mcp.pendingAsks()).toHaveLength(1);
  });

  it('the owning window going not-ready resets its asks (F7 step 3)', async () => {
    const { h, c, app } = await asking();
    h.mcp.presence(app, [win(1, { ready: false, ownedSessionIds: ['s1'] })]);
    await expect.poll(() => c.lines.some((l) => l.id === 5)).toBe(true);
    expect(h.mcp.pendingAsks()).toEqual([]);
    expect(h.opens).toEqual([]);
  });

  it('a session moving to another window cancels its asks', async () => {
    const { h, c, app } = await asking();
    h.mcp.presence(app, [win(1), win(2, { ownedSessionIds: ['s1'], visibleSessionIds: ['s1'] })]);
    await expect.poll(() => c.lines.some((l) => l.id === 5)).toBe(true);
    expect(h.mcp.pendingAsks()).toEqual([]);
  });

  it('routes a window message under the app’s own window id', async () => {
    const h = harness();
    await h.mcp.start();
    const { token } = await h.launch('s1');
    const app = {};
    h.mcp.presence({}, [win(1)]);
    h.mcp.presence(app, [win(7, { ownedSessionIds: ['s1'], visibleSessionIds: ['s1'] })]);
    const c = await client(h.ep, token);
    c.send({
      id: 9,
      method: 'tools/call',
      params: { name: 'open_url', arguments: { url: 'https://example.com' } },
    });
    const uiStep = () => h.of('ui.post').find((p) => p.message.type === 'mcp:ui');
    await expect.poll(() => h.mcp.pendingAsks().length > 0 || uiStep() !== undefined).toBe(true);
    const askId = h.mcp.pendingAsks()[0]?.askId;
    if (askId)
      await h.mcp.fromRenderer(app, {
        windowId: 7,
        message: { type: 'mcp:askAnswer', askId, answer: 'approve' },
      });
    await expect.poll(uiStep).toBeDefined();
    const step = uiStep();
    expect(step?.route).toEqual({ kind: 'window', windowId: 7 });
    if (step?.message.type !== 'mcp:ui') throw new Error('no ui step');
    await h.mcp.fromRenderer(app, {
      windowId: 7,
      message: {
        type: 'mcp:uiResult',
        requestId: step.message.requestId,
        result: { kind: 'opened' },
      },
    });
    await expect.poll(() => c.lines.find((l) => l.id === 9)).toBeDefined();
    const result = c.lines.find((l) => l.id === 9)?.result as { isError?: boolean } | undefined;
    expect(result?.isError).not.toBe(true);
  });
});

describe('D28 bindings across a server restart', () => {
  const bindingsOf = (h: { dir: string }) => {
    const f = path.join(h.dir, 'bindings.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).bindings : undefined;
  };
  /** A shell where the person typed \`codex\` and Codex connected, then a server restart. */
  async function typedCodexThenRestart() {
    const h = harness();
    await h.mcp.start();
    const { token, ids } = await h.launch('s1', SHELL);
    h.mcp.termInput({ sessionId: 's1', generation: ids.generation, data: 'codex\r' });
    await client(h.ep, token, { name: 'codex-mcp-client' });
    await expect
      .poll(() => bindingsOf(h))
      .toEqual([
        {
          sessionId: 's1',
          generation: ids.generation,
          cli: 'codex',
          clientInfoName: 'codex-mcp-client',
        },
      ]);
    // The stopping server closes the connection itself; the binding must outlive that.
    await h.restart();
    expect(bindingsOf(h)).toHaveLength(1);
    h.adopt('s1');
    return { h, token };
  }
  const notice = async (h: ReturnType<typeof harness>) => {
    h.screens.set('s1', '›');
    h.clock.t += 10_000;
    const handle = h.sessions.get('s1')?.mcpHandle ?? '';
    const sent = await h.mcp.fromRenderer(
      {},
      {
        windowId: 1,
        message: {
          type: 'mcp:compose',
          requestId: 1,
          to: [handle],
          body: 'hi',
          priority: 'normal',
          kind: 'inform',
        },
      },
    );
    expect(sent.reply).toMatchObject({ result: { ok: true } });
  };

  it('bindings rebind on resume: the matching client gets the typed CLI’s notices', async () => {
    const { h, token } = await typedCodexThenRestart();
    await client(h.ep, token, { name: 'codex-mcp-client', resume: true });
    await notice(h);
    void h.mcp.tick();
    await expect.poll(() => h.submits.map((x) => x.sessionId)).toEqual(['s1']);
  });

  it('a typed CLI still gets notices after a server restart; another client of the token stays secondary', async () => {
    const { h, token } = await typedCodexThenRestart();
    await client(h.ep, token, { name: 'some-other-client', resume: true });
    await notice(h);
    await h.mcp.tick();
    expect(h.submits).toEqual([]);
    // The rebind still waits for its own client, which takes it even after another one connected.
    await client(h.ep, token, { name: 'codex-mcp-client', resume: true });
    void h.mcp.tick();
    await expect.poll(() => h.submits.map((x) => x.sessionId)).toEqual(['s1']);
  });

  it('an adopted shell still detects a newly typed CLI (detectTyped on term.input)', async () => {
    const { h, token } = await typedCodexThenRestart();
    h.mcp.termInput({ sessionId: 's1', generation: 1, data: 'opencode\r' });
    await client(h.ep, token, { name: 'opencode' });
    await expect
      .poll(() => bindingsOf(h))
      .toEqual([{ sessionId: 's1', generation: 1, cli: 'opencode', clientInfoName: 'opencode' }]);
  });

  it('a new launch drops the binding', async () => {
    const { h } = await typedCodexThenRestart();
    await h.launch('s1', SHELL);
    expect(bindingsOf(h)).toEqual([]);
  });
});

describe('D8 grace: no app for 5 s', () => {
  async function askingManual() {
    const h = harness({ manualTimers: true });
    await h.mcp.start();
    const { token } = await h.launch('s1');
    const app = {};
    h.mcp.presence(app, [win(1, { ownedSessionIds: ['s1'], visibleSessionIds: ['s1'] })]);
    const c = await client(h.ep, token);
    c.send({
      id: 5,
      method: 'tools/call',
      params: { name: 'open_session', arguments: { path: '/w', agent: FAKE.id } },
    });
    await expect.poll(() => h.mcp.pendingAsks().length).toBe(1);
    return { h, c, app };
  }
  const errorOf = (l: Record<string, unknown> | undefined) => {
    const r = l?.result as { content: Array<{ text: string }> } | undefined;
    return r ? JSON.parse(r.content[0]?.text ?? '{}').error?.code : undefined;
  };

  it('denies every waiting ask with ui_unavailable when the grace runs out', async () => {
    const { h, c, app } = await askingManual();
    h.mcp.appDisconnected(app);
    h.advance(4_900);
    expect(h.mcp.pendingAsks()).toHaveLength(1);
    h.advance(200);
    await expect.poll(() => errorOf(c.lines.find((l) => l.id === 5))).toBe('ui_unavailable');
    expect(h.mcp.pendingAsks()).toEqual([]);
    expect(h.opens).toEqual([]);
  });

  it('an app back within the grace keeps the asks', async () => {
    const { h, app } = await askingManual();
    h.mcp.appDisconnected(app);
    h.advance(3_000);
    h.mcp.presence({}, [win(1, { ownedSessionIds: ['s1'], visibleSessionIds: ['s1'] })]);
    h.advance(10_000);
    expect(h.mcp.pendingAsks()).toHaveLength(1);
  });
});
