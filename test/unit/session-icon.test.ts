import { describe, expect, it } from 'vitest';
import { iconForAgent, iconForSession } from '../../src/session-icon';
import type { AgentDefinition } from '../../src/types';

const def = (over: Partial<AgentDefinition>): AgentDefinition => ({
  id: 'x',
  label: 'X',
  command: 'x',
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
  ...over,
});

describe('iconForAgent', () => {
  it('maps Claude-like agents to the claude glyph (command / id / args, any case + path + .exe)', () => {
    expect(iconForAgent(def({ id: 'claude', command: 'claude' }))).toBe('claude');
    expect(iconForAgent(def({ id: 'cc', command: 'Claude.EXE' }))).toBe('claude');
    expect(iconForAgent(def({ id: 'cc', command: '/usr/local/bin/claude' }))).toBe('claude');
    expect(iconForAgent(def({ id: 'claude-code', command: 'node' }))).toBe('claude');
    expect(iconForAgent(def({ command: 'npx', args: ['claude'] }))).toBe('claude');
  });

  it('maps other known AI agents to the claude glyph', () => {
    for (const cmd of ['aider', 'cursor', 'copilot', 'gemini', 'codex', 'goose']) {
      expect(iconForAgent(def({ id: cmd, command: cmd }))).toBe('claude');
    }
  });

  it('maps PowerShell to the powershell glyph (powershell / pwsh, path + .exe + case)', () => {
    expect(iconForAgent(def({ command: 'powershell.exe' }))).toBe('powershell');
    expect(iconForAgent(def({ command: 'PowerShell.EXE' }))).toBe('powershell');
    expect(iconForAgent(def({ command: 'pwsh' }))).toBe('powershell');
    expect(iconForAgent(def({ command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }))).toBe(
      'powershell',
    );
  });

  it('maps common shells to the terminal glyph (basename, any case)', () => {
    for (const cmd of [
      'bash',
      'zsh',
      'sh',
      'fish',
      'cmd',
      'wsl',
      'nu',
      'csh',
      'tcsh',
      'dash',
      'ksh',
    ]) {
      expect(iconForAgent(def({ command: cmd }))).toBe('terminal');
    }
    expect(iconForAgent(def({ command: 'C:\\Program Files\\Git\\bin\\bash.exe' }))).toBe(
      'terminal',
    );
    expect(iconForAgent(def({ command: 'CMD.EXE' }))).toBe('terminal');
  });

  it('falls back to the terminal glyph for unknown commands and for undefined', () => {
    expect(iconForAgent(def({ id: 'mystery', command: 'mystery-tool' }))).toBe('terminal');
    expect(iconForAgent(def({ command: '' }))).toBe('terminal');
    expect(iconForAgent(undefined)).toBe('terminal');
  });

  it('prefers the AI-agent match when both an AI keyword and a shell appear', () => {
    expect(iconForAgent(def({ command: 'cmd', args: ['/c', 'claude'] }))).toBe('claude');
  });

  it('does not false-positive on flag args that merely contain a keyword', () => {
    // A shell launched with a flag like --cursor-shape must stay a terminal, not Cursor.
    expect(iconForAgent(def({ command: 'bash', args: ['--cursor-shape=block'] }))).toBe('terminal');
    expect(iconForAgent(def({ command: 'pwsh', args: ['-codepage', '65001'] }))).toBe('powershell');
  });
});

describe('iconForSession', () => {
  const agents: AgentDefinition[] = [
    def({ id: 'claude', command: 'claude' }),
    def({ id: 'shell:pwsh', command: 'pwsh.exe' }),
    def({ id: 'shell:gitbash', command: 'bash.exe' }),
  ];

  it('resolves the session agent from the list', () => {
    expect(iconForSession({ agentId: 'claude' }, agents)).toBe('claude');
    expect(iconForSession({ agentId: 'shell:pwsh' }, agents)).toBe('powershell');
    expect(iconForSession({ agentId: 'shell:gitbash' }, agents)).toBe('terminal');
  });

  it('falls back to the terminal glyph when the agent id is not in the list', () => {
    expect(iconForSession({ agentId: 'ghost' }, agents)).toBe('terminal');
    expect(iconForSession({ agentId: 'claude' }, [])).toBe('terminal');
  });
});
