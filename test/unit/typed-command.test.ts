import { describe, expect, it } from 'vitest';
import {
  agentCliOfLine,
  createTypedLineTracker,
  DETECT_GRACE_MS,
  NON_INTERACTIVE_ARGS,
  type TypedEnter,
} from '../../src/conduit-mcp/typed-command';

const clis = (enters: TypedEnter[]) => enters.map((e) => e.cli);
const typedFlags = (enters: TypedEnter[]) => enters.map((e) => e.typed);

/** Candidates only: the agent CLIs the Enters in chunks typed. */
function feedEach(chunks: string[]): string[] {
  const t = createTypedLineTracker();
  return chunks.flatMap((c) => clis(t.feed(c))).filter((cli) => cli !== null);
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
    expect(clis(t.feed('codex\r'))).toEqual(['codex']);
    expect(clis(t.feed('claude\ropencode\r'))).toEqual(['claude', 'opencode']);
    expect(clis(t.feed('ls\r'))).toEqual([null]);
  });

  it('backspace edits', () => {
    expect(feedEach(['codx', '\x7f', 'ex\r'])).toEqual(['codex']);
    expect(feedEach(['codexxx', '\x7f', '\x7f', '\r'])).toEqual(['codex']);
    expect(feedEach(['codx', '\b', 'ex\r'])).toEqual(['codex']);
    expect(feedEach(['\x7f\x7fclaude\r'])).toEqual(['claude']);
  });

  it('an arrow key makes the line unknown', () => {
    const t = createTypedLineTracker();
    expect(clis(t.feed('\x1b[A'))).toEqual([]);
    expect(clis(t.feed('\r'))).toEqual([null]);
    expect(clis(t.feed('claude\r'))).toEqual(['claude']);
    expect(clis(t.feed('claude\x1b[D\r'))).toEqual([null]);
  });

  it('Tab completion makes it unknown', () => {
    const t = createTypedLineTracker();
    expect(clis(t.feed('cla\tude\r'))).toEqual([null]);
    expect(clis(t.feed('codex\r'))).toEqual(['codex']);
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
    expect(clis(t.feed('claude\rls\r\r'))).toEqual(['claude', null, null]);
    expect(clis(t.feed('codex\r\n'))).toEqual(['codex']);
    expect(clis(t.feed('x'))).toEqual([]);
  });

  it('an Enter counts as typed only after a printable character (F6: dialog answers are not lines)', () => {
    const t = createTypedLineTracker();
    expect(typedFlags(t.feed('\r\x1b[B\r\x1bOA\r\x1b[1;5C\r'))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(typedFlags(t.feed('ls\r\x1b[Ax\r'))).toEqual([true, true]);
    expect(typedFlags(t.feed('\x1b[200~claude\x1b[201~\r'))).toEqual([true]);
    expect(typedFlags(t.feed('ab\x7f\x7f\r'))).toEqual([true]);
    expect(typedFlags(t.feed('ls\x03\r'))).toEqual([false]);
  });

  it('a sequence split across chunks is still skipped, and a control char ends it', () => {
    const t = createTypedLineTracker();
    expect(typedFlags(t.feed('\x1b'))).toEqual([]);
    expect(typedFlags(t.feed('[B\r'))).toEqual([false]);
    expect(typedFlags(t.feed('\x1b\r'))).toEqual([false]);
    expect(clis(t.feed('claude\r'))).toEqual(['claude']);
  });

  it('a byte outside the CSI ranges ends a malformed sequence and is not swallowed (review S5)', () => {
    const t = createTypedLineTracker();
    expect(t.feed('\x1b[1€\rclaude\r')).toEqual([
      { cli: null, typed: true },
      { cli: 'claude', typed: true },
    ]);
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
