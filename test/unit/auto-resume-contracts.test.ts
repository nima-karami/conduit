import { describe, expect, it } from 'vitest';
import { LIMIT_RULE_MAX_PATTERN, RULE_SCAN_ROWS } from '../../src/contracts/auto-resume';
import { HOOK_POST_MAX_BYTES, type HookPost } from '../../src/contracts/hook-protocol';
import { JOB_HISTORY_MAX, TERMINAL_JOB_STATES } from '../../src/contracts/scheduler';
import { SERVER_FILE_VERSION } from '../../src/contracts/session-identity';

// The values the spec fixes; a change here is a spec change (2026-11-13-scheduler-auto-resume §3, §4).
describe('auto-resume contracts', () => {
  it('pins the job history bound and the terminal states', () => {
    expect(JOB_HISTORY_MAX).toBe(20);
    expect([...TERMINAL_JOB_STATES].sort()).toEqual(['cancelled', 'done', 'failed', 'skipped']);
  });

  it('pins the rule caps', () => {
    expect(LIMIT_RULE_MAX_PATTERN).toBe(500);
    expect(RULE_SCAN_ROWS).toBe(25);
  });

  it('keeps a hook post distinguishable from a C6 shim hello', () => {
    const post: HookPost = { conduitHook: 1, token: 't', event: 'Stop', payload: {} };
    expect('conduit' in post).toBe(false);
    expect(HOOK_POST_MAX_BYTES).toBe(256 * 1024);
  });

  it('registers the new persisted files', () => {
    expect(SERVER_FILE_VERSION['scheduler.json']).toBe(2);
    expect(SERVER_FILE_VERSION['limit-rules.json']).toBe(1);
  });
});
