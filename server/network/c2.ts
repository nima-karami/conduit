import { AGENT_CLIS, type AgentCli } from '../../src/conduit-mcp/install-types';
import { CONNECT_BUDGET_MS } from '../../src/conduit-mcp/machine-tools';
import {
  type Capability,
  FS_WRITE_DATA_MAX,
  GIT_OPS,
  type GitOp,
  type GitReqArgs,
  SHA256_HEX,
} from '../../src/contracts/link-protocol';
import type { AgentSetupStep, MachineMode } from '../../src/contracts/machines';
import type { NetworkState } from '../../src/contracts/network-state';
import type { BootstrapResult } from '../../src/contracts/ssh-link';
import { isSshTarget } from '../../src/network/ssh-argv';
import { RpcFault } from '../transport/pipe';
import { DRIVE_INPUT_MAX_BYTES, type Drive } from './drive';
import type { FsClient } from './fs-client';
import type { GitClient } from './git-client';
import type { LinkManager } from './link-manager';
import { parseHostPort } from './listener';
import type { Machines } from './machines';
import type { PairingService } from './pairing-service';
import type { createViewRelay } from './view-relay';

// C2 methods for linked machines (plan "C2 additions"). Every parameter is checked here; the
// services behind them trust their inputs.

const CAPABILITIES: readonly Capability[] = ['messaging', 'monitor', 'drive'];
const MAX_ADDRESSES = 16;
const MAX_PATH = 4096;
// The fs frames carry at most 64 chars of session id (link-protocol FS_SESSION_ID_MAX).
const FS_SESSION_MAX = 64;
const utf8 = new TextEncoder();
// The git frames take the same commit and page bounds the frame parser enforces on B.
const GIT_SHA = /^[0-9a-f]{7,40}$/;
const GIT_LOG_MAX = 500;
const MAX_DIMENSION = 10_000;
const isMachineMode = (v: unknown): v is MachineMode => v === 'full' || v === 'light';
const isDimension = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_DIMENSION;

export interface NetworkCallDeps {
  pairing: PairingService;
  manager: LinkManager;
  state(): NetworkState;
  relay: ReturnType<typeof createViewRelay>;
  drive: Drive;
  /** The controller's bootstrap for one target: install or attach, then link. */
  bootstrap(target: string): Promise<BootstrapResult>;
  /** Opens the needs-person pane for one target; resolves with its session id. */
  openNeedsPerson(target: string): Promise<string>;
  /** Opens an agent-setup pane on a machine; resolves with its session id. */
  openSetupPane(machineId: string, cli: AgentCli, step: AgentSetupStep): Promise<string>;
  machines: Machines;
  /** A's file client for remote.fs.* (plan CON-43). */
  fs: FsClient;
  /** A's git client for remote.git (plan CON-45). */
  git: GitClient;
  /** The Host aliases in the user's ssh config, for the Add dialog's list. */
  sshHosts(): string[];
  peer?: object;
}

type Params = Record<string, unknown>;
const paramsOf = (raw: unknown): Params =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw))
    : {};

function str(p: Params, key: string, max = 256): string {
  const v = p[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max)
    throw new RpcFault('invalid', `Expected ${key}`);
  return v;
}

function known(ok: boolean, machineId: string): void {
  if (!ok) throw new RpcFault('not_found', `No link to ${machineId}`);
}

export function handleNetworkCall(
  method: string,
  raw: unknown,
  d: NetworkCallDeps,
): Promise<unknown> | null {
  const p = paramsOf(raw);
  switch (method) {
    case 'pairing.start':
      return d.pairing.start().catch((err: Error) => {
        throw new RpcFault('unavailable', err.message);
      });
    case 'pairing.join': {
      const code = str(p, 'code', 200);
      const address = str(p, 'address');
      if (parseHostPort(address) === null) throw new RpcFault('invalid', 'Expected host:port');
      return d.pairing.join(code, address).catch((err: Error) => {
        throw new RpcFault(
          err.message === 'bad_code' ? 'invalid' : 'unavailable',
          err.message === 'bad_code' ? 'That code is not three pairing words' : err.message,
        );
      });
    }
    case 'pairing.confirm':
      d.pairing.confirm(str(p, 'pairingId'));
      return Promise.resolve({});
    case 'pairing.decline':
      d.pairing.decline(str(p, 'pairingId'));
      return Promise.resolve({});
    case 'pairing.cancel':
      d.pairing.cancel(str(p, 'pairingId'));
      return Promise.resolve({});
    case 'remote.attach':
      if (!d.peer) throw new RpcFault('invalid', 'Expected connection');
      return d.relay.attach(d.peer, str(p, 'machineId'), str(p, 'sessionId'));
    case 'remote.detach':
      if (!d.peer) throw new RpcFault('invalid', 'Expected connection');
      d.relay.detach(d.peer, str(p, 'viewId'));
      return Promise.resolve({});
    case 'remote.input': {
      const data = p.data;
      if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > DRIVE_INPUT_MAX_BYTES)
        throw new RpcFault('invalid', 'Expected data up to 64 KiB');
      d.drive.input(str(p, 'machineId'), str(p, 'sessionId'), data);
      return Promise.resolve({});
    }
    case 'remote.resize': {
      const cols = p.cols;
      const rows = p.rows;
      if (!isDimension(cols) || !isDimension(rows))
        throw new RpcFault('invalid', 'Expected cols and rows');
      d.drive.resize(str(p, 'machineId'), str(p, 'sessionId'), cols, rows);
      return Promise.resolve({});
    }
    case 'remote.open':
      return d.drive.open(str(p, 'machineId'), str(p, 'agentId'), str(p, 'folder', MAX_PATH));
    case 'remote.close':
      return d.drive.close(str(p, 'machineId'), str(p, 'sessionId')).then(() => ({}));
    case 'link.list':
      return Promise.resolve(d.state());
    case 'link.sshAdd': {
      const ssh = paramsOf(p.ssh);
      return d.manager.addSshPeer({
        target: str(ssh, 'target', 256),
        node: str(ssh, 'node', MAX_PATH),
        mainJs: str(ssh, 'mainJs', MAX_PATH),
        userData: str(ssh, 'userData', MAX_PATH),
      });
    }
    case 'link.sshBootstrap': {
      const target = str(p, 'target', 256);
      if (!isSshTarget(target)) throw new RpcFault('invalid', 'Expected an ssh target');
      return d.bootstrap(target);
    }
    case 'machines.openNeedsPerson': {
      const target = str(p, 'target', 256);
      if (!isSshTarget(target)) throw new RpcFault('invalid', 'Expected an ssh target');
      return d.openNeedsPerson(target).then((sessionId) => ({ sessionId }));
    }
    case 'link.revoke': {
      const machineId = str(p, 'machineId');
      if (!d.manager.view(machineId)) throw new RpcFault('not_found', `No link to ${machineId}`);
      d.relay.revoking(machineId);
      known(d.manager.revoke(machineId), machineId);
      return Promise.resolve({});
    }
    case 'link.setCapability': {
      const machineId = str(p, 'machineId');
      const capability = CAPABILITIES.find((c) => c === p.capability);
      if (capability === undefined || typeof p.on !== 'boolean')
        throw new RpcFault('invalid', 'Expected capability and on');
      // The grant is re-applied on every connect (acceptSsh, plan CON-41 decision 3), so a toggle lasts one connection.
      if (capability === 'drive' && d.manager.isSshController(machineId))
        throw new RpcFault('invalid', 'drive on an ssh controller is granted by its connection');
      const result = d.manager.setCapability(machineId, capability, p.on, str(p, 'expectedToken'));
      if (result === 'conflict')
        throw new RpcFault('conflict', 'Link changed; refresh before editing');
      if (result === 'not-found') throw new RpcFault('not_found', `No link to ${machineId}`);
      return Promise.resolve({});
    }
    case 'link.setAddresses': {
      const machineId = str(p, 'machineId');
      const addresses = p.addresses;
      if (
        !Array.isArray(addresses) ||
        addresses.length === 0 ||
        addresses.length > MAX_ADDRESSES ||
        !addresses.every((a) => typeof a === 'string' && parseHostPort(a) !== null)
      )
        throw new RpcFault('invalid', 'Expected host:port addresses');
      known(
        d.manager.setAddresses(
          machineId,
          addresses.filter((a) => typeof a === 'string'),
        ),
        machineId,
      );
      return Promise.resolve({});
    }
    default:
      return (
        handleFsCall(method, raw, d) ??
        handleGitCall(method, raw, d) ??
        handleMachineCall(method, raw, d)
      );
  }
}

/** Files on a remote session's folders, read through A's file client (plan CON-43). */
export function handleFsCall(
  method: string,
  raw: unknown,
  d: Pick<NetworkCallDeps, 'fs' | 'peer'>,
): Promise<unknown> | null {
  const p = paramsOf(raw);
  switch (method) {
    case 'remote.fs.list':
      return d.fs
        .request(
          str(p, 'machineId'),
          'list',
          str(p, 'sessionId', FS_SESSION_MAX),
          str(p, 'path', MAX_PATH),
        )
        .then((r) => {
          if (r.op !== 'list') throw new RpcFault('unavailable', 'the answer was not a listing');
          return { path: r.path, entries: r.entries };
        });
    case 'remote.fs.read':
      return d.fs
        .request(
          str(p, 'machineId'),
          'read',
          str(p, 'sessionId', FS_SESSION_MAX),
          str(p, 'path', MAX_PATH),
        )
        .then((r) => {
          if (r.op !== 'read') throw new RpcFault('unavailable', 'the answer was not a file');
          return r.file;
        });
    case 'remote.fs.write': {
      const machineId = str(p, 'machineId');
      const sessionId = str(p, 'sessionId', FS_SESSION_MAX);
      const path = str(p, 'path', MAX_PATH);
      const data = writeData(p.data);
      const expect = p.expect;
      if (expect !== null && (typeof expect !== 'string' || !SHA256_HEX.test(expect)))
        throw new RpcFault('invalid', 'Expected expect: null or a sha256 hex');
      return d.fs.write(machineId, sessionId, path, data, expect);
    }
    case 'remote.fs.stat':
      return d.fs
        .request(
          str(p, 'machineId'),
          'stat',
          str(p, 'sessionId', FS_SESSION_MAX),
          str(p, 'path', MAX_PATH),
        )
        .then((r) => {
          if (r.op !== 'stat') throw new RpcFault('unavailable', 'the answer was not a stat');
          return { kind: r.kind, size: r.size, mtimeMs: r.mtimeMs };
        });
    case 'remote.fs.watch': {
      const machineId = str(p, 'machineId');
      const sessionId = str(p, 'sessionId', FS_SESSION_MAX);
      const path = str(p, 'path', MAX_PATH);
      if (!d.peer) throw new RpcFault('invalid', 'Expected connection');
      return Promise.resolve({ watchId: d.fs.watch(d.peer, machineId, sessionId, path) });
    }
    case 'remote.fs.unwatch': {
      const watchId = str(p, 'watchId', FS_SESSION_MAX);
      if (!d.peer) throw new RpcFault('invalid', 'Expected connection');
      d.fs.unwatch(d.peer, watchId);
      return Promise.resolve({});
    }
    default:
      return null;
  }
}

/**
 * A save's data, bounded as B bounds it: in UTF-8 bytes. A UTF-16 unit is at least one byte, so a
 * string longer than the cap is too large without encoding it; one within a third of the cap
 * fits by length alone, and only the rest need encoding to be counted.
 */
function writeData(v: unknown): string {
  if (typeof v !== 'string') throw new RpcFault('invalid', 'Expected data');
  const tooLarge =
    v.length > FS_WRITE_DATA_MAX ||
    (v.length * 3 > FS_WRITE_DATA_MAX && utf8.encode(v).length > FS_WRITE_DATA_MAX);
  if (tooLarge) throw new RpcFault('too_large', `Expected data up to ${FS_WRITE_DATA_MAX} bytes`);
  return v;
}

/** Git reads of a remote session's repo, through A's git client (plan CON-45). */
export function handleGitCall(
  method: string,
  raw: unknown,
  d: Pick<NetworkCallDeps, 'git'>,
): Promise<unknown> | null {
  const p = paramsOf(raw);
  switch (method) {
    case 'remote.git': {
      const op = GIT_OPS.find((o) => o === p.op);
      if (op === undefined) throw new RpcFault('invalid', 'Expected op');
      return d.git.request(
        str(p, 'machineId'),
        op,
        str(p, 'sessionId', FS_SESSION_MAX),
        str(p, 'root', MAX_PATH),
        gitArgs(op, p.args),
      );
    }
    default:
      return null;
  }
}

/** Each op's own arguments, rebuilt from the known keys; B's frame parser re-checks them. */
function gitArgs(op: GitOp, raw: unknown): GitReqArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new RpcFault('invalid', 'Expected args');
  const a = Object.fromEntries(Object.entries(raw));
  const only = (keys: readonly string[]) => {
    if (!Object.keys(a).every((k) => keys.includes(k)))
      throw new RpcFault('invalid', `Expected only ${keys.join(', ') || 'no args'} for ${op}`);
  };
  const sha = (key: string): string => {
    const v = a[key];
    if (typeof v !== 'string' || !GIT_SHA.test(v)) throw new RpcFault('invalid', `Expected ${key}`);
    return v;
  };
  switch (op) {
    case 'status':
      only([]);
      return {};
    case 'diff':
      only(['path']);
      return { path: str(a, 'path', MAX_PATH) };
    case 'show':
      only(['sha']);
      return { sha: sha('sha') };
    case 'log': {
      only(['limit', 'before']);
      const limit = a.limit;
      if (
        limit !== undefined &&
        (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > GIT_LOG_MAX)
      )
        throw new RpcFault('invalid', 'Expected limit 1 to 500');
      const before = a.before;
      return {
        ...(limit !== undefined && { limit }),
        ...(before !== undefined && { before: sha('before') }),
      };
    }
  }
}

/** The owner's machine actions (plan Task 1). They run the same code the MCP tools use. */
export function handleMachineCall(
  method: string,
  raw: unknown,
  d: Pick<NetworkCallDeps, 'machines' | 'sshHosts' | 'openSetupPane'>,
): Promise<unknown> | null {
  const p = paramsOf(raw);
  switch (method) {
    case 'machines.connect': {
      const machine = str(p, 'machine', 256);
      // Same budget as the MCP connect_machine call. The work keeps going past it (Machines.connect).
      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(), CONNECT_BUDGET_MS);
      return d.machines.connect(machine, budget.signal).finally(() => clearTimeout(timer));
    }
    case 'machines.disconnect':
      return d.machines.disconnect(str(p, 'machine', 256));
    case 'machines.rename':
      d.machines.rename(str(p, 'machineId'), str(p, 'name', 256));
      return Promise.resolve({});
    case 'machines.remove':
      d.machines.remove(str(p, 'machineId'));
      return Promise.resolve({});
    case 'machines.sshHosts':
      return Promise.resolve({ hosts: d.sshHosts() });
    case 'machines.setMode': {
      const machineId = str(p, 'machineId');
      const mode = p.mode;
      if (!isMachineMode(mode)) throw new RpcFault('invalid', 'Expected mode full or light');
      d.machines.setMode(machineId, mode);
      return Promise.resolve({});
    }
    case 'machines.openSetupPane': {
      const machineId = str(p, 'machineId');
      const cli = AGENT_CLIS.find((c) => c === p.cli);
      if (cli === undefined) throw new RpcFault('invalid', 'Expected cli');
      if (p.step !== 'install' && p.step !== 'login') {
        throw new RpcFault('invalid', 'Expected step install or login');
      }
      return d.openSetupPane(machineId, cli, p.step).then((sessionId) => ({ sessionId }));
    }
    case 'machines.probeAgents':
      return d.machines.probeAgents(str(p, 'machineId'));
    default:
      return null;
  }
}
