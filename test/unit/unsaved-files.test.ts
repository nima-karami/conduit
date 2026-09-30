import { describe, expect, it } from 'vitest';
import type { DirtyFile } from '../../src/quit-guard';
import type { SaveKind } from '../../webview/auto-save-policy';
import type { OpenDoc } from '../../webview/docs';
import type { FileSaveStatus } from '../../webview/file-save-controller';
import {
  type SaveProbe,
  saveUnsaved,
  sessionDirtyPaths,
  unsavedFiles,
} from '../../webview/unsaved-files';

function status(over: Partial<FileSaveStatus> = {}): FileSaveStatus {
  return { phase: 'dirty', edited: true, conflict: null, error: null, ...over };
}

interface FakeProbe extends SaveProbe {
  statuses: Map<string, FileSaveStatus>;
  partial: Set<string>;
  writes: [string, SaveKind][];
}

function probe(
  statuses: Record<string, FileSaveStatus>,
  opts: {
    partial?: string[];
    onSave?: (path: string, kind: SaveKind, p: FakeProbe) => boolean;
  } = {},
): FakeProbe {
  const p: FakeProbe = {
    statuses: new Map(Object.entries(statuses)),
    partial: new Set(opts.partial ?? []),
    writes: [],
    getStatus: (path) => p.statuses.get(path),
    isPartial: (path) => p.partial.has(path),
    save: async (path, kind) => {
      p.writes.push([path, kind]);
      if (opts.onSave) return opts.onSave(path, kind, p);
      p.statuses.set(path, status({ phase: 'clean', edited: false }));
      return true;
    },
  };
  return p;
}

const noRoot = () => undefined;

function row(path: string, tag: DirtyFile['tag']): DirtyFile {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), dir: '', tag };
}

describe('unsavedFiles', () => {
  it('tag precedence', () => {
    const p = probe(
      {
        '/r/partial-with-status.ts': status({ phase: 'conflict' }),
        '/r/conflict.ts': status({ phase: 'conflict', error: 'boom' }),
        '/r/failed.ts': status({ phase: 'failed', error: 'EACCES', edited: false }),
        '/r/seed.ts': status({ edited: false }),
        '/r/plain.ts': status(),
      },
      { partial: ['/r/partial-with-status.ts', '/r/partial-no-status.ts'] },
    );
    const files = unsavedFiles(
      [
        '/r/partial-with-status.ts',
        '/r/partial-no-status.ts',
        '/r/missing.ts',
        '/r/conflict.ts',
        '/r/failed.ts',
        '/r/seed.ts',
        '/r/plain.ts',
      ],
      p,
      noRoot,
    );
    expect(files.map((f) => f.tag)).toEqual([
      'partial',
      'partial',
      'noEntry',
      'conflict',
      'failed',
      'notEdited',
      null,
    ]);
    expect(files[4].error).toBe('EACCES');
    expect(files[3].error).toBeUndefined();
  });

  it('dir is root-relative with / and empty at root', () => {
    const paths = ['/r/src/deep/a.ts', '/r/top.ts', 'C:\\w\\src\\lib\\b.ts', '/elsewhere/x/c.ts'];
    const p = probe(Object.fromEntries(paths.map((x) => [x, status()])));
    const rootOf = (x: string) => {
      if (x.startsWith('/r/')) return '/r';
      if (x.startsWith('C:')) return 'C:\\w';
      return undefined;
    };
    const sessionOf = (x: string) => (x === '/r/top.ts' ? 's1' : undefined);
    const files = unsavedFiles(paths, p, rootOf, sessionOf);
    expect(files.map((f) => [f.name, f.dir])).toEqual([
      ['a.ts', 'src/deep'],
      ['top.ts', ''],
      ['b.ts', 'src/lib'],
      ['c.ts', '/elsewhere/x'],
    ]);
    expect(files.map((f) => f.session)).toEqual([undefined, 's1', undefined, undefined]);
  });
});

describe('saveUnsaved', () => {
  it('conflict row saved with force, others manual', async () => {
    const p = probe({ '/r/a.ts': status({ phase: 'conflict' }), '/r/b.ts': status() });
    const out = await saveUnsaved([row('/r/a.ts', 'conflict'), row('/r/b.ts', null)], p);
    expect(p.writes.map(([, k]) => k)).toEqual(['force', 'manual']);
    expect(out).toEqual({ saved: ['/r/a.ts', '/r/b.ts'], unsaved: [] });
  });

  it('a path that entered conflict after listing (tag null) is saved manual and comes back tagged conflict in unsaved', async () => {
    const p = probe(
      { '/r/a.ts': status({ phase: 'conflict' }) },
      {
        onSave: (path, _k, fp) => {
          fp.statuses.set(path, status({ phase: 'conflict' }));
          return false;
        },
      },
    );
    const listed: DirtyFile = { ...row('/r/a.ts', null), dir: 'src', session: 's1' };
    const out = await saveUnsaved([listed], p);
    expect(p.writes).toEqual([['/r/a.ts', 'manual']]);
    expect(out).toEqual({ saved: [], unsaved: [{ ...listed, tag: 'conflict' }] });
  });

  it('noEntry/partial never written, reported unsaved', async () => {
    const p = probe({ '/r/c.ts': status() }, { partial: ['/r/b.ts'] });
    const files = [row('/r/a.ts', 'noEntry'), row('/r/b.ts', 'partial'), row('/r/c.ts', null)];
    const out = await saveUnsaved(files, p);
    expect(p.writes).toEqual([['/r/c.ts', 'manual']]);
    expect(out).toEqual({ saved: ['/r/c.ts'], unsaved: [files[0], files[1]] });
  });

  it('save() true but phase not clean → unsaved', async () => {
    const p = probe(
      { '/r/a.ts': status() },
      {
        onSave: (path, _k, fp) => {
          fp.statuses.set(path, status({ phase: 'failed', error: 'disk full' }));
          return true;
        },
      },
    );
    const out = await saveUnsaved([row('/r/a.ts', null)], p);
    expect(out).toEqual({
      saved: [],
      unsaved: [{ ...row('/r/a.ts', null), tag: 'failed', error: 'disk full' }],
    });
  });

  it('a re-tagged row drops the error of its old tag', async () => {
    const p = probe(
      { '/r/a.ts': status({ phase: 'failed', error: 'EACCES' }) },
      {
        onSave: (path, _k, fp) => {
          fp.statuses.set(path, status({ phase: 'conflict' }));
          return false;
        },
      },
    );
    const out = await saveUnsaved([{ ...row('/r/a.ts', 'failed'), error: 'EACCES' }], p);
    expect(out.unsaved).toEqual([{ ...row('/r/a.ts', null), tag: 'conflict' }]);
  });

  it('writes run one at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const p = probe({ '/r/a.ts': status(), '/r/b.ts': status() });
    p.save = async (path) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      p.statuses.set(path, status({ phase: 'clean' }));
      return true;
    };
    const out = await saveUnsaved([row('/r/a.ts', null), row('/r/b.ts', null)], p);
    expect(out.saved).toEqual(['/r/a.ts', '/r/b.ts']);
    expect(peak).toBe(1);
  });
});

function doc(path: string, sessionId: string, kind: OpenDoc['kind'] = 'file'): OpenDoc {
  return { id: `${kind}:${path}`, kind, path, title: path, sessionId };
}

describe('sessionDirtyPaths', () => {
  it('sessionDirtyPaths unions sessions, dedupes, intersects dirty', () => {
    const docs = [
      doc('/r/b.ts', 's2'),
      doc('/r/a.ts', 's1'),
      doc('/r/clean.ts', 's1'),
      doc('/r/c.ts', 's3'),
      doc('/r/a.ts', 's2'),
      doc('/r/d.ts', 's1', 'diff'),
    ];
    const dirty = new Set(['/r/a.ts', '/r/b.ts', '/r/c.ts', '/r/d.ts']);
    expect(sessionDirtyPaths(docs, ['s1', 's2'], dirty)).toEqual(['/r/a.ts', '/r/b.ts']);
    expect(sessionDirtyPaths(docs, [], dirty)).toEqual([]);
  });
});
