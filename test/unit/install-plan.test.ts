import { describe, expect, it } from 'vitest';
import { planInstall } from '../../src/network/install-plan';
import type { ProbeResult } from '../../src/network/remote-scripts';

const local = { version: '1.4.0', linkMajor: 1 };

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    os: 'linux',
    arch: 'x64',
    home: '/home/u',
    userData: '/home/u/.config/conduit',
    freeBytes: null,
    kup: false,
    linger: true,
    systemdRun: true,
    installed: [],
    recorded: null,
    agents: [],
    ...over,
  };
}

describe('planInstall', () => {
  it('installs when nothing is recorded and the platform is supported', () => {
    expect(planInstall(local, probe())).toEqual({ kind: 'install', version: '1.4.0' });
  });

  it('attaches when the recorded version equals the local one (same link major)', () => {
    const p = probe({ recorded: { version: '1.4.0', linkMajor: 1 } });
    expect(planInstall(local, p)).toEqual({ kind: 'attach', version: '1.4.0' });
  });

  it('attaches to a newer recorded version and never downgrades', () => {
    const p = probe({ recorded: { version: '1.5.2', linkMajor: 1 } });
    expect(planInstall(local, p)).toEqual({ kind: 'attach', version: '1.5.2' });
  });

  it('upgrades when the recorded version is older (same link major)', () => {
    const p = probe({ recorded: { version: '1.3.9', linkMajor: 1 } });
    expect(planInstall(local, p)).toEqual({ kind: 'upgrade', version: '1.4.0', from: '1.3.9' });
  });

  it('a pre-release recorded version is older than its release', () => {
    const p = probe({ recorded: { version: '1.4.0-rc.1', linkMajor: 1 } });
    expect(planInstall(local, p)).toEqual({
      kind: 'upgrade',
      version: '1.4.0',
      from: '1.4.0-rc.1',
    });
  });

  it('is incompatible with a recorded server of another link major, newer or older', () => {
    expect(planInstall(local, probe({ recorded: { version: '2.0.0', linkMajor: 2 } }))).toEqual({
      kind: 'incompatible',
      remote: '2.0.0',
    });
    expect(planInstall(local, probe({ recorded: { version: '0.9.0', linkMajor: 0 } }))).toEqual({
      kind: 'incompatible',
      remote: '0.9.0',
    });
  });

  it.each([
    ['linux arm64', { os: 'linux' as const, arch: 'arm64' as const }],
    ['windows arm64', { os: 'windows' as const, arch: 'arm64' as const }],
    ['another os', { os: 'other' as const, arch: 'x64' as const }],
  ])('is unsupported on %s (RS-D9)', (_label, o) => {
    expect(planInstall(local, probe(o))).toEqual({ kind: 'unsupported', os: o.os, arch: o.arch });
  });

  it('plans for a windows x64 remote like a linux one', () => {
    expect(
      planInstall(local, probe({ os: 'windows', recorded: null, linger: null, kup: null })),
    ).toEqual({ kind: 'install', version: '1.4.0' });
  });

  it('unsupported wins over a recorded server on an arm64 box', () => {
    const p = probe({ arch: 'arm64', recorded: { version: '1.4.0', linkMajor: 1 } });
    expect(planInstall(local, p)).toEqual({ kind: 'unsupported', os: 'linux', arch: 'arm64' });
  });
});
