import { join, resolve } from 'node:path';
import type {
  AgentIdentityAdapter,
  AgentIdentityLaunch,
  AgentIdentityObserver,
  ConversationReference,
  ConversationScope,
  IdentityUnbindReason,
  NativeNameEvent,
  NativeNameSync,
  ResumeRefusalReason,
} from '../../src/contracts/agent-identity';
import type { LaunchIds } from '../../src/contracts/terminal-runtime';
import { folderKey } from '../../src/folder-key';
import { commandLeaf } from '../../src/launch-args';
import { coupledAdapterId, validConversationRef } from '../../src/session-agent-identity';
import type { Session, SpawnSpec } from '../../src/types';

interface ActiveIdentity {
  adapter: AgentIdentityAdapter;
  controller: AbortController;
  ids: LaunchIds;
  bound: Promise<boolean>;
  conversationId?: string;
  expectedResume: boolean;
  adopting: boolean;
  activate(): void;
  writingConversation?: string;
  awaitingNativeTitle: boolean;
  writes: Promise<void>;
}

export function createIdentityRegistry(deps: {
  adapters: readonly AgentIdentityAdapter[];
  machineId: () => string;
  homeDir: string;
  session: (id: string) => Session | undefined;
  save: (id: string, ref: ConversationReference) => void;
  nativeRename: (id: string, name: string) => void;
  sync: (id: string, revision: number, status: NativeNameSync) => void;
  changed: () => void;
  warn: (message: string, data: Record<string, unknown>) => void;
}) {
  const active = new Map<string, ActiveIdentity>();
  const unavailable = new Map<string, string>();
  const adapters = new Map(deps.adapters.map((adapter) => [adapter.id, adapter]));
  const adapterFor = (session: Session, command: string) => {
    const id = coupledAdapterId(session.agentId);
    return id && id === commandLeaf(command) ? adapters.get(id) : undefined;
  };
  const scopeOf = (spec: SpawnSpec, adapter: AgentIdentityAdapter): ConversationScope => {
    const override = spec.env?.[adapter.id === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'];
    const home = spec.env?.HOME || spec.env?.USERPROFILE || deps.homeDir;
    return {
      cwd: spec.cwd,
      storageHome: override ? resolve(spec.cwd, override) : join(home, `.${adapter.id}`),
      machineId: deps.machineId(),
    };
  };

  function close(id: string) {
    unavailable.delete(id);
    active.get(id)?.controller.abort();
    active.delete(id);
  }

  function sendName(id: string) {
    const instance = active.get(id);
    const state = deps.session(id)?.namingState;
    if (
      !instance?.conversationId ||
      !instance.adapter.capabilities.coupledNaming ||
      state?.naming !== 'coupled' ||
      state.nativeSync.status !== 'pending'
    )
      return;
    const revision = state.revision;
    const conversationId = instance.conversationId;
    instance.awaitingNativeTitle = false;
    instance.writes = instance.writes.then(async () => {
      const session = deps.session(id);
      const next = session?.namingState;
      const ref = session?.conversationRef;
      if (
        active.get(id) !== instance ||
        next?.naming !== 'coupled' ||
        next.revision !== revision ||
        next.nativeSync.status !== 'pending' ||
        !ref ||
        ref.conversationId !== conversationId ||
        instance.conversationId !== conversationId
      )
        return;
      instance.writingConversation = conversationId;
      try {
        await instance.adapter.setName(ref, next.name, revision);
        if (active.get(id) === instance && instance.conversationId === conversationId)
          deps.sync(id, revision, { status: 'synced' });
      } catch (error) {
        deps.warn('agent name update failed', { sessionId: id, error: String(error) });
        if (active.get(id) === instance && instance.conversationId === conversationId)
          deps.sync(id, revision, { status: 'failed', reason: 'Agent name could not be updated.' });
      } finally {
        delete instance.writingConversation;
      }
    });
  }

  function hasIdentityConflict(adapter: AgentIdentityAdapter, argv: readonly string[]): boolean {
    return argv.some(
      (arg, index) =>
        /^(--(resume|continue|last|session-id|fork-session|name)(=|$)|-r$|-n$)/.test(arg) ||
        (adapter.id === 'claude' && arg === '-c') ||
        (adapter.id === 'codex' && index === 0 && (arg === 'resume' || arg === 'fork')),
    );
  }

  async function check(
    adapter: AgentIdentityAdapter,
    ref: ConversationReference,
    spec: SpawnSpec,
  ): Promise<ResumeRefusalReason | undefined> {
    if (!validConversationRef(ref) || ref.adapterId !== adapter.id)
      return 'resume-reference-invalid';
    const scope = scopeOf(spec, adapter);
    if (
      ref.scope.machineId !== scope.machineId ||
      folderKey(ref.scope.cwd) !== folderKey(scope.cwd) ||
      folderKey(ref.scope.storageHome) !== folderKey(scope.storageHome)
    )
      return 'resume-scope-mismatch';
    if (hasIdentityConflict(adapter, spec.args)) return 'resume-argv-conflict';
    try {
      const exists = await adapter.exists(ref);
      if (exists === 'missing') return 'resume-conversation-missing';
      if (exists !== 'present') return 'resume-check-unavailable';
    } catch (error) {
      deps.warn('conversation existence check failed', { error: String(error) });
      return 'resume-check-unavailable';
    }
  }

  function register(
    session: Session,
    spec: SpawnSpec,
    ids: LaunchIds,
    adapter: AgentIdentityAdapter,
    ref: ConversationReference | undefined,
    adopting: boolean,
  ) {
    close(session.id);
    const controller = new AbortController();
    const scope = adopting && ref ? ref.scope : scopeOf(spec, adapter);
    const launch: AgentIdentityLaunch = {
      sessionId: session.id,
      ids,
      scope,
      command: spec.command,
      argv: spec.args,
      env: spec.env ?? {},
      signal: controller.signal,
    };
    let settle: (bound: boolean) => void = () => {};
    const instance: ActiveIdentity = {
      adapter,
      controller,
      ids,
      expectedResume: !!ref && !adopting,
      adopting,
      bound: new Promise((resolveBound) => {
        settle = resolveBound;
      }),
      activate: () => {},
      awaitingNativeTitle: false,
      writes: Promise.resolve(),
    };
    controller.signal.addEventListener('abort', () => settle(false), { once: true });
    active.set(session.id, instance);
    const current = () => active.get(session.id) === instance && !controller.signal.aborted;
    let spawned = adopting;
    let pendingId: string | undefined;
    function recordBinding() {
      if (!pendingId || pendingId === instance.conversationId || !spawned || !current()) return;
      try {
        deps.save(session.id, {
          version: 1,
          adapterId: adapter.id,
          conversationId: pendingId,
          scope,
          capturedAt: ids,
        });
        const initialBind = !instance.conversationId;
        instance.conversationId = pendingId;
        settle(true);
        if (adopting && initialBind) deps.changed();
        instance.awaitingNativeTitle = !initialBind;
        if (!initialBind) return;
        const state = deps.session(session.id)?.namingState;
        if (
          state?.naming === 'coupled' &&
          (state.nativeSync.status === 'failed' || (!ref && state.nativeSync.status === 'synced'))
        )
          deps.sync(session.id, state.revision, { status: 'pending' });
        sendName(session.id);
      } catch (error) {
        deps.warn('conversation reference write failed', {
          sessionId: session.id,
          error: String(error),
        });
        settle(false);
      }
    }
    instance.activate = () => {
      spawned = true;
      recordBinding();
    };
    const bind = (conversationId: string) => {
      if (
        !current() ||
        !conversationId ||
        (ref && !instance.conversationId && ref.conversationId !== conversationId) ||
        (adapter.id === 'codex' &&
          instance.conversationId &&
          instance.conversationId !== conversationId)
      )
        return;
      pendingId = conversationId;
      recordBinding();
    };
    const rename = (event: NativeNameEvent) => {
      if (
        !current() ||
        !instance.conversationId ||
        event.conversationId !== instance.conversationId ||
        event.echoRevision !== undefined ||
        instance.writingConversation === event.conversationId
      )
        return;
      const state = deps.session(session.id)?.namingState;
      if (
        state?.naming !== 'coupled' ||
        (state.nativeSync.status === 'pending' && !instance.awaitingNativeTitle)
      )
        return;
      instance.awaitingNativeTitle = false;
      if (state.name === event.name) {
        if (state.nativeSync.status === 'pending')
          deps.sync(session.id, state.revision, { status: 'synced' });
        return;
      }
      try {
        deps.nativeRename(session.id, event.name);
      } catch (error) {
        deps.warn('native name could not be saved', {
          sessionId: session.id,
          error: String(error),
        });
      }
    };
    const unbind = (reason: IdentityUnbindReason) => {
      if (!current()) return;
      close(session.id);
      const message = {
        'primary-archived': 'The main Codex thread was archived. Agent name sync has stopped.',
        'primary-deleted': 'The main Codex thread was deleted. Agent name sync has stopped.',
        'server-exited': 'The agent connection closed. Relaunch to restore name sync.',
      }[reason];
      unavailable.set(session.id, message);
      deps.changed();
    };
    const observer: AgentIdentityObserver = { bind, rename, unbind };
    return { launch, instance, observer, current };
  }

  async function prepare(
    session: Session,
    spec: SpawnSpec,
    ids: LaunchIds,
    adapter: AgentIdentityAdapter,
    ref?: ConversationReference,
  ) {
    const { launch, instance, observer, current } = register(
      session,
      spec,
      ids,
      adapter,
      ref,
      false,
    );
    try {
      const command = ref
        ? await adapter.resume(launch, ref, session.name)
        : await adapter.fresh(launch, session.name);
      await adapter.observe(launch, observer);
      if (!current())
        throw new Error('Agent conversation observation ended during launch preparation');
      return {
        instance,
        spec: {
          ...spec,
          command: command.command ?? spec.command,
          args: [...command.argv],
          env: {
            ...spec.env,
            ...Object.fromEntries(
              Object.entries(command.env ?? {}).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          },
        },
      };
    } catch (error) {
      if (current()) close(session.id);
      throw error;
    }
  }

  async function adopt(session: Session, spec: SpawnSpec, ids: LaunchIds) {
    const adapter = adapterFor(session, spec.command);
    if (!adapter?.adopt) return;
    const previous = active.get(session.id)?.ids;
    if (previous?.generation === ids.generation && previous.launchId === ids.launchId) return;
    const saved = session.conversationRef;
    if (
      saved &&
      (saved.adapterId !== adapter.id ||
        saved.scope.machineId !== deps.machineId() ||
        saved.capturedAt.generation !== ids.generation ||
        saved.capturedAt.launchId !== ids.launchId)
    )
      return;
    const { launch, observer, current } = register(session, spec, ids, adapter, saved, true);
    try {
      await adapter.adopt(launch, saved, observer);
    } catch (error) {
      if (!current()) return;
      close(session.id);
      deps.warn('agent identity could not reattach', {
        sessionId: session.id,
        error: String(error),
      });
      deps.changed();
    }
  }

  async function confirm(id: string, instance: ActiveIdentity) {
    const timeout = setTimeout(() => instance.controller.abort(), 10_000);
    const bound = await instance.bound.finally(() => clearTimeout(timeout));
    if (!bound || active.get(id) !== instance) return false;
    const session = deps.session(id);
    if (session?.namingState?.naming === 'coupled') {
      // An edit can arrive while the process is starting with the previous label.
      sendName(id);
    }
    return true;
  }

  return {
    reasonUnavailable: (id: string) => unavailable.get(id),
    adapterFor,
    hasIdentityConflict,
    check,
    prepare,
    adopt,
    confirm,
    close,
    sendName,
    activate: (id: string) => active.get(id)?.activate(),
    hasObserver: (id: string) => {
      const instance = active.get(id);
      return !!instance && (!instance.adopting || !!instance.conversationId);
    },
    awaitingResume: (id: string) => {
      const instance = active.get(id);
      return !!instance?.expectedResume && !instance.conversationId;
    },
    dispose: () => {
      for (const id of active.keys()) close(id);
    },
  };
}

export function createSessionStartFeed() {
  const listeners = new Map<string, (ids: LaunchIds, payload: unknown) => void>();
  return {
    subscribe(launch: AgentIdentityLaunch, callback: (ids: LaunchIds, payload: unknown) => void) {
      const id = launch.ids.launchId;
      listeners.set(id, callback);
      return () => {
        if (listeners.get(id) === callback) listeners.delete(id);
      };
    },
    post(ids: LaunchIds, payload: unknown) {
      listeners.get(ids.launchId)?.(ids, payload);
    },
  };
}
