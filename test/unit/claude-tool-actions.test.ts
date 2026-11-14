import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeActionsFromPostToolUse } from '../../src/claude-tool-actions';

const FIXTURES = join(__dirname, '..', 'fixtures', 'claude-hooks');
const payloadOf = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;

describe('claudeActionsFromPostToolUse', () => {
  it('claude Bash gives the command; Edit gives the path; mcp__conduit__ is dropped', () => {
    expect(claudeActionsFromPostToolUse(payloadOf('post-tool-use-bash.json'))).toEqual([
      { kind: 'command', command: 'echo hi', cwd: '/work/project' },
    ]);
    expect(claudeActionsFromPostToolUse(payloadOf('post-tool-use-edit.json'))).toEqual([
      { kind: 'file-change', paths: ['/work/project/a.txt'] },
    ]);
    expect(claudeActionsFromPostToolUse(payloadOf('post-tool-use-mcp.json'))).toEqual([
      { kind: 'mcp', server: 'example', tool: 'do_thing' },
    ]);
    expect(
      claudeActionsFromPostToolUse({
        tool_name: 'mcp__conduit__send_message',
        tool_input: { to: 'x' },
      }),
    ).toEqual([]);
  });

  it('splits the mcp name on the first separator only, and covers the other file tools', () => {
    expect(
      claudeActionsFromPostToolUse({ tool_name: 'mcp__github__create__issue', tool_input: {} }),
    ).toEqual([{ kind: 'mcp', server: 'github', tool: 'create__issue' }]);
    expect(
      claudeActionsFromPostToolUse({ tool_name: 'Write', tool_input: { file_path: '/w/b.md' } }),
    ).toEqual([{ kind: 'file-change', paths: ['/w/b.md'] }]);
    expect(
      claudeActionsFromPostToolUse({
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: '/w/n.ipynb' },
      }),
    ).toEqual([{ kind: 'file-change', paths: ['/w/n.ipynb'] }]);
  });

  it('unknown tools and malformed payloads give nothing', () => {
    expect(
      claudeActionsFromPostToolUse({ tool_name: 'Read', tool_input: { file_path: '/w/a' } }),
    ).toEqual([]);
    expect(claudeActionsFromPostToolUse({ tool_name: 'Bash', tool_input: { command: 3 } })).toEqual(
      [],
    );
    expect(claudeActionsFromPostToolUse({ tool_name: 'Edit' })).toEqual([]);
    expect(claudeActionsFromPostToolUse({})).toEqual([]);
  });

  it('no parser output contains any fixture content or output string', () => {
    const files = readdirSync(FIXTURES).filter((f) => /^post-tool-use-.*\.json$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const serialized = files
      .map((f) => JSON.stringify(claudeActionsFromPostToolUse(payloadOf(f))))
      .join('\n');
    for (const marker of ['FIXTURE-OUTPUT', 'FIXTURE-CONTENT', 'FIXTURE-ARG']) {
      expect(serialized).not.toContain(marker);
    }
  });
});
