import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AgentIdentityAdapter,
  AgentIdentityLaunch,
  AgentIdentityObserver,
  ConversationReference,
  ConversationScope,
  IdentityUnbindReason,
} from '../contracts/agent-identity';
import { codexLaunchArgs } from './codex-argv';
import {
  type CodexServer,
  defaultCodexRendezvousDir,
  readSavedCodexThread,
  startCodexServer,
} from './codex-process';
import { type CodexPeer, CodexRpcError, type JsonObject, object } from './codex-rpc';

interface CodexIdentityDeps {
  rendezvousDir?: string;
  start?: typeof startCodexServer;
  readSaved?: typeof readSavedCodexThread;
  defaultCommand?: string;
}

interface LaunchState {
  launch: AgentIdentityLaunch;
  observer?: AgentIdentityObserver;
  server?: CodexServer;
  peer?: CodexPeer;
  primary?: string;
  expected?: string;
  intent?: string;
  bound: boolean;
  unavailable?: IdentityUnbindReason;
  prepared: boolean;
  connection: number;
  nameEvent: number;
  lastName?: string;
  writes: Promise<void>;
}

const THREAD_ID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

function pathKey(path: string): string {
  const full = resolve(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function sameScope(a: ConversationScope, b: ConversationScope): boolean {
  return (
    a.machineId === b.machineId &&
    pathKey(a.cwd) === pathKey(b.cwd) &&
    pathKey(a.storageHome) === pathKey(b.storageHome)
  );
}

function missing(error: unknown, id: string): boolean {
  return (
    error instanceof CodexRpcError &&
    error.code === -32600 &&
    [
      `no rollout found for thread id ${id}`,
      `thread not found: ${id}`,
      `thread not loaded: ${id}`,
    ].includes(error.message)
  );
}

const readParams = (id: string) => ({ threadId: id, includeTurns: false });

export function createCodexIdentityAdapter(deps: CodexIdentityDeps = {}) {
  const start = deps.start ?? startCodexServer;
  const rendezvousDir = deps.rendezvousDir ?? defaultCodexRendezvousDir();
  const readSaved = deps.readSaved ?? readSavedCodexThread;
  const launches = new Map<string, LaunchState>();
  const sessions = new Map<string, LaunchState>();

  const current = (state: LaunchState) =>
    launches.get(state.launch.ids.launchId) === state &&
    sessions.get(state.launch.sessionId) === state &&
    !state.launch.signal.aborted;

  const usable = (state: LaunchState) => current(state) && !state.unavailable;

  function retire(state: LaunchState) {
    if (launches.get(state.launch.ids.launchId) === state)
      launches.delete(state.launch.ids.launchId);
    if (sessions.get(state.launch.sessionId) === state) sessions.delete(state.launch.sessionId);
    state.connection++;
    state.peer?.close();
    state.server?.close();
  }

  function record(launch: AgentIdentityLaunch): LaunchState {
    launch.signal.throwIfAborted();
    const existing = launches.get(launch.ids.launchId);
    if (existing) {
      if (
        existing.launch.ids.generation !== launch.ids.generation ||
        existing.launch.sessionId !== launch.sessionId ||
        !sameScope(existing.launch.scope, launch.scope)
      )
        throw new Error('Codex identity launch collision');
      return existing;
    }
    const prior = sessions.get(launch.sessionId);
    if (prior && prior.launch.ids.generation >= launch.ids.generation)
      throw new Error('Stale Codex identity launch');
    if (prior) retire(prior);
    const state: LaunchState = {
      launch,
      bound: false,
      prepared: false,
      connection: 0,
      nameEvent: 0,
      writes: Promise.resolve(),
    };
    launches.set(launch.ids.launchId, state);
    sessions.set(launch.sessionId, state);
    launch.signal.addEventListener('abort', () => retire(state), { once: true });
    return state;
  }

  function invalidate(state: LaunchState, reason: IdentityUnbindReason) {
    if (!usable(state)) return;
    state.unavailable = reason;
    state.observer?.unbind(reason);
  }

  function deliver(state: LaunchState, name: unknown) {
    if (!usable(state) || !state.primary || typeof name !== 'string' || !name.trim()) return;
    if (state.lastName === name) return;
    state.lastName = name;
    if (state.bound)
      state.observer?.rename({ conversationId: state.primary, name, source: 'native' });
  }

  function bind(state: LaunchState) {
    if (state.bound || !state.primary || !state.observer || !usable(state)) return;
    state.bound = true;
    state.observer.bind(state.primary);
    if (state.lastName !== undefined && usable(state)) {
      state.observer.rename({
        conversationId: state.primary,
        name: state.lastName,
        source: 'native',
      });
    }
  }

  function set(state: LaunchState, id: string, name: string): Promise<void> {
    const write = state.writes.then(async () => {
      if (!usable(state) || state.primary !== id || !state.peer)
        throw new Error('Codex primary thread is unavailable');
      // The response acknowledges our request. The broadcast has no request ID.
      await state.peer.request('thread/name/set', { threadId: id, name });
    });
    state.writes = write.catch(() => undefined);
    return write;
  }

  function pin(state: LaunchState, id: string) {
    if (!usable(state) || state.primary || !THREAD_ID.test(id)) return;
    state.primary = id;
    if (state.intent !== undefined) {
      void set(state, id, state.intent).catch(() => {
        // The domain's pending-name write owns the visible failure and retry.
      });
    }
    bind(state);
  }

  function notify(state: LaunchState, method: string, params: JsonObject) {
    if (!usable(state)) return;
    const thread = object(params.thread);
    if (method === 'thread/started' && !state.expected && !state.primary) {
      if (typeof thread.id === 'string' && !thread.forkedFromId && !thread.parentThreadId)
        pin(state, thread.id);
      return;
    }
    if (!state.primary || params.threadId !== state.primary) return;
    if (method === 'thread/name/updated') {
      state.nameEvent++;
      deliver(state, params.threadName);
    } else if (method === 'thread/archived') {
      invalidate(state, 'primary-archived');
    } else if (method === 'thread/deleted') {
      invalidate(state, 'primary-deleted');
    }
  }

  async function reconcile(state: LaunchState, peer: CodexPeer) {
    const id = state.primary;
    if (!id) return;
    const sequence = state.nameEvent;
    try {
      const { data } = await peer.request('thread/list', {
        includedThreadIds: [id],
        archived: true,
      });
      if (peer !== state.peer) return;
      if (Array.isArray(data) && data.some((row) => object(row).id === id)) {
        invalidate(state, 'primary-archived');
        return;
      }
      const { thread } = await peer.request('thread/read', readParams(id));
      if (peer !== state.peer) return;
      const row = object(thread);
      if (row.id !== id) throw new Error('Codex did not confirm the primary thread');
      if (sequence === state.nameEvent) deliver(state, row.name);
    } catch (error) {
      if (peer === state.peer && missing(error, id)) invalidate(state, 'primary-deleted');
      else throw error;
    }
  }

  async function awaitResume(state: LaunchState, peer: CodexPeer) {
    const id = state.expected;
    if (!id) return;
    try {
      while (usable(state) && state.peer === peer) {
        const { data } = await peer.request('thread/loaded/list', {});
        if (Array.isArray(data) && data.includes(id)) {
          pin(state, id);
          return;
        }
        await delay(500, undefined, { signal: state.launch.signal });
      }
    } catch {
      if (state.peer === peer) invalidate(state, 'server-exited');
    }
  }

  async function open(state: LaunchState, retry = false) {
    const serial = ++state.connection;
    const stillCurrent = () => usable(state) && serial === state.connection;
    const server = state.server;
    if (!server) throw new Error('Codex App Server has not started');
    try {
      const peer = await server.connect({
        notify: (method, params) => {
          if (stillCurrent()) notify(state, method, params);
        },
        disconnected: () => {
          if (!stillCurrent() || !state.peer) return;
          state.peer = undefined;
          void open(state, true).catch(() => invalidate(state, 'server-exited'));
        },
      });
      if (!stillCurrent()) {
        peer.close();
        return;
      }
      state.peer = peer;
      if (retry && !state.primary && !state.expected) {
        invalidate(state, 'server-exited');
        return;
      }
      if (retry) await reconcile(state, peer);
      if (!state.primary) void awaitResume(state, peer);
    } catch (error) {
      if (stillCurrent()) throw error;
    }
  }

  async function prepare(launch: AgentIdentityLaunch, name: string, ref?: ConversationReference) {
    const options = codexLaunchArgs(launch.argv, ref !== undefined);
    if (
      ref &&
      (ref.adapterId !== 'codex' ||
        !THREAD_ID.test(ref.conversationId) ||
        !sameScope(ref.scope, launch.scope))
    )
      throw new Error('Invalid Codex resume reference');
    const state = record(launch);
    if (state.prepared) throw new Error('Codex launch already prepared');
    state.prepared = true;
    state.expected = ref?.conversationId;
    state.intent = name;
    const argv = ref ? ['resume', ...options.tui, ref.conversationId] : options.tui;
    try {
      const server = await start(launch, options.server, argv, rendezvousDir);
      if (!usable(state)) {
        server.close();
        throw new Error('Stale Codex identity launch');
      }
      state.server = server;
      server.onExit?.(() => invalidate(state, 'server-exited'));
      const initialize = async () => {
        await open(state);
        if (!usable(state) || !state.peer) throw new Error('Codex identity launch is unavailable');
        if (ref) {
          const { thread } = await state.peer.request(
            'thread/read',
            readParams(ref.conversationId),
          );
          if (object(thread).id !== ref.conversationId)
            throw new Error('Codex did not confirm the resume thread');
          if (object(thread).name !== name) {
            await state.peer.request('thread/name/set', { threadId: ref.conversationId, name });
          }
          state.intent = undefined;
        }
        if (usable(state)) await server.release?.();
      };
      const preparation = initialize();
      if (server.release) {
        // The wrapper publishes its endpoint after the runtime has spawned the PTY.
        void preparation.catch(() => invalidate(state, 'server-exited'));
      } else {
        await preparation;
      }
      return {
        command: server.command,
        argv: server.command
          ? server.tuiArgs
          : ref
            ? ['resume', ...server.tuiArgs, ...options.tui, ref.conversationId]
            : [...server.tuiArgs, ...options.tui],
        env: server.env,
      };
    } catch (error) {
      retire(state);
      throw error;
    }
  }

  const capabilities = { coupledNaming: true, exactResume: true, primaryThreadOnly: true } as const;
  return {
    id: 'codex',
    capabilities,
    fresh: (launch, name) => prepare(launch, name),
    resume: (launch, ref, name) => prepare(launch, name, ref),
    async exists(ref) {
      const id = ref.conversationId;
      if (ref.adapterId !== 'codex' || !THREAD_ID.test(id)) return 'missing';
      const live = launches.get(ref.capturedAt.launchId);
      try {
        const result =
          live?.primary === id &&
          usable(live) &&
          live.peer &&
          sameScope(live.launch.scope, ref.scope)
            ? await live.peer.request('thread/read', readParams(id))
            : await readSaved(ref.scope, id, deps.defaultCommand ?? 'codex');
        const row = object(result.thread);
        return row.id === id &&
          typeof row.cwd === 'string' &&
          pathKey(row.cwd) === pathKey(ref.scope.cwd)
          ? 'present'
          : 'unavailable';
      } catch (error) {
        return missing(error, id) ? 'missing' : 'unavailable';
      }
    },
    async setName(ref, name, _revision) {
      const state = launches.get(ref.capturedAt.launchId);
      if (
        !state ||
        ref.adapterId !== 'codex' ||
        state.launch.ids.generation !== ref.capturedAt.generation ||
        !sameScope(state.launch.scope, ref.scope)
      )
        throw new Error('Stale Codex identity reference');
      await set(state, ref.conversationId, name);
    },
    async observe(launch, observer) {
      const state = record(launch);
      state.observer = observer;
      if (state.unavailable) observer.unbind(state.unavailable);
      else bind(state);
    },
    async adopt(launch, ref, observer) {
      const state = record(launch);
      state.observer = observer;
      if (state.prepared) return;
      state.prepared = true;
      if (
        ref?.adapterId !== 'codex' ||
        ref.capturedAt.launchId !== launch.ids.launchId ||
        ref.capturedAt.generation !== launch.ids.generation ||
        !sameScope(ref.scope, launch.scope) ||
        !THREAD_ID.test(ref.conversationId)
      ) {
        invalidate(state, 'server-exited');
        return;
      }
      state.primary = ref.conversationId;
      try {
        const server = await start(launch, [], [], rendezvousDir, true);
        if (!usable(state)) {
          server.close();
          return;
        }
        state.server = server;
        server.onExit?.(() => invalidate(state, 'server-exited'));
        await open(state, true);
        bind(state);
      } catch {
        invalidate(state, 'server-exited');
      }
    },
  } satisfies AgentIdentityAdapter;
}
