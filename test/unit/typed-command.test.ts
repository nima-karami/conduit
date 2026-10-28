import { describe, expect, it } from 'vitest';
import {
  agentCliOfLine,
  createTypedLineTracker,
  DETECT_GRACE_MS,
  NON_INTERACTIVE_ARGS,
} from '../../src/conduit-mcp/typed-command';

/** Candidates only: the agent CLIs the Enters in chunks typed. */
function feedEach(chunks: string[]): string[] {
  const t = createTypedLineTracker();
  return chunks.flatMap((c) => t.feed(c)).filter((cli) => cli !== null);
}

describe('typed-command', () => {
  it('grace is 15 s and the skip list is the spec list', () => {
    expect(DETECT_GRACE_MS).toBe(15_000);
    expect([...NON_INTERACTIVE_ARGS].sort()).toEqual(
      [
        '--version',
        '-v',
        '--help',
        '-h',
        'mcp',
        'update',
        'doctor',
        'login',
        'logout',
        'config',
        'exec',
        '-p',
        '--print',
        'run',
      ].sort(),
    );
  });

  it('typed claude + Enter → [claude]', () => {
    expect(feedEach([...'claude', '\r'])).toEqual(['claude']);
  });

  it('a whole line in one chunk is classified', () => {
    const t = createTypedLineTracker();
    expect(t.feed('codex\r')).toEqual(['codex']);
    expect(t.feed('claude\ropencode\r')).toEqual(['claude', 'opencode']);
    expect(t.feed('ls\r')).toEqual([null]);
  });

  it('backspace edits', () => {
    expect(feedEach(['codx', '\x7f', 'ex\r'])).toEqual(['codex']);
    expect(feedEach(['codexxx', '\x7f', '\x7f', '\r'])).toEqual(['codex']);
    expect(feedEach(['codx', '\b', 'ex\r'])).toEqual(['codex']);
    expect(feedEach(['\x7f\x7fclaude\r'])).toEqual(['claude']);
  });

  it('an arrow key makes the line unknown', () => {
    const t = createTypedLineTracker();
    expect(t.feed('\x1b[A')).toEqual([]);
    expect(t.feed('\r')).toEqual([null]);
    expect(t.feed('claude\r')).toEqual(['claude']);
    expect(t.feed('claude\x1b[D\r')).toEqual([null]);
  });

  it('Tab completion makes it unknown', () => {
    const t = createTypedLineTracker();
    expect(t.feed('cla\tude\r')).toEqual([null]);
    expect(t.feed('codex\r')).toEqual(['codex']);
  });

  it('bracketed paste makes it unknown', () => {
    expect(feedEach(['\x1b[200~claude\x1b[201~', '\r'])).toEqual([]);
  });

  it('Ctrl+C clears the line', () => {
    expect(feedEach(['ls -la', '\x03', 'codex\r'])).toEqual(['codex']);
    expect(feedEach(['\x1b[A', '\x03', 'codex\r'])).toEqual(['codex']);
    expect(feedEach(['vim', '\x15', 'claude\r'])).toEqual(['claude']);
  });

  it('one entry per Enter, null for a line that is not an agent CLI (the notice rule counts every line)', () => {
    const t = createTypedLineTracker();
    expect(t.feed('claude\rls\r\r')).toEqual(['claude', null, null]);
    expect(t.feed('codex\r\n')).toEqual(['codex']);
    expect(t.feed('x')).toEqual([]);
  });

  it('\\n also ends a line, and CRLF does not double-count', () => {
    expect(feedEach(['claude\n'])).toEqual(['claude']);
    expect(feedEach(['claude\r\n'])).toEqual(['claude']);
  });

  it('skip list', () => {
    expect(agentCliOfLine('claude --version')).toBeNull();
    expect(agentCliOfLine('codex exec x')).toBeNull();
    expect(agentCliOfLine('opencode run')).toBeNull();
    expect(agentCliOfLine('claude -p hi')).toBeNull();
    expect(agentCliOfLine('claude MCP list')).toBeNull();
    expect(agentCliOfLine('claude --model x')).toBe('claude');
    expect(agentCliOfLine('  claude  ')).toBe('claude');
  });

  it('paths and extensions', () => {
    expect(agentCliOfLine('C:\\tools\\Claude.EXE')).toBe('claude');
    expect(agentCliOfLine('./node_modules/.bin/codex.cmd')).toBe('codex');
    expect(agentCliOfLine('"C:\\Program Files\\x\\agent.ps1"')).toBe('cursor');
    expect(agentCliOfLine("'/opt/x y/opencode' --continue")).toBe('opencode');
    expect(agentCliOfLine('opencode.bat')).toBe('opencode');
    expect(agentCliOfLine('claude.sh')).toBeNull();
  });

  it('chained: first command only', () => {
    expect(agentCliOfLine('claude && codex')).toBe('claude');
    expect(agentCliOfLine('cd x && claude')).toBeNull();
    expect(agentCliOfLine('')).toBeNull();
  });

  it('cursor-agent → cursor', () => {
    expect(agentCliOfLine('cursor-agent')).toBe('cursor');
    expect(agentCliOfLine('agent')).toBe('cursor');
    expect(agentCliOfLine('cursor')).toBeNull();
  });
});
