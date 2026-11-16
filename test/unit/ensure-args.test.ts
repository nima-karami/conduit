import { describe, expect, it } from 'vitest';
import { parseEnsureArgs } from '../../server/lifecycle/ensure-args';

const base = ['--ensure-server', '--user-data', '/u/data'];

describe('parseEnsureArgs', () => {
  it.each([
    [['--start', 'plain', '--survives-logout', 'yes'], 'plain', true],
    [['--start', 'scope', '--survives-logout', 'no'], 'scope', false],
    [['--start', 'windows-task', '--survives-logout', 'yes'], 'windows-task', true],
  ])('accepts %j', (flags, method, survivesLogout) => {
    expect(parseEnsureArgs([...base, ...flags])).toEqual({
      ok: true,
      args: { userData: '/u/data', method, survivesLogout },
    });
  });

  it('takes an absolute --shim-dir and leaves it out when absent', () => {
    expect(
      parseEnsureArgs([
        ...base,
        '--start',
        'plain',
        '--survives-logout',
        'yes',
        '--shim-dir',
        '/s/shim',
      ]),
    ).toMatchObject({ ok: true, args: { shimDir: '/s/shim' } });
    const absent = parseEnsureArgs([...base, '--start', 'plain', '--survives-logout', 'yes']);
    expect(absent.ok && 'shimDir' in absent.args).toBe(false);
  });

  it.each([
    [
      'a relative --shim-dir',
      [...base, '--start', 'plain', '--survives-logout', 'yes', '--shim-dir', 'shim'],
    ],
    [
      '--shim-dir with no value',
      [...base, '--start', 'plain', '--survives-logout', 'yes', '--shim-dir', '--hc', '/h'],
    ],
  ])('rejects %s', (_name, args) => {
    const parsed = parseEnsureArgs(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/--shim-dir/);
  });

  it('takes --hc when given', () => {
    expect(
      parseEnsureArgs([...base, '--start', 'plain', '--survives-logout', 'no', '--hc', '/h/hc']),
    ).toMatchObject({ ok: true, args: { hc: '/h/hc' } });
  });

  it.each([
    ['no --start', [...base, '--survives-logout', 'yes']],
    ['unknown --start', [...base, '--start', 'systemd', '--survives-logout', 'yes']],
    ['--start with no value', [...base, '--start', '--survives-logout', 'yes']],
    ['no --survives-logout', [...base, '--start', 'plain']],
    ['survives value not yes/no', [...base, '--start', 'plain', '--survives-logout', 'true']],
    ['no --user-data', ['--ensure-server', '--start', 'plain', '--survives-logout', 'yes']],
    [
      'a relative --user-data',
      ['--ensure-server', '--user-data', 'data', '--start', 'plain', '--survives-logout', 'yes'],
    ],
  ])('rejects %s', (_name, args) => {
    const parsed = parseEnsureArgs(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/--ensure-server/);
  });
});
