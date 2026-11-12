import { describe, expect, it } from 'vitest';
import {
  descendantsOf,
  findByCmdline,
  killTree,
  parseStat,
  readProcTable,
} from '../e2e/proc-table.mjs';

describe('parseStat', () => {
  it('reads pid, ppid and comm from a plain /proc stat line', () => {
    expect(parseStat('4242 (electron) S 4000 4242 4242 0 -1 4194560 1 0 0 0')).toEqual({
      pid: 4242,
      ppid: 4000,
      comm: 'electron',
    });
  });

  it('keeps spaces and parentheses inside comm (last ")" closes it)', () => {
    expect(parseStat('77 (Web Content (x) y) R 12 77 77 0')).toEqual({
      pid: 77,
      ppid: 12,
      comm: 'Web Content (x) y',
    });
  });

  it('returns null for text that is not a stat line', () => {
    expect(parseStat('')).toBeNull();
    expect(parseStat('12 no-parens S 1')).toBeNull();
  });
});

describe('readProcTable', () => {
  it('reads every numeric entry, skips non-numeric and vanished ones, NULs become spaces', () => {
    const files: Record<string, string | undefined> = {
      '/proc/10/stat': '10 (electron) S 1 10 10',
      '/proc/10/cmdline': 'electron\0--user-data-dir=/tmp/x\0',
      '/proc/11/stat': '11 (electron) S 10 11 11',
      '/proc/11/cmdline': 'electron\0--type=renderer\0',
      // Exited between readdir and read: both reads throw.
      '/proc/12/stat': undefined,
      // Stat readable, cmdline vanished: the entry is skipped too.
      '/proc/13/stat': '13 (gone) S 10 13 13',
    };
    const readdir = () => ['self', '10', '11', '12', '13', 'sys'];
    const readFile = (path: string) => {
      const v = files[path];
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return v;
    };
    expect(readProcTable({ readdir, readFile })).toEqual([
      { pid: 10, ppid: 1, comm: 'electron', cmdline: 'electron --user-data-dir=/tmp/x' },
      { pid: 11, ppid: 10, comm: 'electron', cmdline: 'electron --type=renderer' },
    ]);
  });
});

const row = (pid: number, ppid: number, cmdline: string | null = null) => ({
  pid,
  ppid,
  comm: `c${pid}`,
  cmdline,
});

describe('descendantsOf', () => {
  const table = [
    row(1, 0),
    row(100, 1),
    row(101, 100),
    row(102, 101),
    row(103, 100),
    row(200, 1),
    row(201, 200),
  ];

  it('returns every descendant of the root and not the root or its siblings', () => {
    expect([...descendantsOf(100, table)].sort((a, b) => a - b)).toEqual([101, 102, 103]);
  });

  it('returns nothing for a leaf or an absent pid', () => {
    expect(descendantsOf(102, table)).toEqual([]);
    expect(descendantsOf(9999, table)).toEqual([]);
  });

  it('terminates on a ppid cycle (pid reuse can produce one)', () => {
    const cyclic = [row(5, 6), row(6, 5)];
    expect([...descendantsOf(5, cyclic)].sort((a, b) => a - b)).toEqual([6]);
  });
});

describe('findByCmdline', () => {
  it('matches rows whose cmdline contains any needle, skipping rows without a cmdline', () => {
    const table = [
      row(1, 0, 'init'),
      row(2, 1, 'electron --conduit-e2e-run=run-A --user-data-dir=/tmp/a'),
      row(3, 2, null),
      row(4, 1, 'node other.mjs'),
      row(5, 1, 'chrome --conduit-e2e-run=run-B'),
    ];
    expect(findByCmdline(table, ['--conduit-e2e-run=run-A']).map((r) => r.pid)).toEqual([2]);
    expect(findByCmdline(table, ['run-B', 'other.mjs']).map((r) => r.pid)).toEqual([4, 5]);
    expect(findByCmdline(table, [])).toEqual([]);
  });
});

describe('killTree', () => {
  it('kills descendants before the root and returns the pids it signalled', () => {
    const table = [row(100, 1), row(101, 100), row(102, 101), row(103, 100)];
    const sent: number[] = [];
    const killed = killTree(100, { readTable: () => table, kill: (pid) => sent.push(pid) });
    expect(sent.at(-1)).toBe(100);
    expect(sent.slice(0, -1).sort((a, b) => a - b)).toEqual([101, 102, 103]);
    expect(killed).toEqual(sent);
  });

  it('keeps going when a pid already exited', () => {
    const table = [row(100, 1), row(101, 100)];
    const sent: number[] = [];
    const kill = (pid: number) => {
      if (pid === 101) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      sent.push(pid);
    };
    expect(killTree(100, { readTable: () => table, kill })).toEqual([100]);
    expect(sent).toEqual([100]);
  });
});

// @ts-expect-error plain .mjs harness module, no declarations
import { profileRows } from '../e2e/harness-server-teardown.mjs';

describe('profileRows (Linux listProfileProcs)', () => {
  const table = [
    row(1, 0, 'systemd'),
    row(50, 1, 'node runner.mjs'),
    row(60, 50, 'electron --user-data-dir=/tmp/conduit-ud-x-1'),
    row(61, 60, 'electron --type=renderer'),
    row(62, 1, 'hc holder conduit-ud-x-1'),
    row(70, 1, 'vim notes.txt'),
    row(80, 999, 'orphan --user-data-dir=/tmp/conduit-ud-x-1'),
  ];
  const needles = ['conduit-ud-x-1'];

  it('returns the matches with their parents and children, in the Windows row shape', () => {
    const rows = profileRows(table, needles, 9999);
    expect(
      rows.map((r: { ProcessId: number }) => r.ProcessId).sort((a: number, b: number) => a - b),
    ).toEqual([1, 50, 60, 61, 62, 80]);
    expect(rows[0]).toEqual({
      ProcessId: 1,
      ParentProcessId: 0,
      Name: 'c1',
      CommandLine: 'systemd',
    });
  });

  it('never returns the given pid, and an excluded seed does not pull in its children', () => {
    const rows = profileRows(table, needles, 60);
    const ids = rows
      .map((r: { ProcessId: number }) => r.ProcessId)
      .sort((a: number, b: number) => a - b);
    expect(ids).toEqual([1, 62, 80]);
  });
});
