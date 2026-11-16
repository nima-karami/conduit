import type { LinkState } from '../../src/contracts/link-protocol';
import type {
  ConnectMachineResult,
  DisconnectMachineResult,
  MachineError,
  MachineMeta,
  MachineView,
} from '../../src/contracts/machines';
import type { BootstrapResult, SshFailure } from '../../src/contracts/ssh-link';
import type { LinkRecord } from '../../src/network/link-file';
import { isSshTarget } from '../../src/network/ssh-argv';
import type { LinkStore } from './link-store';

// The machines an agent sees: the pinned ssh records (plan Architecture, one source of truth), with
// resolve, connect, disconnect and list over them. Errors leave here as MachineError codes; the MCP
// side turns them into tool errors.

/** A dial of a known machine waits this long for up (spec 7). */
const DIAL_WAIT_MS = 30_000;

const TIMED_OUT: ConnectMachineResult = {
  ok: false,
  error: { code: 'ssh_unreachable', detail: { detail: 'timeout' } },
};

/** The manager's view of a link: what a machine's state and last activity are read from. */
export interface MachinesManager {
  view(machineId: string): { state: LinkState; lastActivity: string | null } | null;
  disconnect(machineId: string): boolean;
  enable(machineId: string): boolean;
  waitUp(
    machineId: string,
    ms: number,
    signal: AbortSignal,
  ): Promise<{ up: true } | { up: false; failure: SshFailure | null }>;
}

export interface MachinesDeps {
  manager: MachinesManager;
  store: Pick<LinkStore, 'links'>;
  /** Pins a target (bootstrapAndLink): on success the peer is linked and its machine block written. */
  bootstrap(target: string): Promise<BootstrapResult>;
  /** The remote directory: a machine's sessions are the rows its id owns. */
  directory: { entries(): ReadonlyArray<{ machineId: string }> };
}

export interface Machines {
  list(): MachineView[];
  /** The caller's budget is `signal`: when it fires the work keeps going and still records its result. */
  connect(machine: string, signal: AbortSignal): Promise<ConnectMachineResult>;
  disconnect(machine: string): Promise<DisconnectMachineResult>;
}

interface Pinned {
  record: LinkRecord;
  target: string;
}

type Resolved =
  | { kind: 'pinned'; pinned: Pinned }
  | { kind: 'target'; target: string }
  | { kind: 'error'; error: MachineError };

type BootstrapFailure = Extract<BootstrapResult, { ok: false }>['error'];

const unknown = (candidates?: string[]): Resolved => ({
  kind: 'error',
  error:
    candidates === undefined
      ? { code: 'machine_unknown', detail: {} }
      : { code: 'machine_unknown', detail: {}, candidates },
});

/** Only ssh records that name an endpoint are machines; a controller's record has none to dial. */
function pinnedOf(store: Pick<LinkStore, 'links'>): Pinned[] {
  const out: Pinned[] = [];
  for (const record of store.links()) {
    if (record.transport === 'ssh' && record.ssh !== null) {
      out.push({ record, target: record.ssh.target });
    }
  }
  return out;
}

/** Id, then name, then ssh target, then a target to bootstrap (plan decision 5). */
function resolve(store: Pick<LinkStore, 'links'>, machine: string): Resolved {
  const all = pinnedOf(store);
  const byId = all.find((p) => p.record.machineId === machine);
  if (byId) return { kind: 'pinned', pinned: byId };
  const [first, ...rest] = all.filter((p) => p.record.name === machine);
  if (first && rest.length === 0) return { kind: 'pinned', pinned: first };
  if (first) return unknown([first, ...rest].map((p) => p.record.machineId));
  const byTarget = all.find((p) => p.target === machine);
  if (byTarget) return { kind: 'pinned', pinned: byTarget };
  if (isSshTarget(machine)) return { kind: 'target', target: machine };
  return unknown();
}

/** The one place a bootstrap's failure becomes a machine error (spec 5.2 codes, plan decision 6). */
function machineErrorOf(e: BootstrapFailure): MachineError {
  switch (e.code) {
    case 'ssh_needs_person':
      return { code: 'ssh_needs_person', detail: { reason: e.reason } };
    case 'ssh_auth_failed':
      return { code: 'ssh_auth_failed', detail: {} };
    case 'ssh_unreachable':
    case 'ssh_failed':
      return { code: 'ssh_unreachable', detail: { detail: e.detail } };
    case 'bridge_no_server':
    case 'bridge_no_secret':
    case 'bridge_refused':
      return { code: 'ssh_unreachable', detail: { detail: e.code } };
    case 'remote_unsupported':
      return { code: 'remote_unsupported', detail: { os: e.os, arch: e.arch } };
    case 'install_failed':
      return { code: 'install_failed', detail: { step: e.step, detail: e.detail } };
    case 'peer_incompatible':
      return { code: 'peer_incompatible', detail: { remote: e.remote } };
    case 'identity-changed':
      return { code: 'identity_changed', detail: {} };
    case 'identity-conflict':
      return { code: 'identity_conflict', detail: { machine: e.machine } };
    case 'incompatible':
      return { code: 'peer_incompatible', detail: {} };
    case 'bad-hello':
      return { code: 'ssh_unreachable', detail: { detail: 'bad_hello' } };
    case 'timeout':
      return { code: 'ssh_unreachable', detail: { detail: 'timeout' } };
  }
}

/** A dial that ended without up: the state says why, and the wait's timeout is the rest. */
function downErrorOf(state: LinkState | undefined): MachineError {
  switch (state) {
    case 'identity-changed':
      return { code: 'identity_changed', detail: {} };
    case 'incompatible':
      return { code: 'peer_incompatible', detail: {} };
    case 'revoked':
      return { code: 'machine_unknown', detail: { reason: 'revoked' } };
    default:
      return { code: 'ssh_unreachable', detail: { detail: 'timeout' } };
  }
}

export function createMachines(deps: MachinesDeps): Machines {
  // Concurrent connects to one machine share one run; each caller still waits on its own budget.
  const runs = new Map<string, Promise<ConnectMachineResult>>();

  const shared = (
    key: string,
    work: () => Promise<ConnectMachineResult>,
    signal: AbortSignal,
  ): Promise<ConnectMachineResult> => {
    let run = runs.get(key);
    if (run === undefined) {
      run = work().finally(() => runs.delete(key));
      runs.set(key, run);
    }
    const current = run;
    if (signal.aborted) return Promise.resolve(TIMED_OUT);
    return new Promise<ConnectMachineResult>((resolveOuter, rejectOuter) => {
      const onAbort = () => resolveOuter(TIMED_OUT);
      signal.addEventListener('abort', onAbort, { once: true });
      current.then(
        (result) => {
          signal.removeEventListener('abort', onAbort);
          resolveOuter(result);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          rejectOuter(error);
        },
      );
    });
  };

  const nameOf = (machineId: string): string | null =>
    deps.store.links().find((l) => l.machineId === machineId)?.name ?? null;

  // The one wait for a link to be up, shared by both paths: a bootstrap's pin does not mean up (the
  // link may still be settling), and a redial must not be reported before its dial finishes.
  const waitForUp = async (machineId: string): Promise<MachineError | null> => {
    // The wait has its own timer, so the caller's budget only needs to stop waiting, not the dial.
    const waited = await deps.manager.waitUp(machineId, DIAL_WAIT_MS, new AbortController().signal);
    if (waited.up) return null;
    // A dial that reported why it failed answers with that reason; only a silent wait is a timeout.
    if (waited.failure !== null) return machineErrorOf(waited.failure);
    return downErrorOf(deps.manager.view(machineId)?.state);
  };

  const bootstrapTo = async (target: string): Promise<ConnectMachineResult> => {
    const r = await deps.bootstrap(target);
    if (!r.ok) return { ok: false, error: machineErrorOf(r.error) };
    const name = nameOf(r.machineId);
    if (name === null) {
      return { ok: false, error: { code: 'ssh_unreachable', detail: { detail: 'not_recorded' } } };
    }
    const notUp = await waitForUp(r.machineId);
    if (notUp !== null) return { ok: false, error: notUp };
    return {
      ok: true,
      value: {
        machine: name,
        machine_id: r.machineId,
        state: 'up',
        os: r.summary.os,
        arch: r.summary.arch,
        mode: 'full',
        conduit_version: r.summary.version,
        reused: false,
        installed: r.summary.installed,
        upgraded: r.summary.upgraded,
      },
    };
  };

  const redialTo = async (record: LinkRecord, meta: MachineMeta): Promise<ConnectMachineResult> => {
    if (!deps.manager.enable(record.machineId)) {
      return { ok: false, error: { code: 'machine_unknown', detail: {} } };
    }
    const notUp = await waitForUp(record.machineId);
    if (notUp !== null) return { ok: false, error: notUp };
    return {
      ok: true,
      value: {
        machine: record.name,
        machine_id: record.machineId,
        state: 'up',
        os: meta.os,
        arch: meta.arch,
        mode: meta.mode,
        conduit_version: meta.version,
        reused: false,
        installed: false,
        upgraded: false,
      },
    };
  };

  return {
    list() {
      const sessions = new Map<string, number>();
      for (const entry of deps.directory.entries()) {
        sessions.set(entry.machineId, (sessions.get(entry.machineId) ?? 0) + 1);
      }
      return pinnedOf(deps.store).map(({ record, target }) => {
        const meta = record.machine;
        const enabled = meta?.enabled ?? true;
        const view = deps.manager.view(record.machineId);
        return {
          machine: record.name,
          machine_id: record.machineId,
          target,
          state: enabled ? (view?.state ?? 'down') : 'disabled',
          mode: meta?.mode ?? null,
          os: meta?.os ?? null,
          arch: meta?.arch ?? null,
          conduit_version: meta?.version ?? null,
          agents: meta?.agents ?? [],
          sessions: sessions.get(record.machineId) ?? 0,
          last_seen: view?.lastActivity ?? null,
          survives_logout: meta?.survivesLogout ?? null,
        };
      });
    },

    connect(machine, signal) {
      const r = resolve(deps.store, machine);
      if (r.kind === 'error') return Promise.resolve({ ok: false, error: r.error });
      if (r.kind === 'target') {
        return shared(r.target, () => bootstrapTo(r.target), signal);
      }
      const { record, target } = r.pinned;
      const meta = record.machine;
      // A record with no machine block (version 2) is refreshed by a bootstrap before it is reused.
      if (meta === null) return shared(record.machineId, () => bootstrapTo(target), signal);
      if (meta.enabled && deps.manager.view(record.machineId)?.state === 'up') {
        return Promise.resolve({
          ok: true,
          value: {
            machine: record.name,
            machine_id: record.machineId,
            state: 'up',
            os: meta.os,
            arch: meta.arch,
            mode: meta.mode,
            conduit_version: meta.version,
            reused: true,
            installed: false,
            upgraded: false,
          },
        });
      }
      return shared(record.machineId, () => redialTo(record, meta), signal);
    },

    async disconnect(machine) {
      const r = resolve(deps.store, machine);
      if (r.kind === 'error') return { ok: false, error: r.error };
      if (r.kind === 'target') return { ok: false, error: { code: 'machine_unknown', detail: {} } };
      const { record } = r.pinned;
      // The flag is what keeps a disconnected machine from redialing, and only a machine block holds it.
      if (record.machine === null) {
        return {
          ok: false,
          error: { code: 'ssh_unreachable', detail: { detail: 'no_machine_block' } },
        };
      }
      if (!deps.manager.disconnect(record.machineId)) {
        return { ok: false, error: { code: 'machine_unknown', detail: {} } };
      }
      // No master exit here: the batch dialer's ControlMaster expires by itself (ControlPersist 60), and
      // the owner's needs-person pane shares that ControlPath, so closing it would end their session.
      return { ok: true, value: { machine: record.name, state: 'down' } };
    },
  };
}
