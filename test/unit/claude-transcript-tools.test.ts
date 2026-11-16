import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countMatchedToolUses } from '../../src/claude-transcript-tools';

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
const ID = {
  bash: id(2),
  multiEdit: id(9),
  sidechainPrev: id(16),
};
const LAST = id(18);

describe('countMatchedToolUses', () => {
  it('counts every matching main-session tool_use from the start when sinceUuid is null', () => {
    expect(countMatchedToolUses(transcript(), null)).toEqual({ count: 6, lastUuid: LAST });
  });

  it('counts only the entries after sinceUuid', () => {
    expect(countMatchedToolUses(transcript(), ID.bash)).toEqual({ count: 5, lastUuid: LAST });
    expect(countMatchedToolUses(transcript(), ID.multiEdit)).toEqual({ count: 2, lastUuid: LAST });
  });

  it('counts a failed Bash as a tool use, since its tool_use is still in the transcript', () => {
    expect(countMatchedToolUses(transcript(), id(3))).toEqual({ count: 5, lastUuid: LAST });
  });

  it('a sidechain line adds nothing, even when it names a matching tool', () => {
    expect(countMatchedToolUses(transcript(), ID.sidechainPrev)).toEqual({
      count: 1,
      lastUuid: LAST,
    });
  });

  it('an api-request-blob adds nothing, even though it replays Bash and Edit blocks', () => {
    expect(countMatchedToolUses(transcript(), id(6))).toEqual({ count: 4, lastUuid: LAST });
  });

  it('counts zero when nothing follows sinceUuid, and keeps it as the last uuid', () => {
    expect(countMatchedToolUses(transcript(), LAST)).toEqual({ count: 0, lastUuid: LAST });
  });

  it('matches the whole tool name, so Task, BashOutput, TodoWrite, KillBash and Read do not count', () => {
    expect(
      countMatchedToolUses(
        '{"type":"assistant","uuid":"x","message":{"content":[{"type":"tool_use","name":"BashOutput"},{"type":"tool_use","name":"TodoWrite"},{"type":"tool_use","name":"KillBash"},{"type":"tool_use","name":"Read"},{"type":"tool_use","name":"Task"}]}}',
        null,
      ),
    ).toEqual({ count: 0, lastUuid: 'x' });
  });

  it('skips malformed lines and never throws', () => {
    expect(() => countMatchedToolUses('{"uuid":\n[1,2\n"str"\nnull\n', null)).not.toThrow();
    expect(countMatchedToolUses('{"uuid":\n[1,2\n"str"\nnull\n', null)).toEqual({
      count: 0,
      lastUuid: null,
    });
  });

  it('an empty transcript counts zero with no last uuid', () => {
    expect(countMatchedToolUses('', null)).toEqual({ count: 0, lastUuid: null });
  });

  it('an unknown sinceUuid counts from the start', () => {
    expect(countMatchedToolUses(transcript(), 'no-such-uuid')).toEqual({
      count: 6,
      lastUuid: LAST,
    });
  });
});
