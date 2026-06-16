import { describe, expect, it } from 'vitest';
import {
  iconForAgent,
  iconForSession,
  iconKindFromText,
  resolveSessionIcon,
  sessionIconState,
} from '../../src/session-icon';
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

  it('lets a sticky appIcon (detected from the title) override the agent default', () => {
    // A plain shell session whose title revealed `claude` running inside it.
    expect(iconForSession({ agentId: 'shell:gitbash', appIcon: 'claude' }, agents)).toBe('claude');
    // appIcon wins even when the agent isn't in the list.
    expect(iconForSession({ agentId: 'ghost', appIcon: 'powershell' }, agents)).toBe('powershell');
  });
});

describe('iconKindFromText', () => {
  it('detects a known AI app from a terminal title', () => {
    expect(iconKindFromText('claude — fixing paste')).toBe('claude');
    expect(iconKindFromText('aider')).toBe('claude');
  });

  it('detects PowerShell', () => {
    expect(iconKindFromText('Windows PowerShell')).toBe('powershell');
  });

  it('returns null when nothing matches (so callers fall back)', () => {
    expect(iconKindFromText('my project')).toBeNull();
    expect(iconKindFromText('')).toBeNull();
  });
});

describe('resolveSessionIcon', () => {
  const agents: AgentDefinition[] = [
    def({ id: 'claude', command: 'claude' }),
    def({ id: 'shell:pwsh', command: 'pwsh.exe' }),
    def({ id: 'shell:gitbash', command: 'bash.exe' }),
  ];

  it('iconOverride wins over appIcon and agent kind (highest precedence)', () => {
    // Override beats appIcon.
    expect(
      resolveSessionIcon(
        { agentId: 'claude', appIcon: 'powershell', iconOverride: 'rocket' },
        agents,
      ),
    ).toEqual({ type: 'lucide', name: 'rocket' });
    // Override beats agent kind.
    expect(resolveSessionIcon({ agentId: 'claude', iconOverride: 'zap' }, agents)).toEqual({
      type: 'lucide',
      name: 'zap',
    });
    // Override with no agents still uses the override.
    expect(resolveSessionIcon({ agentId: 'ghost', iconOverride: 'star' }, [])).toEqual({
      type: 'lucide',
      name: 'star',
    });
  });

  it('falls back to appIcon kind when no override', () => {
    // appIcon wins over agent kind when iconOverride is absent.
    expect(resolveSessionIcon({ agentId: 'shell:gitbash', appIcon: 'claude' }, agents)).toEqual({
      type: 'kind',
      kind: 'claude',
    });
  });

  it('falls back to agent kind when neither override nor appIcon is set', () => {
    expect(resolveSessionIcon({ agentId: 'claude' }, agents)).toEqual({
      type: 'kind',
      kind: 'claude',
    });
    expect(resolveSessionIcon({ agentId: 'shell:pwsh' }, agents)).toEqual({
      type: 'kind',
      kind: 'powershell',
    });
    expect(resolveSessionIcon({ agentId: 'shell:gitbash' }, agents)).toEqual({
      type: 'kind',
      kind: 'terminal',
    });
  });

  it('returns terminal kind when agent not found and no override', () => {
    expect(resolveSessionIcon({ agentId: 'ghost' }, agents)).toEqual({
      type: 'kind',
      kind: 'terminal',
    });
  });
});

describe('sessionIconState (D4 — icon visual state)', () => {
  it('not running (exited) → stale regardless of activity flags', () => {
    expect(sessionIconState({ status: 'exited' })).toBe('stale');
    expect(sessionIconState({ status: 'exited', busy: true })).toBe('stale');
    expect(sessionIconState({ status: 'exited', needsAttention: true })).toBe('stale');
    expect(sessionIconState({ status: 'exited', busy: true, needsAttention: true })).toBe('stale');
  });

  it('not running (stale) → stale regardless of activity flags', () => {
    expect(sessionIconState({ status: 'stale' })).toBe('stale');
    expect(sessionIconState({ status: 'stale', busy: true, needsAttention: true })).toBe('stale');
  });

  it('running + busy → busy (pulsing icon state)', () => {
    expect(sessionIconState({ status: 'running', busy: true })).toBe('busy');
  });

  it('running + needsAttention (and not busy) → attention', () => {
    expect(sessionIconState({ status: 'running', needsAttention: true })).toBe('attention');
  });

  it('running + both busy and needsAttention → busy wins (actively working)', () => {
    // busy takes precedence over attention so the icon stays in the "working" state.
    expect(sessionIconState({ status: 'running', busy: true, needsAttention: true })).toBe('busy');
  });

  it('running + quiet (neither busy nor needsAttention) → idle', () => {
    expect(sessionIconState({ status: 'running' })).toBe('idle');
    expect(sessionIconState({ status: 'running', busy: false, needsAttention: false })).toBe(
      'idle',
    );
  });
});
