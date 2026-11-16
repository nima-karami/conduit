import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchedToolUseIds } from '../../src/claude-transcript-tools';

const FIXTURE = path.join(
  __dirname,
  '..',
  'fixtures',
  'claude-hooks',
  'transcript-tool-uses.jsonl',
);
const transcript = (): string => fs.readFileSync(FIXTURE, 'utf8');

// Ids are uuid-shaped and synthetic; see test/fixtures/claude-hooks/README.md.
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const LAST = id(18);

describe('matchedToolUseIds', () => {
  it('returns every matching main-session tool_use id from the start when sinceUuid is null', () => {
    expect(matchedToolUseIds(transcript(), null)).toEqual({
      ids: [
        'toolu_fixture_1',
        'toolu_fixture_2',
        'toolu_fixture_3',
        'toolu_fixture_4',
        'toolu_fixture_6',
        'toolu_fixture_11',
      ],
      lastUuid: LAST,
    });
  });

  it('returns only the ids after sinceUuid', () => {
    expect(matchedToolUseIds(transcript(), id(2)).ids).toEqual([
      'toolu_fixture_2',
      'toolu_fixture_3',
      'toolu_fixture_4',
      'toolu_fixture_6',
      'toolu_fixture_11',
    ]);
    expect(matchedToolUseIds(transcript(), id(9)).ids).toEqual([
      'toolu_fixture_6',
      'toolu_fixture_11',
    ]);
  });

  it('keeps a failed Bash, since its tool_use is still in the transcript', () => {
    expect(matchedToolUseIds(transcript(), id(3)).ids).toContain('toolu_fixture_2');
  });

  it('a sidechain line adds no id, even when it names a matching tool', () => {
    expect(matchedToolUseIds(transcript(), id(16)).ids).toEqual(['toolu_fixture_11']);
  });

  it('an api-request-blob adds no id, even though it replays Bash and Edit blocks', () => {
    expect(matchedToolUseIds(transcript(), id(6)).ids).toEqual([
      'toolu_fixture_3',
      'toolu_fixture_4',
      'toolu_fixture_6',
      'toolu_fixture_11',
    ]);
  });

  it('returns no ids when nothing follows sinceUuid, and keeps it as the last uuid', () => {
    expect(matchedToolUseIds(transcript(), LAST)).toEqual({
      ids: [],
      lastUuid: LAST,
    });
  });

  it('matches the whole tool name, so Task, BashOutput, TodoWrite, KillBash and Read add no id', () => {
    expect(
      matchedToolUseIds(
        '{"type":"assistant","uuid":"x","message":{"content":[{"type":"tool_use","id":"a","name":"BashOutput"},{"type":"tool_use","id":"b","name":"TodoWrite"},{"type":"tool_use","id":"c","name":"KillBash"},{"type":"tool_use","id":"d","name":"Read"},{"type":"tool_use","id":"e","name":"Task"}]}}',
        null,
      ),
    ).toEqual({ ids: [], lastUuid: 'x' });
  });

  it('skips malformed lines and never throws', () => {
    expect(() => matchedToolUseIds('{"uuid":\n[1,2\n"str"\nnull\n', null)).not.toThrow();
    expect(matchedToolUseIds('{"uuid":\n[1,2\n"str"\nnull\n', null)).toEqual({
      ids: [],
      lastUuid: null,
    });
  });

  it('an empty transcript has no ids and no last uuid', () => {
    expect(matchedToolUseIds('', null)).toEqual({ ids: [], lastUuid: null });
  });

  it('an unknown sinceUuid yields no ids and the current last uuid', () => {
    expect(matchedToolUseIds(transcript(), 'no-such-uuid')).toEqual({
      ids: [],
      lastUuid: LAST,
    });
  });
});
