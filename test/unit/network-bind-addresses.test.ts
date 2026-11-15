import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { bindableAddresses } from '../../src/network/bind-addresses';

const MAC = '00:00:00:00:00:00';

const UNSPECIFIED = [
  '0.0.0.0',
  '::',
  '0:0::0',
  '::ffff:0.0.0.0',
  '::ffff:0:0',
  '0:0:0:0:0:ffff:0:0',
];

const NOT_BINDABLE = [
  ...UNSPECIFIED,
  '8.8.8.8',
  '203.0.113.5',
  '2001:db8::1',
  'fe80::1',
  '169.254.1.1',
];

const BINDABLE = [
  '127.0.0.1',
  '10.1.2.3',
  '172.16.0.1',
  '192.168.1.5',
  '100.64.0.1',
  '::1',
  'fd00::1',
];

const v4 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: MAC,
  internal: false,
  cidr: null,
});

const v6 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: MAC,
  internal: false,
  cidr: null,
  scopeid: 0,
});

const FIXTURE: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  lo: [v4('127.0.0.1'), v6('::1')],
  wlan: [v4('192.168.2.11'), v6('2001:db8::1'), v6('fe80::1')],
  tailscale0: [v4('100.101.102.103'), v6('fd7a:115c:a1e0::1')],
  eth: [v4('8.8.8.8'), v4('169.254.1.1')],
  docker: [v4('172.17.0.1'), v4('172.32.0.1')],
};

describe('bindableAddresses', () => {
  it("'auto' returns loopback, RFC 1918, tailnet CGNAT and ULA only, IPv4 before IPv6", () => {
    expect(bindableAddresses(FIXTURE, 'auto')).toEqual([
      '127.0.0.1',
      '192.168.2.11',
      '100.101.102.103',
      '172.17.0.1',
      '::1',
      'fd7a:115c:a1e0::1',
    ]);
  });

  it("'auto' keeps the edges of the CGNAT, 172.16/12 and ULA ranges", () => {
    const edges: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      a: [v4('100.64.0.1'), v4('100.127.255.254'), v4('172.16.0.1'), v4('172.31.255.1')],
      b: [v6('fd12::1'), v6('fc00::1')],
    };
    expect(bindableAddresses(edges, 'auto')).toEqual([
      '100.64.0.1',
      '100.127.255.254',
      '172.16.0.1',
      '172.31.255.1',
      'fd12::1',
      'fc00::1',
    ]);
  });

  it("'auto' excludes the addresses just outside each range", () => {
    const outside: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      a: [v4('100.63.255.255'), v4('100.128.0.1'), v4('172.15.255.255'), v4('172.32.0.1')],
      b: [v6('fe80::1'), v6('febf::1'), v6('fec0::1'), v6('2001:db8::1')],
    };
    expect(bindableAddresses(outside, 'auto')).toEqual([]);
  });

  it("'auto' never includes public, link-local or out-of-range addresses", () => {
    const out = bindableAddresses(FIXTURE, 'auto');
    for (const bad of ['8.8.8.8', '169.254.1.1', '172.32.0.1', '2001:db8::1', 'fe80::1']) {
      expect(out).not.toContain(bad);
    }
  });

  it("'auto' deduplicates addresses that several interfaces report", () => {
    const dup: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      a: [v4('10.0.0.5')],
      b: [v4('10.0.0.5'), v6('::1')],
      c: [v6('::1')],
    };
    expect(bindableAddresses(dup, 'auto')).toEqual(['10.0.0.5', '::1']);
  });

  it("'auto' is empty when no interface qualifies", () => {
    expect(bindableAddresses({ eth: [v4('8.8.8.8')] }, 'auto')).toEqual([]);
  });

  it('an explicit IPv4 setting returns exactly that address, even if no interface has it', () => {
    expect(bindableAddresses(FIXTURE, '192.168.2.11')).toEqual(['192.168.2.11']);
  });

  it('an explicit IPv6 setting returns exactly that address', () => {
    expect(bindableAddresses(FIXTURE, 'fd7a:115c:a1e0::1')).toEqual(['fd7a:115c:a1e0::1']);
  });

  it('an explicit setting is held to the same private check as auto', () => {
    for (const bad of NOT_BINDABLE) expect(bindableAddresses(FIXTURE, bad)).toEqual([]);
    for (const good of BINDABLE) expect(bindableAddresses(FIXTURE, good)).toEqual([good]);
  });

  it('an explicit IPv4-mapped setting returns the normalised IPv4 address', () => {
    expect(bindableAddresses(FIXTURE, '::ffff:192.168.1.5')).toEqual(['192.168.1.5']);
    expect(bindableAddresses(FIXTURE, '::ffff:c0a8:105')).toEqual(['192.168.1.5']);
  });

  it('never binds all interfaces from a setting, in any spelling', () => {
    for (const bad of UNSPECIFIED) expect(bindableAddresses(FIXTURE, bad)).toEqual([]);
  });

  it('auto normalises an IPv4-mapped interface address before judging it', () => {
    const mapped: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      a: [v6('::ffff:192.168.1.5'), v6('0:0:0:0:0:ffff:c0a8:105')],
    };
    expect(bindableAddresses(mapped, 'auto')).toEqual(['192.168.1.5']);
  });

  it('auto never binds a mapped public or unspecified address', () => {
    const mapped: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      a: [v6('::ffff:8.8.8.8'), v6('::ffff:0.0.0.0'), v6('::ffff:0:0'), v6('0:0::0')],
    };
    expect(bindableAddresses(mapped, 'auto')).toEqual([]);
  });

  it('a non-IP setting returns nothing', () => {
    expect(bindableAddresses(FIXTURE, 'not-an-ip')).toEqual([]);
    expect(bindableAddresses(FIXTURE, '')).toEqual([]);
    expect(bindableAddresses(FIXTURE, 'localhost')).toEqual([]);
  });
});
