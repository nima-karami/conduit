import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindsTo, LineSplitter, parseRolloutMeta, rolloutSignals } from '../../src/codex-rollout';

const FIXTURES = join(__dirname, '..', 'fixtures', 'codex-rollout');
const fixtureLines = (name: string): string[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
const line = (name: string, index: number): string => fixtureLines(name)[index] ?? '';

const PRIMARY = fixtureLines('primary-meta.jsonl')[0] ?? '';
const GUARDIAN = fixtureLines('guardian-meta.jsonl')[0] ?? '';
const samePath = (a: string, b: string) => a === b;
const LAUNCH = Date.parse('2026-11-12T21:00:40Z');

describe('parseRolloutMeta', () => {
  it('reads a primary session_meta line', () => {
    expect(parseRolloutMeta(PRIMARY)).toEqual({
      id: '01a1d190-1af2-7db3-ae44-cb9dacc349ed',
      cwd: '/work/project',
      timestamp: Date.parse('2026-11-12T21:00:44.670Z'),
      isSubThread: false,
    });
  });

  it('marks a guardian sub-thread (parent_thread_id, source.subagent) as a sub-thread', () => {
    expect(parseRolloutMeta(GUARDIAN)?.isSubThread).toBe(true);
  });

  it('treats a source object with subagent as a sub-thread even without parent_thread_id', () => {
    const doc = JSON.parse(GUARDIAN) as { payload: Record<string, unknown> };
    delete doc.payload.parent_thread_id;
    expect(parseRolloutMeta(JSON.stringify(doc))?.isSubThread).toBe(true);
  });

  it('returns null for a line that is not a session_meta, or is not JSON', () => {
    expect(parseRolloutMeta(line('turn.jsonl', 0))).toBeNull();
    expect(parseRolloutMeta('{"type":"session_meta","payload":')).toBeNull();
  });
});

describe('bindsTo', () => {
  const primary = parseRolloutMeta(PRIMARY);
  const guardian = parseRolloutMeta(GUARDIAN);

  it('binds a primary file with the same cwd launched just before it', () => {
    expect(primary && bindsTo(primary, { cwd: '/work/project', launchAt: LAUNCH }, samePath)).toBe(
      true,
    );
  });

  it('does not bind a subagent meta even with the same cwd and time', () => {
    expect(
      guardian && bindsTo(guardian, { cwd: '/work/project', launchAt: LAUNCH }, samePath),
    ).toBe(false);
  });

  it('refuses a different cwd and a file created long before the launch', () => {
    expect(primary && bindsTo(primary, { cwd: '/elsewhere', launchAt: LAUNCH }, samePath)).toBe(
      false,
    );
    expect(
      primary &&
        bindsTo(
          primary,
          { cwd: '/work/project', launchAt: Date.parse('2026-11-12T21:10:00Z') },
          samePath,
        ),
    ).toBe(false);
  });
});

describe('rolloutSignals', () => {
  it('maps a usage-limit task_complete to a limited signal', () => {
    const signals = rolloutSignals('s1', line('limit.jsonl', 2), false, 1000);
    expect(signals).toContainEqual(
      expect.objectContaining({ kind: 'limited', sessionId: 's1', source: 'codex-rollout' }),
    );
  });

  it('accepts a usage-limit turn_complete as well', () => {
    const signals = rolloutSignals('s1', line('limit-turn-complete.jsonl', 1), false, 1000);
    expect(signals.map((s) => s.kind)).toEqual(['limited']);
  });

  it('maps token_count rate_limits to reset-info with epoch seconds converted to ms', () => {
    const signals = rolloutSignals('s1', line('turn.jsonl', 1), false, 1000);
    expect(signals).toEqual([
      {
        kind: 'reset-info',
        sessionId: 's1',
        at: 1000,
        source: 'codex-rollout',
        windows: [
          { name: 'primary', usedPct: 0, resetAt: 1794535288000 },
          { name: 'secondary', usedPct: 56, resetAt: 1794584488000 },
        ],
      },
    ]);
  });

  it('adds a limited signal when token_count reports rate_limit_reached_type', () => {
    const kinds = rolloutSignals('s1', line('limit.jsonl', 1), false, 1000).map((s) => s.kind);
    expect(kinds).toEqual(['reset-info', 'limited']);
  });

  it('maps a turn start after an open episode to resumed by turn', () => {
    expect(rolloutSignals('s1', line('turn.jsonl', 0), true, 1000)).toEqual([
      { kind: 'resumed', sessionId: 's1', at: 1000, by: 'turn', source: 'codex-rollout' },
    ]);
    expect(rolloutSignals('s1', line('turn.jsonl', 0), false, 1000)).toEqual([]);
  });

  it('emits nothing for a clean task_complete, a malformed line or a non-event line', () => {
    expect(rolloutSignals('s1', line('turn.jsonl', 2), false, 1000)).toEqual([]);
    expect(rolloutSignals('s1', '{"type":"event_msg","payload":', false, 1000)).toEqual([]);
    expect(rolloutSignals('s1', PRIMARY, false, 1000)).toEqual([]);
  });
});

describe('LineSplitter', () => {
  it('holds a partial last line back until its newline arrives', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(splitter.push('2}\n')).toEqual(['{"b":2}']);
  });

  it('keeps a line split across three chunks whole', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"x":')).toEqual([]);
    expect(splitter.push('1')).toEqual([]);
    expect(splitter.push('}\n')).toEqual(['{"x":1}']);
  });

  it('strips CRLF and drops empty lines', () => {
    expect(new LineSplitter().push('one\r\n\ntwo\n')).toEqual(['one', 'two']);
  });
});
