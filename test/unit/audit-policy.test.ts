import { describe, expect, it } from 'vitest';
import { judgeAudit } from '../../tools/audit-policy.mjs';

const GHSA = 'GHSA-fc5q-39xc-vjpf';
const advisory = (id: string, severity = 'high') => ({
  vulnerabilities: {
    picomatch: {
      via: [
        {
          name: 'picomatch',
          url: `https://github.com/advisories/${id}`,
          severity,
          range: '<=4.0.7',
        },
      ],
    },
    vite: { via: ['picomatch'] },
  },
});
const none = { vulnerabilities: {} };
const exception = {
  id: GHSA,
  package: 'picomatch',
  lastVulnerable: '4.0.7',
  expires: '2026-12-17',
  reason: 'no fix yet',
};
const base = {
  full: advisory(GHSA),
  prod: none,
  allowlist: [exception],
  latest: { picomatch: '4.0.7' },
  today: '2026-11-17',
};

describe('judgeAudit', () => {
  it('allows the approved dev-only advisory before its expiry while no fix exists', () => {
    const r = judgeAudit(base);
    expect(r.failures).toEqual([]);
    expect(r.allowed).toHaveLength(1);
  });

  it('fails a high advisory with no exception', () => {
    expect(judgeAudit({ ...base, full: advisory('GHSA-aaaa-bbbb-cccc') }).failures).toHaveLength(1);
  });

  it('fails a critical advisory with no exception', () => {
    expect(
      judgeAudit({ ...base, full: advisory('GHSA-aaaa-bbbb-cccc', 'critical') }).failures,
    ).toHaveLength(1);
  });

  it('ignores moderate advisories, as the gate always has', () => {
    expect(
      judgeAudit({ ...base, full: advisory('GHSA-aaaa-bbbb-cccc', 'moderate') }).failures,
    ).toEqual([]);
  });

  it('fails when the excepted advisory reaches a production dependency', () => {
    expect(judgeAudit({ ...base, prod: advisory(GHSA) }).failures[0]).toMatch(/production/);
  });

  it('fails once the exception has expired', () => {
    expect(judgeAudit({ ...base, today: '2026-12-18' }).failures[0]).toMatch(/expired/);
  });

  it('fails as soon as a fixed release is published', () => {
    expect(judgeAudit({ ...base, latest: { picomatch: '4.0.8' } }).failures[0]).toMatch(
      /4\.0\.8 is out/,
    );
  });
});
