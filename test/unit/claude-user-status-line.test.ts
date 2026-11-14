import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUserStatusLine } from '../../src/claude-user-status-line';
import { STATUS_LINE_CASES } from '../helpers/claude-status-line-cases';

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
  it.each(STATUS_LINE_CASES)('$name', (c) => {
    const files: Record<string, unknown> = {};
    if (c.files.local !== undefined) files[LOCAL] = c.files.local;
    if (c.files.shared !== undefined) files[SHARED] = c.files.shared;
    if (c.files.user !== undefined) files[USER] = c.files.user;
    expect(resolve(files).result?.command ?? null).toBe(c.expect);
  });

  it('reads the three files in precedence order at their joined paths', () => {
    expect(resolve({}).reads).toEqual([LOCAL, SHARED, USER]);
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
});
