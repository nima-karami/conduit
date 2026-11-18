import { describe, expect, it } from 'vitest';
import { createAppControlHandlers } from '../../src/conduit-mcp/app-control-tools';
import {
  type ControlCallContext,
  type ControlDeps,
  createControlHandlers,
  type Prepared,
} from '../../src/conduit-mcp/control-tools';
import { createMachineTools } from '../../src/conduit-mcp/machine-tools';
import type { Caller } from '../../src/conduit-mcp/tools';
import type { Result } from '../../src/conduit-mcp/types';
import type { RemoteCaller } from '../../src/contracts/remote-principal';

// The second layer of "a remote lead runs the six routed tools only" (CON-40 S2, plan decision 4).
// The frame parser and RoutedTool are the first; home() and localOnly are the ones these tests hold.
// Callers here are the handlers' own, since callAsRemote types its tool as a routed one.

const LEAD: RemoteCaller = {
  kind: 'remote',
  handle: 'claude-3',
  machineId: 'm-0123abcd',
  trust: 'own',
  controller: true,
  capabilities: { messaging: true, monitor: true, drive: true },
};
const remote: Caller = { handle: 'claude-3@m-0123abcd', sessionId: null, remote: LEAD };
const local: Caller = { handle: 'claude-1', sessionId: 'caller-1' };
const ctx: ControlCallContext = {
  stillCurrent: () => true,
  move: undefined,
  reach: 'any',
  signal: new AbortController().signal,
  ui: async () => ({
    ok: false,
    error: { code: 'window_not_ready', message: 'x', retryable: true },
  }),
};

/** Every call the fake world sees: a spy that stays empty when a guard holds. */
function world(over: Partial<ControlDeps> = {}) {
  const calls: string[] = [];
  const note = (name: string) => () => calls.push(name);
  const deps: ControlDeps = {
    selfName: () => 'this machine',
    homeOf: (id) => (id.startsWith('caller') ? '/w' : undefined),
    resolvePath: (home, p) => (p.startsWith('/') ? p : `${home}/${p}`),
    kindOf: async (abs) => {
      calls.push(`kindOf ${abs}`);
      return 'file';
    },
    agentIds: () => ['claude'],
    resolveCommand: (c) => `/usr/bin/${c}`,
    registeredIdOf: (n) => (n === 'claude' ? n : undefined),
    agents: () => [],
    openSession: async () => {
      calls.push('openSession');
      throw new Error('a remote open is not expected to reach the domain here');
    },
    openFile: async (req) => {
      calls.push(`openFile ${req.path}`);
      return { sessionId: req.callerSessionId ?? 'none' };
    },
    closeSession: async () => ({ ok: true }),
    claimHandle: () => null,
    now: () => 0,
    info: note('info'),
    foldersOf: () => undefined,
    addRoot: async (_id, p) => {
      calls.push(`addRoot ${p}`);
      return { ok: true };
    },
    activateSession: note('activateSession'),
    git: async () => ({ ok: false, stdout: '', stderr: 'no' }),
    realPath: async (p) => p,
    readBytes: async () => null,
    targets: () => [{ sessionId: 's1', handle: 'claude-2', openerSessionId: null }],
    ownerWindowOf: () => null,
    windowReady: () => false,
    modelFlagOf: () => undefined,
    commandModelFlag: () => undefined,
    messageReady: () => true,
    sendMessage: async () => {
      calls.push('sendMessage');
      return { ok: false, error: { code: 'not_messageable', message: 'x', retryable: false } };
    },
    ...over,
  };
  const control = createControlHandlers(deps);
  const app = createAppControlHandlers(deps, control.prepared);
  const machines = createMachineTools(
    { network: () => undefined, now: () => 0, setTimer: () => 0, clearTimer: () => {} },
    control.prepared,
  );
  return { calls, control, app, machines };
}

/** The code a prepare answers with, or 'prepared' when it reached the point of running. */
async function answerOf<T>(p: Promise<Result<Prepared<T>>>): Promise<string> {
  const r = await p;
  if (!r.ok) return r.error.code;
  return 'done' in r.value ? 'done' : 'prepared';
}

describe('a remote lead is refused the tools outside the six, and nothing runs', () => {
  it('list_machines: not_in_session, before the tool itself answers for no network', async () => {
    const w = world();
    expect(await answerOf(w.machines.prepareListMachines(remote, {}))).toBe('not_in_session');
  });

  it('open_file: not_in_session, and it never reaches the path or the open', async () => {
    const w = world();
    const r = await answerOf(w.control.prepareOpenFile(remote, { path: '/w/a.ts' }, ctx));
    expect(r).toBe('not_in_session');
    expect(w.calls).toEqual([]);
  });

  it('focus_session: not_in_session, and nothing is activated', async () => {
    const w = world();
    const r = await answerOf(w.app.prepareFocusSession(remote, { session: 's1' }, ctx));
    expect(r).toBe('not_in_session');
    expect(w.calls).toEqual([]);
  });

  it('attach_folder without a session: invalid_args, and no root is added', async () => {
    const w = world();
    const r = await answerOf(w.app.prepareAttachFolder(remote, { path: '/w/x' }, ctx));
    expect(r).toBe('invalid_args');
    expect(w.calls).toEqual([]);
  });

  it('the routed tools still prepare for the same remote lead', async () => {
    const w = world();
    expect(await answerOf(w.control.prepareListAgents(remote, {}))).toBe('prepared');
  });

  it('a local caller of focus_session is not refused by the guard', async () => {
    const w = world();
    const r = await answerOf(w.app.prepareFocusSession(local, { session: 's1' }, ctx));
    expect(r).not.toBe('not_in_session');
  });
});

// The B side of a routed attach_folder (CON-44 W5): a remote lead has no home here, so its path must
// be absolute, its folder must not be a credential store, and its session must be in reach.
describe('attach_folder from a remote lead, on the machine it names', () => {
  const named = { path: '/w/x', session: 'claude-2' };
  // The lead opened claude-2 here, so the remote reach (opened) admits it; attach_folder never offers any.
  const opened = { ...ctx, reach: 'opened' as const };
  const openedBy = [
    {
      sessionId: 's1',
      handle: 'claude-2',
      openerSessionId: null,
      remoteOpener: { handle: 'claude-3', machineId: 'm-0123abcd' },
    },
  ];

  it('a relative path is invalid_args that names this machine, and no root is added', async () => {
    const w = world({ targets: () => openedBy });
    const r = await w.app.prepareAttachFolder(remote, { path: 'sub', session: 'claude-2' }, opened);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({
      code: 'invalid_args',
      message: 'use an absolute path on this machine',
    });
    expect(w.calls).toEqual([]);
  });

  it('a denied folder is attach_refused, and no root is added', async () => {
    const w = world({ targets: () => openedBy });
    const r = await answerOf(
      w.app.prepareAttachFolder(remote, { path: '/home/u/.ssh', session: 'claude-2' }, opened),
    );
    expect(r).toBe('attach_refused');
    expect(w.calls).toEqual([]);
  });

  it('a folder whose real path is denied is attach_refused, and no root is added', async () => {
    const w = world({ realPath: async () => '/home/u/.ssh', targets: () => openedBy });
    const r = await answerOf(w.app.prepareAttachFolder(remote, named, opened));
    expect(r).toBe('attach_refused');
    expect(w.calls).toEqual([]);
  });

  it('a real absolute folder is added to the named session, at that path', async () => {
    const w = world({ targets: () => openedBy });
    const p = await w.app.prepareAttachFolder(remote, named, opened);
    expect(p.ok).toBe(true);
    if (!p.ok || 'done' in p.value) return;
    expect(p.value.summary).toEqual({ tool: 'attach_folder', path: '/w/x', target: 'claude-2' });
    expect((await p.value.run()).ok).toBe(true);
    expect(w.calls.filter((c) => c.startsWith('addRoot'))).toEqual(['addRoot /w/x']);
  });
});
