import { describe, expect, it } from 'vitest';
import {
  formatRecord,
  type LogRecord,
  levelEnabled,
  pruneOldLogs,
  redact,
  shouldRotate,
} from '../../src/logging';

describe('levelEnabled — ordering gate', () => {
  it('off silences every level', () => {
    for (const m of ['error', 'warn', 'info', 'debug', 'trace'] as const) {
      expect(levelEnabled('off', m)).toBe(false);
    }
  });

  it('error only lets error through', () => {
    expect(levelEnabled('error', 'error')).toBe(true);
    expect(levelEnabled('error', 'warn')).toBe(false);
    expect(levelEnabled('error', 'info')).toBe(false);
    expect(levelEnabled('error', 'debug')).toBe(false);
    expect(levelEnabled('error', 'trace')).toBe(false);
  });

  it('info lets error/warn/info through but not debug/trace', () => {
    expect(levelEnabled('info', 'error')).toBe(true);
    expect(levelEnabled('info', 'warn')).toBe(true);
    expect(levelEnabled('info', 'info')).toBe(true);
    expect(levelEnabled('info', 'debug')).toBe(false);
    expect(levelEnabled('info', 'trace')).toBe(false);
  });

  it('debug lets debug through but not trace', () => {
    expect(levelEnabled('debug', 'debug')).toBe(true);
    expect(levelEnabled('debug', 'trace')).toBe(false);
  });

  it('trace (most verbose) lets everything through', () => {
    for (const m of ['error', 'warn', 'info', 'debug', 'trace'] as const) {
      expect(levelEnabled('trace', m)).toBe(true);
    }
  });
});

describe('formatRecord — JSONL line', () => {
  const rec: LogRecord = {
    ts: 1_700_000_000_000,
    level: 'info',
    scope: 'pty',
    msg: 'spawn',
    data: { sessionId: 'abc' },
  };

  it('produces a single line with no trailing newline', () => {
    const line = formatRecord(rec);
    expect(line).not.toContain('\n');
  });

  it('round-trips via JSON.parse', () => {
    const parsed = JSON.parse(formatRecord(rec));
    expect(parsed).toEqual({
      ts: 1_700_000_000_000,
      level: 'info',
      scope: 'pty',
      msg: 'spawn',
      data: { sessionId: 'abc' },
    });
  });

  it('omits data when absent', () => {
    const parsed = JSON.parse(formatRecord({ ts: 1, level: 'warn', scope: 'app', msg: 'hi' }));
    expect(parsed.data).toBeUndefined();
    expect(parsed.msg).toBe('hi');
  });
});

describe('redact — masks sensitive keys', () => {
  it('returns undefined for undefined input', () => {
    expect(redact(undefined)).toBeUndefined();
  });

  it('masks top-level token/secret/password/authorization/cookie/apikey keys', () => {
    const out = redact({
      token: 'abc',
      secret: 'xyz',
      password: 'p',
      authorization: 'Bearer z',
      cookie: 'sid=1',
      apikey: 'k',
      api_key: 'k2',
    });
    expect(out).toEqual({
      token: '[redacted]',
      secret: '[redacted]',
      password: '[redacted]',
      authorization: '[redacted]',
      cookie: '[redacted]',
      apikey: '[redacted]',
      api_key: '[redacted]',
    });
  });

  it('matches sensitive keys case-insensitively and as substrings', () => {
    const out = redact({ ACCESS_TOKEN: 'a', GitHubSecret: 'b', myPassword: 'c' }) as Record<
      string,
      unknown
    >;
    expect(out.ACCESS_TOKEN).toBe('[redacted]');
    expect(out.GitHubSecret).toBe('[redacted]');
    expect(out.myPassword).toBe('[redacted]');
  });

  it('masks an env-like catch (keys ending in _KEY or named env)', () => {
    const out = redact({ STRIPE_KEY: 'sk', env: { PATH: '/usr/bin' } }) as Record<string, unknown>;
    expect(out.STRIPE_KEY).toBe('[redacted]');
    expect(out.env).toBe('[redacted]');
  });

  it('masks nested objects and arrays of objects', () => {
    const out = redact({
      outer: { token: 't', keep: 'ok' },
      list: [{ password: 'p' }, { keep: 'ok2' }],
    }) as Record<string, unknown>;
    expect(out.outer).toEqual({ token: '[redacted]', keep: 'ok' });
    expect(out.list).toEqual([{ password: '[redacted]' }, { keep: 'ok2' }]);
  });

  it('leaves paths and repo data intact', () => {
    const data = {
      path: 'G:/awby/projects/conduit',
      branch: 'main',
      sessionId: 'sess-1',
      dirty: true,
    };
    expect(redact({ ...data })).toEqual(data);
  });

  it('does not mutate the input', () => {
    const input = { token: 'abc', nested: { secret: 'z' } };
    redact(input);
    expect(input.token).toBe('abc');
    expect(input.nested.secret).toBe('z');
  });
});

describe('shouldRotate — size cap boundary', () => {
  const CAP = 5 * 1024 * 1024;
  it('does not rotate below the cap', () => {
    expect(shouldRotate(0, CAP)).toBe(false);
    expect(shouldRotate(CAP - 1, CAP)).toBe(false);
  });

  it('rotates at or above the cap', () => {
    expect(shouldRotate(CAP, CAP)).toBe(true);
    expect(shouldRotate(CAP + 1, CAP)).toBe(true);
  });
});

describe('pruneOldLogs — keeps N most recent', () => {
  // Ordering contract: filenames sort lexicographically ascending = oldest→newest
  // (conduit-YYYYMMDD[-N].log). Caller passes them in that ascending order.
  const files = [
    'conduit-20260101.log',
    'conduit-20260102.log',
    'conduit-20260103.log',
    'conduit-20260104.log',
    'conduit-20260105.log',
  ];

  it('returns the oldest files beyond keep, to delete', () => {
    expect(pruneOldLogs(files, 3)).toEqual(['conduit-20260101.log', 'conduit-20260102.log']);
  });

  it('deletes nothing when count is within keep', () => {
    expect(pruneOldLogs(files.slice(0, 2), 5)).toEqual([]);
    expect(pruneOldLogs(files, 5)).toEqual([]);
  });

  it('sorts an unsorted input before pruning', () => {
    const shuffled = ['conduit-20260103.log', 'conduit-20260101.log', 'conduit-20260102.log'];
    expect(pruneOldLogs(shuffled, 1)).toEqual(['conduit-20260101.log', 'conduit-20260102.log']);
  });

  it('keep 0 deletes everything', () => {
    expect(pruneOldLogs(['a', 'b'], 0)).toEqual(['a', 'b']);
  });
});
