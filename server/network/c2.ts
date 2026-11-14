import type { Capability } from '../../src/contracts/link-protocol';
import type { NetworkState } from '../../src/contracts/network-state';
import { RpcFault } from '../transport/pipe';
import type { LinkManager } from './link-manager';
import { parseHostPort } from './listener';
import type { PairingService } from './pairing-service';

// C2 methods for linked machines (plan "C2 additions"). Every parameter is checked here; the
// services behind them trust their inputs.

const CAPABILITIES: readonly Capability[] = ['messaging', 'monitor', 'drive'];
const MAX_ADDRESSES = 16;

export interface NetworkCallDeps {
  pairing: PairingService;
  manager: LinkManager;
  state(): NetworkState;
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
    case 'link.list':
      return Promise.resolve(d.state());
    case 'link.revoke': {
      const machineId = str(p, 'machineId');
      known(d.manager.revoke(machineId), machineId);
      return Promise.resolve({});
    }
    case 'link.setCapability': {
      const machineId = str(p, 'machineId');
      const capability = CAPABILITIES.find((c) => c === p.capability);
      if (capability === undefined || typeof p.on !== 'boolean')
        throw new RpcFault('invalid', 'Expected capability and on');
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
      return null;
  }
}
