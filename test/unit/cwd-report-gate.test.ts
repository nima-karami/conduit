import { describe, expect, it, vi } from 'vitest';
import { type CwdReportGateDeps, createCwdReportGate } from '../../src/cwd-report-gate';
import { parseCwdReports } from '../../src/osc-cwd';

type Kind = 'file' | 'dir' | null;

/** A stat whose answers are released by hand, so report ordering is explicit. */
function harness(opts: { roots?: string[] | null; cwd?: string } = {}) {
  const pending = new Map<string, Array<(k: Kind) => void>>();
  const stat = vi.fn(
    (abs: string) =>
      new Promise<Kind>((resolve) => {
        const list = pending.get(abs) ?? [];
        list.push(resolve);
        pending.set(abs, list);
      }),
  );
  let cwd = opts.cwd ?? 'G:/w';
  const accepted: string[] = [];
  const deps: CwdReportGateDeps = {
    stat,
    userRoots: () => (opts.roots === undefined ? ['G:/w'] : opts.roots),
    accept: (_id, next) => {
      if (next === cwd) return;
      cwd = next;
      accepted.push(next);
    },
    platform: 'win32',
    caseSensitive: false,
  };
  const gate = createCwdReportGate(deps);
  const release = async (abs: string, kind: Kind) => {
    const list = pending.get(abs) ?? [];
    const next = list.shift();
    if (!next) throw new Error(`no pending stat for ${abs}`);
    next(kind);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { gate, stat, accepted, release, cwd: () => cwd };
}

describe('createCwdReportGate', () => {
  it('a UNC report with no UNC user root is refused: stat and accept never called', async () => {
    const h = harness();
    h.gate.report('s', '\\\\evil\\share');
    h.gate.report('s', '//evil/share/x');
    await Promise.resolve();
    expect(h.stat).not.toHaveBeenCalled();
    expect(h.accepted).toEqual([]);
  });

  it('device paths are refused with no stat', () => {
    const h = harness();
    h.gate.report('s', '//?/G:/x');
    h.gate.report('s', '\\\\.\\pipe\\x');
    expect(h.stat).not.toHaveBeenCalled();
  });

  it('a UNC cwd under a UNC home is stat’ed and accepted when it is a dir', async () => {
    const h = harness({ roots: ['//srv/share'], cwd: '//srv/share' });
    h.gate.report('s', '\\\\SRV\\share\\sub');
    expect(h.stat).toHaveBeenCalledWith('//SRV/share/sub');
    await h.release('//SRV/share/sub', 'dir');
    expect(h.accepted).toEqual(['//SRV/share/sub']);
  });

  it('stats and accepts the normalized form it judged, not the raw report', async () => {
    const h = harness();
    h.gate.report('s', 'g:\\w\\src\\.\\');
    expect(h.stat).toHaveBeenCalledWith('G:/w/src');
    await h.release('G:/w/src', 'dir');
    expect(h.accepted).toEqual(['G:/w/src']);
  });

  it('a cwd moved outside every user root to a UNC path is refused (the cwd repo is never a user root)', () => {
    const h = harness({ roots: ['G:/w'], cwd: '//evil/share/repo' });
    h.gate.report('s', '//evil/share/repo/sub');
    expect(h.stat).not.toHaveBeenCalled();
  });

  it('a local dir is accepted after the async stat; a file or a miss is ignored', async () => {
    const h = harness();
    h.gate.report('s', 'G:/w/src');
    expect(h.accepted).toEqual([]);
    await h.release('G:/w/src', 'dir');
    expect(h.accepted).toEqual(['G:/w/src']);
    h.gate.report('s', 'G:/w/file.txt');
    await h.release('G:/w/file.txt', 'file');
    h.gate.report('s', 'G:/w/gone');
    await h.release('G:/w/gone', null);
    expect(h.accepted).toEqual(['G:/w/src']);
  });

  it('a rejected stat is a miss', async () => {
    const h = harness();
    const deps: CwdReportGateDeps = {
      stat: () => Promise.reject(new Error('EPERM')),
      userRoots: () => ['G:/w'],
      accept: () => {
        throw new Error('must not accept');
      },
      platform: 'win32',
      caseSensitive: false,
    };
    createCwdReportGate(deps).report('s', 'G:/w/x');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.accepted).toEqual([]);
  });

  it('out of order: A (slow) then B (fast) → only B is accepted', async () => {
    const h = harness();
    h.gate.report('s', 'G:/w/a');
    h.gate.report('s', 'G:/w/b');
    await h.release('G:/w/b', 'dir');
    await h.release('G:/w/a', 'dir');
    expect(h.accepted).toEqual(['G:/w/b']);
    expect(h.cwd()).toBe('G:/w/b');
  });

  it('A→B(slow)→A: B is dropped, cwd stays A', async () => {
    const h = harness({ cwd: 'G:/w/a' });
    h.gate.report('s', 'G:/w/b');
    h.gate.report('s', 'G:/w/a');
    expect(h.stat).toHaveBeenCalledTimes(2);
    await h.release('G:/w/a', 'dir');
    await h.release('G:/w/b', 'dir');
    expect(h.accepted).toEqual([]);
    expect(h.cwd()).toBe('G:/w/a');
  });

  it('a refused report still supersedes an older pending one', async () => {
    const h = harness();
    h.gate.report('s', 'G:/w/a');
    h.gate.report('s', '//evil/share');
    await h.release('G:/w/a', 'dir');
    expect(h.accepted).toEqual([]);
  });

  it('session gone (userRoots null) → nothing accepted, no stat', () => {
    const h = harness({ roots: null });
    h.gate.report('s', 'G:/w/a');
    expect(h.stat).not.toHaveBeenCalled();
    expect(h.accepted).toEqual([]);
  });

  it('drop() discards an in-flight result, and a later report is judged on its own', async () => {
    const h = harness();
    h.gate.report('s', 'G:/w/a');
    h.gate.drop('s');
    h.gate.report('s', 'G:/w/b');
    await h.release('G:/w/a', 'dir');
    expect(h.accepted).toEqual([]);
    await h.release('G:/w/b', 'dir');
    expect(h.accepted).toEqual(['G:/w/b']);
  });

  it('sessions are independent', async () => {
    const h = harness();
    h.gate.report('s1', 'G:/w/a');
    h.gate.report('s2', 'G:/w/b');
    await h.release('G:/w/a', 'dir');
    await h.release('G:/w/b', 'dir');
    expect(h.accepted).toEqual(['G:/w/a', 'G:/w/b']);
  });

  // Seam: raw terminal output through the OSC parser into the gate (review r1 SF4).
  describe('parseCwdReports → gate: UNC and device forms never reach stat', () => {
    const osc7 = (url: string) => `\x1b]7;${url}\x07`;
    const osc99 = (p: string) => `\x1b]9;9;${p}\x1b\\`;
    it.each([
      ['OSC 7 file://// (UNC path, empty host)', osc7('file:////h/s')],
      ['OSC 7 percent-encoded backslashes', osc7('file:///%5C%5Ch%5Cs')],
      ['OSC 9;9 \\\\?\\UNC\\h\\s', osc99('\\\\?\\UNC\\h\\s')],
      ['OSC 9;9 \\\\.\\pipe\\x', osc99('\\\\.\\pipe\\x')],
      ['OSC 9;9 bare \\\\h\\s', osc99('\\\\h\\s')],
    ])('%s', async (_name, raw) => {
      const h = harness({ cwd: 'G:/w' });
      const reports = parseCwdReports(raw);
      expect(reports).toHaveLength(1);
      for (const cwd of reports) h.gate.report('s', cwd);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.stat).not.toHaveBeenCalled();
      expect(h.accepted).toEqual([]);
      expect(h.cwd()).toBe('G:/w');
    });
  });
});
