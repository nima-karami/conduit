import { EventEmitter } from 'node:events';
import type * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FsFire, ProjectWatcher } from '../../electron/project-watcher';

type Listener = (event: string, filename: string | Buffer | null) => void;

function setup(opts: { throwOn?: string[] } = {}) {
  const watches: { dir: string; cb: Listener; w: EventEmitter; closed: boolean }[] = [];
  const closed: string[] = [];
  const watch = (dir: string, _o: { recursive: true }, cb: Listener): fs.FSWatcher => {
    if (opts.throwOn?.includes(dir)) throw new Error(`ENOENT ${dir}`);
    const entry = { dir, cb, closed: false, w: new EventEmitter() };
    const close = () => {
      entry.closed = true;
      closed.push(dir);
    };
    watches.push(entry);
    return Object.assign(entry.w, { close }) as unknown as fs.FSWatcher;
  };
  const fires: FsFire[] = [];
  const suspects: string[][] = [];
  const logs: string[] = [];
  const pw = new ProjectWatcher((f) => fires.push(f), {
    debounceMs: 300,
    watch,
    log: (m) => logs.push(m),
    onSuspect: (folders) => suspects.push(folders),
  });
  const open = () => watches.filter((x) => !x.closed);
  const emit = (dir: string, filename: string | null) => {
    const x = open().find((o) => o.dir === dir);
    if (!x) throw new Error(`no open watch on ${dir}`);
    x.cb('change', filename);
  };
  return { pw, watches, closed, fires, suspects, logs, open, emit };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ProjectWatcher', () => {
  it('single folder: one watch, one fire per window {root:p, folders:[p]}', () => {
    const h = setup();
    h.pw.setFolders(['C:\\w\\p']);
    expect(h.watches.map((w) => w.dir)).toEqual(['C:\\w\\p']);
    h.emit('C:\\w\\p', 'a.ts');
    h.emit('C:\\w\\p', 'src\\b.ts');
    vi.advanceTimersByTime(299);
    expect(h.fires).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.fires).toEqual([{ root: 'C:\\w\\p', folders: ['C:\\w\\p'] }]);
    h.emit('C:\\w\\p', 'c.ts');
    vi.advanceTimersByTime(300);
    expect(h.fires).toHaveLength(2);
  });

  it('cwd inside home: one watch, ONE fire {root: cwd, folders: [cwd, home]}', () => {
    const h = setup();
    h.pw.setFolders(['/w/home/sub', '/w/home']);
    expect(h.watches.map((w) => w.dir)).toEqual(['/w/home']);
    h.emit('/w/home', 'sub/a.ts');
    vi.advanceTimersByTime(300);
    expect(h.fires).toEqual([{ root: '/w/home/sub', folders: ['/w/home/sub', '/w/home'] }]);
    h.emit('/w/home', 'other.ts');
    vi.advanceTimersByTime(300);
    expect(h.fires[1]).toEqual({ root: '/w/home', folders: ['/w/home'] });
  });

  it('change only under an attached root → {root: R, folders: [R]}', () => {
    const h = setup();
    h.pw.setFolders(['/w/home', '/x/R']);
    expect(h.watches.map((w) => w.dir)).toEqual(['/w/home', '/x/R']);
    h.emit('/x/R', 'new.txt');
    vi.advanceTimersByTime(300);
    expect(h.fires).toEqual([{ root: '/x/R', folders: ['/x/R'] }]);
    h.emit('/x/R', 'a');
    h.emit('/w/home', 'b');
    vi.advanceTimersByTime(300);
    expect(h.fires[1]).toEqual({ root: '/w/home', folders: ['/w/home', '/x/R'] });
  });

  it('home/sub/.git/objects change with cwd = home/sub is ignored', () => {
    const h = setup();
    h.pw.setFolders(['/w/home/sub', '/w/home']);
    h.emit('/w/home', 'sub/.git/objects/ab/cdef');
    h.emit('/w/home', 'sub\\.git\\index.lock');
    vi.advanceTimersByTime(300);
    expect(h.fires).toEqual([]);
    h.emit('/w/home', 'sub/.git/HEAD');
    vi.advanceTimersByTime(300);
    expect(h.fires).toEqual([{ root: '/w/home/sub', folders: ['/w/home/sub', '/w/home'] }]);
  });

  it('change in home/dist with cwd = home/dist fires', () => {
    const h = setup();
    h.pw.setFolders(['C:\\w\\Home\\dist', 'C:\\w\\Home']);
    h.emit('C:\\w\\Home', 'dist\\bundle.js');
    vi.advanceTimersByTime(300);
    expect(h.fires).toEqual([
      { root: 'C:\\w\\Home\\dist', folders: ['C:\\w\\Home\\dist', 'C:\\w\\Home'] },
    ]);
    h.pw.setFolders(['C:\\w\\Home']);
    h.emit('C:\\w\\Home', 'dist\\bundle.js');
    vi.advanceTimersByTime(300);
    expect(h.fires).toHaveLength(1);
  });

  it('10 000 events in a window → one fire, no path retained', () => {
    const h = setup();
    h.pw.setFolders(['/w/home', '/x/R']);
    for (let i = 0; i < 10_000; i++) h.emit(i % 2 ? '/w/home' : '/x/R', `f${i}.ts`);
    const retained = Object.values(h.pw).filter(
      (v) => (v instanceof Set || v instanceof Map || Array.isArray(v)) && collectionSize(v) > 2,
    );
    expect(retained).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(h.fires).toEqual([{ root: '/w/home', folders: ['/w/home', '/x/R'] }]);
  });

  it('null filename → every folder of that watch + onSuspect', () => {
    const h = setup();
    h.pw.setFolders(['/w/home/sub', '/x/R', '/w/home']);
    h.emit('/w/home', null);
    expect(h.suspects).toEqual([['/w/home/sub', '/w/home']]);
    vi.advanceTimersByTime(300);
    expect(h.fires).toEqual([{ root: '/w/home/sub', folders: ['/w/home/sub', '/w/home'] }]);
  });

  it('watch error → onSuspect(its folders), watch dropped', () => {
    const h = setup();
    h.pw.setFolders(['/w/home/sub', '/w/home', '/x/R']);
    h.watches[0].w.emit('error', new Error('EPERM'));
    expect(h.suspects).toEqual([['/w/home/sub', '/w/home']]);
    expect(h.closed).toEqual(['/w/home']);
    expect(h.open().map((w) => w.dir)).toEqual(['/x/R']);
    h.pw.setFolders(['/w/home/sub', '/w/home', '/x/R']);
    expect(h.open().map((w) => w.dir)).toEqual(['/x/R', '/w/home']);
  });

  it('a folder whose watch throws is reported suspect and the rest still watch', () => {
    const h = setup({ throwOn: ['/gone'] });
    h.pw.setFolders(['/w/home', '/gone']);
    expect(h.suspects).toEqual([['/gone']]);
    expect(h.open().map((w) => w.dir)).toEqual(['/w/home']);
  });

  it('same set → no new watch; dropped folder closes its watch', () => {
    const h = setup();
    h.pw.setFolders(['/w/home', '/x/R']);
    h.pw.setFolders(['/w/home/', '/x/R']);
    expect(h.watches).toHaveLength(2);
    h.pw.setFolders(['/w/home']);
    expect(h.closed).toEqual(['/x/R']);
    h.pw.setFolders(['/w']);
    expect(h.closed).toEqual(['/x/R', '/w/home']);
    expect(h.open().map((w) => w.dir)).toEqual(['/w']);
    h.pw.stop();
    expect(h.open()).toEqual([]);
  });

  it('a pending window survives a re-registration and reports current spellings', () => {
    const h = setup();
    h.pw.setFolders(['/w/home', '/x/R']);
    h.emit('/x/R', 'a');
    h.pw.setFolders(['/x/R/sub', '/x/R']);
    vi.advanceTimersByTime(300);
    expect(h.fires).toEqual([{ root: '/x/R', folders: ['/x/R'] }]);
  });

  it('duplicate spellings dedupe by key, first wins', () => {
    const h = setup();
    h.pw.setFolders(['C:\\W\\Home', 'c:/w/home/']);
    expect(h.watches.map((w) => w.dir)).toEqual(['C:\\W\\Home']);
    h.emit('C:\\W\\Home', 'x');
    vi.advanceTimersByTime(300);
    expect(h.fires).toEqual([{ root: 'C:\\W\\Home', folders: ['C:\\W\\Home'] }]);
  });
});

function collectionSize(v: Set<unknown> | Map<unknown, unknown> | unknown[]): number {
  return Array.isArray(v) ? v.length : v.size;
}
