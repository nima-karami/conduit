import { describe, expect, it } from 'vitest';
import { MAX_ROOTS } from '../../src/folder-validation';
import { type SeedContext, seedNewSession } from '../../src/new-session-seed';
import {
  type OsOpenChoice,
  osOpenPrefill,
  osOpenSelection,
  osOpenSessions,
  parseOsOpenChoice,
} from '../../src/os-open';
import { DEFAULT_SETTINGS, restoreSettings, serializeSettings } from '../../src/settings';
import type { AgentDefinition, Session } from '../../src/types';

function session(id: string, home: string, options: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    home,
    roots: [],
    agentId: 'shell',
    status: 'running',
    createdAt: 1,
    lastActiveAt: 1,
    ...options,
  };
}

const agent = (id: string): AgentDefinition => ({
  id,
  label: id,
  command: 'sh',
  args: [],
  icon: 'terminal',
  color: 'green',
  cwdStrategy: 'workspaceFolder',
});

const context: SeedContext = {
  active: session('active', '/active', { projectId: 'space' }),
  sessions: [],
  projects: [{ id: 'space', name: 'Space', order: 0 }],
  repos: [{ path: '/git', name: 'Repo', lastOpened: 1, lastAgentId: 'repo-agent' }],
  agents: [agent('shell'), agent('repo-agent')],
  launchers: [],
  defaultAgentId: 'shell',
};

const choice: OsOpenChoice = {
  mode: 'existing',
  agentId: 'repo-agent',
  projectId: null,
  window: 'new',
};

describe('OS-open seed', () => {
  it('keeps the first selected folder as home and attaches unique folders and file roots up to the cap', () => {
    expect(osOpenPrefill(['/home', '/other', '/home'], ['/git', '/other'])).toEqual({
      home: '/home',
      roots: ['/other', '/git'],
    });
    const folders = Array.from({ length: MAX_ROOTS + 2 }, (_, i) => `/d${i}`);
    expect(osOpenPrefill(folders, []).roots).toEqual(folders.slice(1, MAX_ROOTS));
  });

  it('uses the first file root for home and retains roots for files elsewhere', () => {
    expect(osOpenPrefill([], ['/git', '/outside', '/git'])).toEqual({
      home: '/git',
      roots: ['/outside'],
    });
  });

  it('uses normal seeds without a stored choice and preserves an explicit by-path choice', () => {
    expect(seedNewSession(osOpenPrefill([], ['/git']), context)).toEqual({
      home: '/git',
      roots: [],
      projectId: 'space',
      agentId: 'repo-agent',
    });
    expect(seedNewSession(osOpenPrefill(['/new'], [], choice), context)).toMatchObject({
      projectId: null,
      agentId: 'repo-agent',
    });
    expect(
      seedNewSession(
        osOpenPrefill(['/new'], [], {
          ...choice,
          agentId: 'removed',
          projectId: 'removed',
        }),
        context,
      ),
    ).toMatchObject({ projectId: 'space', agentId: 'shell' });
  });
});

describe('OS-open choice', () => {
  const sessions = [
    session('broad', '/work'),
    session('root', '/another', { roots: ['/work/my-project'] }),
    session('home', '/work/my-project'),
    session('prefix', '/work/my'),
    session('outside', '/external'),
    session('stale', '/elsewhere', { status: 'stale' }),
  ];
  const path = '/work/my-project/file.ts';

  it('ranks an already-open file first, then closest ancestors with home winning ties', () => {
    const result = osOpenSessions([path], [path], sessions, [
      { path, sessionId: 'broad' },
      { path, sessionId: 'outside' },
    ]);
    expect(result.matching.map((s) => s.id)).toEqual(['broad', 'home', 'root']);
    expect(result.other.map((s) => s.id)).toEqual(['prefix', 'outside']);
  });

  it('offers only matching sessions for folders and chooses nearest on remembered reuse', () => {
    const result = osOpenSessions(['/work/my-project'], [], sessions, []);
    expect(result.matching.map((s) => s.id)).toEqual(['home', 'root', 'broad']);
    expect(result.other).toEqual([]);
    expect(osOpenSelection(choice, result.matching)).toBe('home');
    expect(osOpenSelection(choice, [])).toBeNull();
    expect(osOpenSelection({ ...choice, mode: 'new' }, result.matching)).toBeNull();
    expect(osOpenSelection(undefined, result.matching)).toBeNull();
  });

  it('round trips a stored choice and ignores corrupt, partial or unrecognized records', () => {
    expect(parseOsOpenChoice(JSON.stringify(choice))).toEqual(choice);
    for (const raw of [
      undefined,
      '{',
      'null',
      '{}',
      JSON.stringify({ ...choice, window: 'else' }),
    ]) {
      expect(parseOsOpenChoice(raw)).toBeUndefined();
    }
  });

  it('defaults to asking for old settings and round trips an opt-out', () => {
    expect(restoreSettings('{"version":1,"settings":{}}').askOsOpen).toBe(true);
    expect(
      restoreSettings(serializeSettings({ ...DEFAULT_SETTINGS, askOsOpen: false })).askOsOpen,
    ).toBe(false);
  });
});
