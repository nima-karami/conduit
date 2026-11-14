import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rolloutActions } from '../../src/codex-rollout';

const FIXTURES = join(__dirname, '..', 'fixtures', 'codex-rollout');
const fixtureLines = (name: string): string[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l !== '');
const ACTIONS = fixtureLines('actions.jsonl');

describe('rolloutActions', () => {
  it('codex command row has the joined command, cwd, exit code, no output', () => {
    expect(rolloutActions(ACTIONS[1])).toEqual([
      { kind: 'command', command: 'echo hi', cwd: '/work/project', exitCode: 0, durationMs: 0 },
    ]);
  });

  it('codex command joins argv when there is no shell wrapper', () => {
    const line = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          command: ['git', 'status', '--short'],
          cwd: '/work/project',
          exit_code: 1,
          duration: { secs: 2, nanos: 500_000_000 },
        },
      },
    };
    expect(rolloutActions(line)).toEqual([
      {
        kind: 'command',
        command: 'git status --short',
        cwd: '/work/project',
        exitCode: 1,
        durationMs: 2500,
      },
    ]);
  });

  it('codex file change lists paths only', () => {
    expect(rolloutActions(ACTIONS[2])).toEqual([
      { kind: 'file-change', paths: ['/work/project/a.txt', '/work/project/b.txt'] },
    ]);
  });

  it('codex mcp call keeps server and tool only', () => {
    expect(rolloutActions(ACTIONS[3])).toEqual([
      { kind: 'mcp', server: 'example', tool: 'do_thing', durationMs: 104 },
    ]);
  });

  it('ignores non-item lines and malformed items without throwing', () => {
    expect(rolloutActions(ACTIONS[0])).toEqual([]);
    expect(rolloutActions(ACTIONS[4])).toEqual([]);
    expect(rolloutActions('not json')).toEqual([]);
    expect(rolloutActions(null)).toEqual([]);
    expect(
      rolloutActions({
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 5 } },
      }),
    ).toEqual([]);
    expect(
      rolloutActions({
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'x' } },
      }),
    ).toEqual([]);
  });

  it('no parser output contains any fixture content or output string', () => {
    const serialized = ACTIONS.map((l) => JSON.stringify(rolloutActions(l))).join('\n');
    for (const marker of ['FIXTURE-OUTPUT', 'FIXTURE-CONTENT', 'FIXTURE-ARG']) {
      expect(serialized).not.toContain(marker);
    }
  });
});
