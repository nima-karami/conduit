import { isIP, isIPv4, isIPv6 } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';

// Binding every interface is never reachable from a setting: an explicit value is one address
// or nothing. See plan D-H4 (docs/plans/2026-11-14-conduit-network-machinery.plan.md).

/** `auto` (plan decision 5): loopback, RFC 1918, tailnet CGNAT and ULA. Public and link-local are never bound. */
export function bindableAddresses(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  setting: string,
): string[] {
  if (setting !== 'auto') {
    if (!isIP(setting) || isUnspecified(setting)) return [];
    return [setting];
  }
  const v4: string[] = [];
  const v6: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (isIPv4(info.address)) {
        if (isPrivateIPv4(info.address)) v4.push(info.address);
      } else if (isIPv6(info.address)) {
        if (isPrivateIPv6(info.address)) v6.push(info.address);
      }
    }
  }
  return [...new Set([...v4, ...v6])];
}

/** Callers pass only validated addresses, so every group index below is in range. */
function groupAt(groups: readonly number[], i: number): number {
  return groups[i] ?? 0;
}

function isPrivateIPv4(addr: string): boolean {
  const o = ipv4Groups(addr);
  const a = groupAt(o, 0);
  const b = groupAt(o, 1);
  if (a === 127 || a === 10) return true;
  if (a === 172) return b >= 16 && b <= 31;
  if (a === 192) return b === 168;
  if (a === 100) return b >= 64 && b <= 127;
  return false;
}

function ipv4Groups(addr: string): number[] {
  return addr.split('.').map(Number);
}

/**
 * Eight 16-bit groups, whatever spelling the OS used. A zone id is dropped and a trailing dotted
 * quad is folded into the last two groups, so the prefix checks see one canonical shape.
 */
function ipv6Groups(addr: string): number[] {
  let s = addr.split('%')[0] ?? addr;
  let embedded: number[] | null = null;
  if (s.includes('.')) {
    const last = s.lastIndexOf(':');
    const o = ipv4Groups(s.slice(last + 1));
    embedded = [(groupAt(o, 0) << 8) | groupAt(o, 1), (groupAt(o, 2) << 8) | groupAt(o, 3)];
    s = `${s.slice(0, last + 1)}0:0`;
  }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((g) =>
    Number.parseInt(g, 16),
  );
  if (embedded) {
    groups[6] = groupAt(embedded, 0);
    groups[7] = groupAt(embedded, 1);
  }
  return groups;
}

function isPrivateIPv6(addr: string): boolean {
  const g = ipv6Groups(addr);
  if (g.slice(0, 5).every((x) => x === 0) && groupAt(g, 5) === 0xffff) {
    // IPv4-mapped (::ffff:a.b.c.d): judged by the IPv4 address it carries.
    const mapped = [
      groupAt(g, 6) >> 8,
      groupAt(g, 6) & 0xff,
      groupAt(g, 7) >> 8,
      groupAt(g, 7) & 0xff,
    ];
    return isPrivateIPv4(mapped.join('.'));
  }
  if (g.slice(0, 7).every((x) => x === 0) && groupAt(g, 7) === 1) return true; // ::1
  return (groupAt(g, 0) & 0xfe00) === 0xfc00; // fc00::/7
}

/** Covers `0.0.0.0`, `::` and every spelling of the all-zero IPv6 address. */
function isUnspecified(addr: string): boolean {
  return ipv6Groups(addr).every((x) => x === 0);
}
