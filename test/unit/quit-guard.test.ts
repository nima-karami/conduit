import { describe, expect, it } from 'vitest';
import {
  busySessions,
  DIRTY_ROW_CAP,
  type DirtyCloseCopyInput,
  type DirtyFile,
  type DirtyTag,
  dirtyCloseCopy,
  dirtySaveStatus,
  quitConfirmCopy,
  runningSessions,
} from '../../src/quit-guard';
import type { Session } from '../../src/types';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'my-session',
    agentId: 'shell:cmd',
    home: 'C:/proj',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// runningSessions
// ──────────────────────────────────────────────────────────────────────────────

describe('runningSessions', () => {
  it('returns only sessions with status running', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', status: 'running' }),
      makeSession({ id: 'b', status: 'exited' }),
      makeSession({ id: 'c', status: 'stale' }),
      makeSession({ id: 'd', status: 'running' }),
    ];
    const result = runningSessions(sessions);
    expect(result.map((s) => s.id)).toEqual(['a', 'd']);
  });

  it('returns empty array when no sessions are running', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', status: 'exited' }),
      makeSession({ id: 'b', status: 'stale' }),
    ];
    expect(runningSessions(sessions)).toEqual([]);
  });

  it('returns all sessions when all are running', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', status: 'running' }),
      makeSession({ id: 'b', status: 'running' }),
    ];
    expect(runningSessions(sessions)).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(runningSessions([])).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// busySessions
// ──────────────────────────────────────────────────────────────────────────────

describe('busySessions', () => {
  it('returns only running sessions that are busy', () => {
    const sessions: Session[] = [
      makeSession({ id: 'a', status: 'running', busy: true }),
      makeSession({ id: 'b', status: 'running', busy: false }),
      makeSession({ id: 'c', status: 'running' }), // busy undefined → falsy
      makeSession({ id: 'd', status: 'exited', busy: true }), // not running
      makeSession({ id: 'e', status: 'running', busy: true }),
    ];
    const result = busySessions(sessions);
    expect(result.map((s) => s.id)).toEqual(['a', 'e']);
  });

  it('excludes exited/stale sessions even when flagged busy', () => {
    const sessions: Session[] = [
      makeSession({ id: 'x', status: 'stale', busy: true }),
      makeSession({ id: 'y', status: 'exited', busy: true }),
    ];
    expect(busySessions(sessions)).toEqual([]);
  });

  it('returns empty array when no running sessions are busy', () => {
    const sessions: Session[] = [makeSession({ id: 'a', status: 'running', busy: false })];
    expect(busySessions(sessions)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(busySessions([])).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// quitConfirmCopy — quit reason, plural, with busy sessions
// ──────────────────────────────────────────────────────────────────────────────

describe('quitConfirmCopy', () => {
  const twoRunning = 2;

  describe('reason: quit — plural, with busy', () => {
    it('title counts sessions', () => {
      const { title } = quitConfirmCopy({ running: twoRunning, busy: 1, reason: 'quit' });
      expect(title).toBe('2 sessions still running');
    });

    it('body mentions quitting and busy clause', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 1, reason: 'quit' });
      expect(body).toContain('2 running agents');
      expect(body).toContain('(1 actively working)');
    });

    it('confirmLabel is "Quit"', () => {
      const { confirmLabel } = quitConfirmCopy({ running: twoRunning, busy: 1, reason: 'quit' });
      expect(confirmLabel).toBe('Quit');
    });
  });

  describe('reason: quit — plural, busy = 0', () => {
    it('omits the busy clause when busy = 0', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 0, reason: 'quit' });
      expect(body).not.toContain('actively working');
    });

    it('still mentions the agent count', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 0, reason: 'quit' });
      expect(body).toContain('2 running agents');
    });
  });

  describe('reason: quit — singular', () => {
    const oneRunning = 1;

    it('title uses singular "session"', () => {
      const { title } = quitConfirmCopy({ running: oneRunning, busy: 0, reason: 'quit' });
      expect(title).toBe('1 session still running');
    });

    it('body uses singular "agent"', () => {
      const { body } = quitConfirmCopy({ running: oneRunning, busy: 0, reason: 'quit' });
      expect(body).toContain('1 running agent');
      expect(body).not.toContain('agents');
    });
  });

  describe('reason: update — plural, with busy', () => {
    it('title counts sessions', () => {
      const { title } = quitConfirmCopy({ running: twoRunning, busy: 2, reason: 'update' });
      expect(title).toBe('2 sessions still running');
    });

    it('body mentions closing and relaunch', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 2, reason: 'update' });
      expect(body).toContain('closes');
      expect(body).toContain('relaunch');
      expect(body).toContain('(2 actively working)');
    });

    it('confirmLabel is "Relaunch & update"', () => {
      const { confirmLabel } = quitConfirmCopy({ running: twoRunning, busy: 2, reason: 'update' });
      expect(confirmLabel).toBe('Relaunch & update');
    });
  });

  describe('reason: update — plural, busy = 0', () => {
    it('omits the busy clause', () => {
      const { body } = quitConfirmCopy({ running: twoRunning, busy: 0, reason: 'update' });
      expect(body).not.toContain('actively working');
    });
  });

  describe('reason: update — singular', () => {
    const oneRunning = 1;

    it('title uses singular "session"', () => {
      const { title } = quitConfirmCopy({ running: oneRunning, busy: 0, reason: 'update' });
      expect(title).toBe('1 session still running');
    });

    it('body uses singular "agent"', () => {
      const { body } = quitConfirmCopy({ running: oneRunning, busy: 0, reason: 'update' });
      expect(body).toContain('1 running agent');
      expect(body).not.toContain('agents');
    });
  });
});

describe('quitConfirmCopy windowClose', () => {
  it('quitConfirmCopy windowClose == quit copy', () => {
    const running = 2;
    expect(quitConfirmCopy({ running, busy: 1, reason: 'windowClose' })).toEqual(
      quitConfirmCopy({ running, busy: 1, reason: 'quit' }),
    );
  });
});

function file(path: string, tag: DirtyTag = null, extra: Partial<DirtyFile> = {}): DirtyFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, dir: 'src', tag, ...extra };
}

function copyOf(input: Partial<DirtyCloseCopyInput> & Pick<DirtyCloseCopyInput, 'files'>) {
  return dirtyCloseCopy({ running: 0, busy: 0, reason: 'quit', ...input });
}

describe('dirtyCloseCopy', () => {
  it('1 file title names it', () => {
    const c = copyOf({ files: [file('/r/src/a.ts')] });
    expect(c.title).toBe('Do you want to save the changes you made to a.ts?');
    expect(c.summary).toBe("Your changes will be lost if you don't save them.");
    expect(c.labels).toEqual({
      save: 'Save All',
      discard: "Don't Save",
      cancel: 'Cancel',
      saving: 'Saving…',
    });
  });

  it('3 files', () => {
    const c = copyOf({ files: [file('/r/a.ts'), file('/r/b.ts'), file('/r/c.ts')] });
    expect(c.title).toBe('Do you want to save the changes you made to 3 files?');
  });

  it("saved rows don't count toward the title", () => {
    const c = copyOf({
      files: [file('/r/a.ts', 'saved'), file('/r/b.ts'), file('/r/c.ts', 'saved')],
    });
    expect(c.title).toBe('Do you want to save the changes you made to b.ts?');
    const two = copyOf({ files: [file('/r/a.ts', 'saved'), file('/r/b.ts'), file('/r/c.ts')] });
    expect(two.title).toBe('Do you want to save the changes you made to 2 files?');
  });

  it('12 files → 10 rows, overflow 2', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`/r/f${i}.ts`));
    const c = copyOf({ files });
    expect(DIRTY_ROW_CAP).toBe(10);
    expect(c.rows.map((r) => r.path)).toEqual(files.slice(0, 10).map((f) => f.path));
    expect(c.overflow).toBe(2);
    expect(copyOf({ files: files.slice(0, 3) }).overflow).toBe(0);
  });

  it("each tag's exact text and danger flag", () => {
    const c = copyOf({
      files: [
        file('/r/a.ts', 'conflict'),
        file('/r/b.ts', 'failed', { error: 'EACCES' }),
        file('/r/c.ts', 'notEdited'),
        file('/r/d.ts', 'noEntry'),
        file('/r/e.ts', 'partial'),
        file('/r/f.ts', 'saved'),
        file('/r/g.ts', null),
      ],
    });
    expect(c.rows.map((r) => [r.tag, r.danger])).toEqual([
      ['changed on disk — Save All overwrites it', false],
      ['save failed: EACCES', true],
      ['not edited', false],
      ["can't be saved here", true],
      ["partly loaded, can't be saved", true],
      ['Saved', false],
      [null, false],
    ]);
  });

  it('running line per reason, with busy suffix and plurals', () => {
    const files = [file('/r/a.ts')];
    expect(copyOf({ files, running: 1, reason: 'quit' }).lines).toEqual([
      'Quitting will also stop 1 running agent.',
    ]);
    expect(copyOf({ files, running: 3, busy: 2, reason: 'quit' }).lines).toEqual([
      'Quitting will also stop 3 running agents (2 actively working).',
    ]);
    expect(copyOf({ files, running: 2, reason: 'windowClose' }).lines).toEqual([
      'Closing this window will also stop 2 running agents.',
    ]);
    expect(copyOf({ files, running: 1, busy: 1, reason: 'sessionClose' }).lines).toEqual([
      'Closing will also stop 1 running agent (1 actively working).',
    ]);
    expect(copyOf({ files, running: 0, reason: 'quit' }).lines).toEqual([]);
  });

  it('no running line for sessionMove', () => {
    expect(copyOf({ files: [file('/r/a.ts')], running: 2, reason: 'sessionMove' }).lines).toEqual(
      [],
    );
  });

  it('update line', () => {
    expect(copyOf({ files: [file('/r/a.ts')], running: 2, reason: 'update' }).lines).toEqual([
      'Quitting will also stop 2 running agents.',
      'Conduit will relaunch to install the update.',
    ]);
  });

  it('exited subline', () => {
    expect(
      copyOf({ files: [file('/r/a.ts')], reason: 'sessionClose', exitedSession: 'api' }).lines,
    ).toEqual(['“api” has exited. Closing it closes its tabs.']);
  });

  it('grouped rows carry session', () => {
    const files = [
      file('/r/a.ts', null, { session: 'one' }),
      file('/r/b.ts', null, { session: 'two' }),
    ];
    expect(copyOf({ files, grouped: true }).rows.map((r) => r.group)).toEqual(['one', 'two']);
    expect(copyOf({ files }).rows.map((r) => r.group)).toEqual([undefined, undefined]);
  });

  it('long name middle-ellipsized, extension kept, title is full path', () => {
    const long = `${'a'.repeat(30)}${'b'.repeat(30)}.test.tsx`;
    const path = `/r/src/${long}`;
    const [row] = copyOf({ files: [file(path)] }).rows;
    expect(row.name).toHaveLength(40);
    expect(row.name).toContain('…');
    expect(row.name.startsWith('aaaa')).toBe(true);
    expect(row.name.endsWith('b.test.tsx')).toBe(true);
    expect(row.title).toBe(path);
    expect(row.dir).toBe('src');
    const short = copyOf({ files: [file('/r/short.ts')] }).rows[0];
    expect(short.name).toBe('short.ts');
  });
});

describe('dirtySaveStatus', () => {
  it('dirtySaveStatus plurals', () => {
    expect(dirtySaveStatus('saving', 1)).toBe('Saving 1 file');
    expect(dirtySaveStatus('saving', 4)).toBe('Saving 4 files');
    expect(dirtySaveStatus('failed', 1)).toBe("1 file couldn't be saved");
    expect(dirtySaveStatus('failed', 2)).toBe("2 files couldn't be saved");
  });
});
