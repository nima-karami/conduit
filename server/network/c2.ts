import { CONNECT_BUDGET_MS } from '../../src/conduit-mcp/machine-tools';
import type { Capability } from '../../src/contracts/link-protocol';
import type { NetworkState } from '../../src/contracts/network-state';
import type { BootstrapResult } from '../../src/contracts/ssh-link';
import { isSshTarget } from '../../src/network/ssh-argv';
import { RpcFault } from '../transport/pipe';
import { DRIVE_INPUT_MAX_BYTES, type Drive } from './drive';
import type { FsClient } from './fs-client';
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
const MAX_DIMENSION = 10_000;
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
  machines: Machines;
  /** A's file client for remote.fs.* (plan CON-43). */
  fs: FsClient;
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
      known(d.manager.setCapability(machineId, capability, p.on), machineId);
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
      return handleFsCall(method, raw, d) ?? handleMachineCall(method, raw, d);
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

/** The owner's machine actions (plan Task 1). They run the same code the MCP tools use. */
export function handleMachineCall(
  method: string,
  raw: unknown,
  d: Pick<NetworkCallDeps, 'machines' | 'sshHosts'>,
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
    default:
      return null;
  }
}
