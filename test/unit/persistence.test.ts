import { describe, expect, it } from 'vitest';
import {
  parseDocs,
  parseSessions,
  serializeDocs,
  serializeSessions,
  shouldPersistSessions,
} from '../../src/persistence';
import type { PersistedDoc } from '../../src/protocol';
import { COMMAND_AGENT_ID } from '../../src/session-command';
import type { Session } from '../../src/types';
import { docsReducer, initialDocs } from '../../webview/docs';

const s: Session = {
  id: '1',
  name: 'A',
  agentId: 'claude',
  home: '/p',
  roots: [],
  status: 'running',
  createdAt: 100,
  lastActiveAt: 250,
};

const v1 = (sessions: unknown[]) => JSON.stringify({ version: 1, sessions });

function sessionsOf(blob: string | undefined): Session[] {
  const r = parseSessions(blob);
  return r.kind === 'ok' ? r.sessions : [];
}

describe('persistence', () => {
  it('round-trips sessions, forcing restored ones to stale', () => {
    const blob = serializeSessions([s]);
    const restored = sessionsOf(blob);
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('1');
    expect(restored[0].status).toBe('stale'); // live terminals don't survive reload
    expect(restored[0].lastActiveAt).toBe(250);
  });

  it('strips the runtime-only fields rather than freezing a snapshot that lies', () => {
    const blob = serializeSessions([
      {
        ...s,
        lastLine: 'Edit webview/styles.css',
        completedRun: true,
      },
    ]);
    expect(blob).not.toContain('lastLine');
    expect(blob).not.toContain('completedRun');
    const restored = sessionsOf(blob);
    expect(restored[0].lastLine).toBeUndefined();
    expect(restored[0].completedRun).toBeUndefined();
  });

  it('strips repoGit', () => {
    const blob = serializeSessions([
      { ...s, repoGit: { '/r': { kind: 'branch', branch: 'main', dirty: true } } },
    ]);
    expect(blob).not.toContain('repoGit');
    expect(sessionsOf(blob)[0].repoGit).toBeUndefined();
  });

  it('backfills lastActiveAt from createdAt for legacy sessions', () => {
    // A pre-feature blob with createdAt but no lastActiveAt.
    const blob = JSON.stringify({
      version: 1,
      sessions: [
        { id: '1', name: 'A', agentId: 'c', projectPath: '/p', status: 'running', createdAt: 100 },
      ],
    });
    const restored = sessionsOf(blob);
    expect(restored[0].lastActiveAt).toBe(100);
  });

  it('parseSessions reads a legacy projectPath as home', () => {
    const blob = JSON.stringify({
      version: 1,
      sessions: [
        { id: '1', name: 'A', agentId: 'c', projectPath: '/p', status: 'running', createdAt: 100 },
      ],
    });
    const [restored] = sessionsOf(blob);
    expect(restored.home).toBe('/p');
    expect('projectPath' in restored).toBe(false);
  });

  it('returns empty array on corrupt input', () => {
    expect(sessionsOf('not json')).toEqual([]);
    expect(sessionsOf(undefined)).toEqual([]);
    expect(sessionsOf('{"version":999}')).toEqual([]);
    expect(parseSessions('not json')).toEqual({ kind: 'empty' });
    expect(parseSessions('{"version":1,"sessions":{}}')).toEqual({ kind: 'empty' });
  });

  it('serialize writes version 1 with home and a projectPath mirror', () => {
    const parsed = JSON.parse(serializeSessions([{ ...s, roots: ['/r'], projectId: 'p-1' }]));
    expect(parsed.version).toBe(1);
    expect(parsed.sessions[0]).toMatchObject({
      home: '/p',
      projectPath: '/p',
      roots: ['/r'],
      projectId: 'p-1',
    });
  });

  it('serialize strips missingRoots and homeMissing', () => {
    const blob = serializeSessions([
      { ...s, roots: ['/r'], missingRoots: ['/r'], homeMissing: true },
    ]);
    const [entry] = JSON.parse(blob).sessions;
    expect('missingRoots' in entry).toBe(false);
    expect('homeMissing' in entry).toBe(false);
    expect(entry.roots).toEqual(['/r']);
  });

  it('serialize strips agentScope, restartSeq and startRefusal', () => {
    const blob = serializeSessions([
      {
        ...s,
        agentScope: { unseen: ['/a'], stillSeen: [], typeable: ['/a'] },
        restartSeq: 2,
        startRefusal: { reason: 'unresolvable', command: 'claude' },
      },
    ]);
    const [entry] = JSON.parse(blob).sessions;
    expect('agentScope' in entry).toBe(false);
    expect('restartSeq' in entry).toBe(false);
    expect('startRefusal' in entry).toBe(false);
    expect(entry.id).toBe('1');
  });

  it('home preferred, projectPath fallback, id listed in legacyIds', () => {
    const r = parseSessions(
      v1([
        { id: 'new', name: 'N', agentId: 'c', home: '/h', projectPath: '/stale', createdAt: 1 },
        { id: 'old', name: 'O', agentId: 'c', projectPath: '/legacy', createdAt: 1 },
        { id: 'blank', name: 'B', agentId: 'c', home: '', projectPath: '/fallback', createdAt: 1 },
      ]),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.sessions.map((x) => x.home)).toEqual(['/h', '/legacy', '/fallback']);
    expect(r.legacyIds).toEqual(['old', 'blank']);
    expect(r.sessions.every((x) => !('projectPath' in x))).toBe(true);
  });

  it('entry with neither is dropped and counted', () => {
    const r = parseSessions(
      v1([
        { id: 'a', name: 'A', agentId: 'c', home: '/a', createdAt: 1 },
        { id: 'b', name: 'B', agentId: 'c', createdAt: 1 },
        { id: 'c', name: 'C', agentId: 'c', home: 7, projectPath: '', createdAt: 1 },
        null,
      ]),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.dropped).toBe(3);
    expect(r.legacyIds).toEqual([]);
    expect(r.sessions.map((x) => x.id)).toEqual(['a']);
  });

  it('an entry whose id is missing, empty or not a string is dropped and counted', () => {
    const r = parseSessions(
      v1([
        { id: 'a', name: 'A', agentId: 'c', home: '/a', createdAt: 1 },
        { name: 'B', agentId: 'c', home: '/b', createdAt: 1 },
        { id: '', name: 'C', agentId: 'c', home: '/c', createdAt: 1 },
        { id: 7, name: 'D', agentId: 'c', home: '/d', createdAt: 1 },
      ]),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.dropped).toBe(3);
    expect(r.sessions.map((x) => x.id)).toEqual(['a']);
  });

  it('roots: non-array → [], deduped by key, home key dropped', () => {
    const r = parseSessions(
      v1([
        { id: 'a', name: 'A', agentId: 'c', home: 'C:\\h', roots: 'C:\\x', createdAt: 1 },
        {
          id: 'b',
          name: 'B',
          agentId: 'c',
          home: 'C:\\h',
          roots: ['C:\\x', 'c:/X/', '', 3, 'c:/h/', 'C:\\y'],
          createdAt: 1,
        },
      ]),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.sessions[0].roots).toEqual([]);
    expect(r.sessions[1].roots).toEqual(['C:\\x', 'C:\\y']);
  });

  it('non-string projectId deleted', () => {
    const r = parseSessions(
      v1([
        { id: 'a', name: 'A', agentId: 'c', home: '/a', projectId: 5, createdAt: 1 },
        { id: 'b', name: 'B', agentId: 'c', home: '/b', projectId: 'p-1', createdAt: 1 },
      ]),
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect('projectId' in r.sessions[0]).toBe(false);
    expect(r.sessions[1].projectId).toBe('p-1');
  });

  it('version 2 → empty', () => {
    expect(parseSessions(JSON.stringify({ version: 2, sessions: [s] }))).toEqual({
      kind: 'empty',
    });
  });

  it("round trip: an older build's spread of home/roots/projectId survives", () => {
    const live: Session = { ...s, roots: ['/r1', '/r2'], projectId: 'p-abc' };
    const written: Record<string, unknown>[] = JSON.parse(serializeSessions([live])).sessions;
    // An older build spreads every field of an entry it loaded back out on its next write.
    const olderRewrite = v1(written.map((e) => ({ ...e })));
    expect(parseSessions(olderRewrite)).toEqual({
      kind: 'ok',
      sessions: [{ ...live, status: 'stale' }],
      legacyIds: [],
      dropped: 0,
    });
    // An entry that older build ADDED has only projectPath: same session back, flagged legacy.
    const { home: _home, ...mirrorOnly } = written[0];
    expect(parseSessions(v1([mirrorOnly]))).toEqual({
      kind: 'ok',
      sessions: [{ ...live, status: 'stale' }],
      legacyIds: ['1'],
      dropped: 0,
    });
  });
});

describe('shouldPersistSessions', () => {
  // Data-loss guard: with restore OFF the app must NOT overwrite the saved session set —
  // otherwise the next persist/quit writes [] over sessions.json and toggling restore back
  // on brings back nothing.
  it('permits writing the session list only when restore is on', () => {
    expect(shouldPersistSessions({ restoreSessions: true })).toBe(true);
    expect(shouldPersistSessions({ restoreSessions: false })).toBe(false);
  });
});

describe('persistence — editor tabs (docs.json)', () => {
  const docs: PersistedDoc[] = [
    { kind: 'file', path: '/a.ts', sessionId: 'S1' },
    { kind: 'file', path: '/b.ts', sessionId: 'S1', preview: true, active: true },
  ];

  it('round-trips persisted docs', () => {
    expect(parseDocs(serializeDocs(docs))).toEqual(docs);
  });

  it('absent or older/corrupt docs.json degrades to no tabs', () => {
    expect(parseDocs(undefined)).toEqual([]);
    expect(parseDocs('not json')).toEqual([]);
    expect(parseDocs('{"version":999,"docs":[]}')).toEqual([]);
    expect(parseDocs(serializeSessions([]))).toEqual([]); // a sessions blob has no `docs`
  });

  it('drops malformed entries (unknown kind / bad diffScope / missing fields)', () => {
    const blob = JSON.stringify({
      version: 1,
      docs: [
        { kind: 'file', path: '/ok.ts', sessionId: 'S1' },
        { kind: 'diff', path: '/x.ts', sessionId: 'S1' },
        { kind: 'diff', path: '/s.ts', sessionId: 'S1', diffScope: 'staged' },
        { kind: 'diff', path: '/b.ts', sessionId: 'S1', diffScope: 'bogus' },
        { kind: 'file', path: '/f.ts', sessionId: 'S1', diffScope: 'staged' },
        { kind: 'review', path: '@review', sessionId: 'S1' },
        { kind: 'file', sessionId: 'S1' }, // no path
        { kind: 'file', path: '/y.ts' }, // no sessionId
      ],
    });
    expect(parseDocs(blob)).toEqual([
      { kind: 'file', path: '/ok.ts', sessionId: 'S1' },
      { kind: 'diff', path: '/x.ts', sessionId: 'S1' },
      { kind: 'diff', path: '/s.ts', sessionId: 'S1', diffScope: 'staged' },
    ]);
  });

  it('round-trips scoped diff docs with preview/active', () => {
    const docs: PersistedDoc[] = [
      { kind: 'diff', path: '/a.ts', sessionId: 'S1', diffScope: 'unstaged', active: true },
      { kind: 'diff', path: '/a.ts', sessionId: 'S1', preview: true },
    ];
    expect(parseDocs(serializeDocs(docs))).toEqual(docs);
  });

  it('a group:2 entry survives parseDocs', () => {
    const docs: PersistedDoc[] = [
      { kind: 'file', path: '/a.ts', sessionId: 'S1', active: true },
      { kind: 'file', path: '/a.ts', sessionId: 'S1', active: true, group: 2 },
    ];
    expect(parseDocs(serializeDocs(docs))).toEqual(docs);
  });

  it('an entry with group 3 or "2" is dropped', () => {
    const blob = JSON.stringify({
      version: 1,
      docs: [
        { kind: 'file', path: '/ok.ts', sessionId: 'S1' },
        { kind: 'file', path: '/three.ts', sessionId: 'S1', group: 3 },
        { kind: 'file', path: '/str.ts', sessionId: 'S1', group: '2' },
        { kind: 'file', path: '/one.ts', sessionId: 'S1', group: 1 },
      ],
    });
    expect(parseDocs(blob)).toEqual([{ kind: 'file', path: '/ok.ts', sessionId: 'S1' }]);
  });

  it('a bad focus value, or focus on a non-active or group-1 entry, restores the tab unfocused', () => {
    const focused: PersistedDoc = {
      kind: 'file',
      path: '/f.ts',
      sessionId: 'S1',
      active: true,
      group: 2,
      focus: true,
    };
    const bad = ['2', 1, false, {}, null].map((focus, i) => ({
      kind: 'file',
      path: `/bad${i}.ts`,
      sessionId: 'S2',
      active: i === 0,
      group: 2,
      focus,
    }));
    const blob = JSON.stringify({ version: 1, docs: [focused, ...bad] });
    const parsed = parseDocs(blob);
    expect(parsed).toEqual([focused, ...bad.map(({ focus: _, ...d }) => d)]);
    const restore = (docs: PersistedDoc[]) =>
      docsReducer(initialDocs, {
        type: 'restore',
        docs,
        knownSessionIds: ['S1', 'S2', 'S3', 'S4'],
      }).layouts;
    expect(restore(parsed).S1.activeGroup).toBe(2);
    expect(restore(parsed).S2.activeGroup).toBe(1);
    const nonActive: PersistedDoc[] = [
      { kind: 'file', path: '/a.ts', sessionId: 'S3', active: true, group: 2 },
      { kind: 'file', path: '/b.ts', sessionId: 'S3', group: 2, focus: true },
    ];
    expect(restore(nonActive).S3.activeGroup).toBe(1);
    const groupOne: PersistedDoc[] = [
      { kind: 'file', path: '/a.ts', sessionId: 'S4', active: true, focus: true },
    ];
    expect(restore(groupOne).S4.activeGroup).toBe(1);
  });

  it('an old-format file (no group) parses unchanged', () => {
    const blob = JSON.stringify({ version: 1, docs });
    const parsed = parseDocs(blob);
    expect(parsed).toEqual(docs);
    expect(parsed.some((d) => 'group' in d)).toBe(false);
  });
});

describe('conduit MCP session fields', () => {
  it('mcpHandle and mcpNoticesPaused round-trip sessions.json', () => {
    const blob = serializeSessions([{ ...s, mcpHandle: 'claude-3', mcpNoticesPaused: true }]);
    const [back] = sessionsOf(blob);
    expect(back?.mcpHandle).toBe('claude-3');
    expect(back?.mcpNoticesPaused).toBe(true);
  });
});

describe('persistence role brief', () => {
  it('round-trips a valid brief state', () => {
    for (const brief of ['pending', 'sent'] as const) {
      expect(sessionsOf(serializeSessions([{ ...s, brief }]))[0].brief).toBe(brief);
    }
  });

  it('drops an unknown brief value', () => {
    const [r] = sessionsOf(v1([{ ...s, brief: 'bogus' }]));
    expect('brief' in r).toBe(false);
  });
});

describe('persistence — MCP control fields (control-tools spec §3.3)', () => {
  const cmd = { command: 'node', args: ['-e', 'x'] };
  const opener = { handle: 'claude-1', sessionId: 'caller' };

  it('parseSessions keeps valid mcpToolPolicy/command/openedBy', () => {
    const [x] = sessionsOf(
      v1([
        {
          ...s,
          agentId: COMMAND_AGENT_ID,
          mcpToolPolicy: { open_file: { access: 'on' } },
          command: cmd,
          openedBy: opener,
        },
      ]),
    );
    expect(x.mcpToolPolicy).toEqual({ open_file: { access: 'on' } });
    expect(x.command).toEqual(cmd);
    expect(x.openedBy).toEqual(opener);
  });

  it('round-trips through serializeSessions', () => {
    const live: Session = {
      ...s,
      agentId: COMMAND_AGENT_ID,
      mcpToolPolicy: { send_message: { access: 'off' } },
      command: cmd,
      openedBy: opener,
    };
    const [x] = sessionsOf(serializeSessions([live]));
    expect(x.mcpToolPolicy).toEqual({ send_message: { access: 'off' } });
    expect(x.command).toEqual(cmd);
    expect(x.openedBy).toEqual(opener);
  });

  it('drops malformed ones without dropping the entry', () => {
    const r = parseSessions(
      v1([
        {
          ...s,
          id: 'a',
          mcpToolPolicy: { bogus: {}, open_file: { access: 'yes' } },
          openedBy: { handle: 'h' },
          command: 'node',
        },
        {
          ...s,
          id: 'b',
          mcpToolOverrides: { bogus: true, open_session: false },
          openedBy: 3,
          command: { command: '' },
        },
      ]),
    );
    expect(r.kind).toBe('ok');
    const list = r.kind === 'ok' ? r.sessions : [];
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.kind === 'ok' && r.dropped).toBe(0);
    for (const k of ['command', 'openedBy'] as const)
      for (const x of list) expect(k in x).toBe(false);
    expect('mcpToolPolicy' in list[0]).toBe(false);
    // b carries the v0.50 key: migrated, and the raw key is not kept.
    expect(list[1].mcpToolPolicy).toEqual({ open_session: { access: 'off' } });
    expect('mcpToolOverrides' in list[1]).toBe(false);
  });

  it('command session with invalid command loads stale with agentId conduit:command and no command', () => {
    const [x] = sessionsOf(
      v1([{ ...s, agentId: COMMAND_AGENT_ID, command: { command: 'n', args: [1] } }]),
    );
    expect(x.agentId).toBe(COMMAND_AGENT_ID);
    expect(x.status).toBe('stale');
    expect('command' in x).toBe(false);
  });
});

describe('persistence — mcpToolPolicy (tool-policy spec §3.1)', () => {
  it('keeps a valid mcpToolPolicy', () => {
    const policy = { open_session: { access: 'on', when: 'always' }, open_file: { access: 'off' } };
    const [x] = sessionsOf(v1([{ ...s, mcpToolPolicy: policy }]));
    expect(x.mcpToolPolicy).toEqual(policy);
    const [y] = sessionsOf(serializeSessions([x]));
    expect(y.mcpToolPolicy).toEqual(policy);
  });

  it('migrates v0.50 mcpToolOverrides', () => {
    const [x] = sessionsOf(
      v1([{ ...s, mcpToolOverrides: { open_session: true, send_message: false } }]),
    );
    expect(x.mcpToolPolicy).toEqual({
      open_session: { access: 'on', when: 'always' },
      send_message: { access: 'off' },
    });
    // Read once, never written back (only v0.50 writes the old key).
    expect('mcpToolOverrides' in x).toBe(false);
    expect(serializeSessions([x])).not.toContain('mcpToolOverrides');
  });

  it('both keys: the old key overlays the new', () => {
    const [x] = sessionsOf(
      v1([
        {
          ...s,
          mcpToolPolicy: { open_file: { access: 'off' }, open_session: { when: 'viewing' } },
          mcpToolOverrides: { open_session: true },
        },
      ]),
    );
    expect(x.mcpToolPolicy).toEqual({
      open_file: { access: 'off' },
      open_session: { access: 'on', when: 'always' },
    });
  });

  it('malformed policy dropped without dropping the session', () => {
    const r = parseSessions(
      v1([
        { ...s, id: 'a', mcpToolPolicy: { open_file: { access: 'maybe' }, bogus: {} } },
        { ...s, id: 'b', mcpToolPolicy: 'on' },
      ]),
    );
    expect(r.kind).toBe('ok');
    const list = r.kind === 'ok' ? r.sessions : [];
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
    for (const x of list) expect('mcpToolPolicy' in x).toBe(false);
  });
});
