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

describe('matchedToolUseIds', () => {
  it('returns every matching main-session tool_use id in the transcript, in order', () => {
    expect(matchedToolUseIds(transcript())).toEqual([
      'toolu_fixture_1',
      'toolu_fixture_2',
      'toolu_fixture_3',
      'toolu_fixture_4',
      'toolu_fixture_6',
      'toolu_fixture_11',
    ]);
  });

  it('keeps a failed Bash, since its tool_use is still in the transcript', () => {
    expect(matchedToolUseIds(transcript())).toContain('toolu_fixture_2');
  });

  it('a sidechain line adds no id, even when it names a matching tool', () => {
    expect(matchedToolUseIds(transcript())).not.toContain('toolu_fixture_side');
  });

  it('an api-request-blob adds no id, even though it replays Bash and Edit blocks', () => {
    expect(matchedToolUseIds(transcript()).filter((id) => id === 'toolu_fixture_1')).toHaveLength(
      1,
    );
  });

  it('matches the whole tool name, so Task, BashOutput, TodoWrite, KillBash and Read add no id', () => {
    expect(
      matchedToolUseIds(
        '{"type":"assistant","uuid":"x","message":{"content":[{"type":"tool_use","id":"a","name":"BashOutput"},{"type":"tool_use","id":"b","name":"TodoWrite"},{"type":"tool_use","id":"c","name":"KillBash"},{"type":"tool_use","id":"d","name":"Read"},{"type":"tool_use","id":"e","name":"Task"}]}}',
      ),
    ).toEqual([]);
  });

  it('skips malformed lines and never throws', () => {
    expect(() => matchedToolUseIds('{"uuid":\n[1,2\n"str"\nnull\n')).not.toThrow();
    expect(matchedToolUseIds('{"uuid":\n[1,2\n"str"\nnull\n')).toEqual([]);
  });

  it('an empty transcript has no ids', () => {
    expect(matchedToolUseIds('')).toEqual([]);
  });
});
