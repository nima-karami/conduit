import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUserStatusLine } from '../../src/claude-user-status-line';

const PROJECT = path.join('/work', 'project');
const CONFIG = path.join('/home', 'u', '.claude');
const LOCAL = path.join(PROJECT, '.claude', 'settings.local.json');
const SHARED = path.join(PROJECT, '.claude', 'settings.json');
const USER = path.join(CONFIG, 'settings.json');

const statusLine = (command: string, extra: Record<string, unknown> = {}) => ({
  statusLine: { type: 'command', command, ...extra },
});

function fakeFiles(files: Record<string, unknown>) {
  const reads: string[] = [];
  const readFile = (p: string): string | null => {
    reads.push(p);
    const v = files[p];
    if (v === undefined) return null;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  return { reads, readFile };
}

function resolve(files: Record<string, unknown>) {
  const f = fakeFiles(files);
  const result = readUserStatusLine({
    projectDir: PROJECT,
    configDir: CONFIG,
    readFile: f.readFile,
  });
  return { result, reads: f.reads };
}

describe('readUserStatusLine', () => {
  it('returns null when no settings file has a status line', () => {
    expect(resolve({}).result).toBeNull();
  });

  it('the project local file wins over the shared project file and the user file', () => {
    const { result } = resolve({
      [LOCAL]: statusLine('local'),
      [SHARED]: statusLine('shared'),
      [USER]: statusLine('user'),
    });
    expect(result).toEqual({ type: 'command', command: 'local' });
  });

  it('the shared project file wins over the user file', () => {
    const { result } = resolve({ [SHARED]: statusLine('shared'), [USER]: statusLine('user') });
    expect(result).toEqual({ type: 'command', command: 'shared' });
  });

  it('falls back to the user config file', () => {
    const { result } = resolve({ [USER]: statusLine('user') });
    expect(result).toEqual({ type: 'command', command: 'user' });
  });

  it('reads the three files in precedence order at their joined paths', () => {
    const { reads } = resolve({});
    expect(reads).toEqual([LOCAL, SHARED, USER]);
  });

  it('skips a file whose statusLine is not a command', () => {
    const { result } = resolve({
      [LOCAL]: { statusLine: { type: 'other', command: 'x' } },
      [USER]: statusLine('user'),
    });
    expect(result).toEqual({ type: 'command', command: 'user' });
  });

  it('skips a file whose command is empty', () => {
    const { result } = resolve({ [LOCAL]: statusLine(''), [USER]: statusLine('user') });
    expect(result).toEqual({ type: 'command', command: 'user' });
  });

  it('ignores a command that names conduit-hook.cjs, so a re-read cannot chain the wrapper', () => {
    const wrapper = "ELECTRON_RUN_AS_NODE=1 '/opt/c' '/opt/conduit-hook.cjs' statusline";
    expect(resolve({ [LOCAL]: statusLine(wrapper), [USER]: statusLine('user') }).result).toEqual({
      type: 'command',
      command: 'user',
    });
    expect(resolve({ [LOCAL]: statusLine(wrapper) }).result).toBeNull();
  });

  it('copies padding, refreshInterval and hideVimModeIndicator when set', () => {
    const { result } = resolve({
      [USER]: statusLine('user', { padding: 2, refreshInterval: 5, hideVimModeIndicator: true }),
    });
    expect(result).toEqual({
      type: 'command',
      command: 'user',
      padding: 2,
      refreshInterval: 5,
      hideVimModeIndicator: true,
    });
  });

  it('a malformed JSON file is skipped', () => {
    const { result } = resolve({ [LOCAL]: '{not json', [USER]: statusLine('user') });
    expect(result).toEqual({ type: 'command', command: 'user' });
  });
});
