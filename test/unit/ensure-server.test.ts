import { describe, expect, it } from 'vitest';
import {
  bounded,
  type EnsureDeps,
  type EnsureHello,
  ensureServerArgs,
  runEnsureServer,
  SCOPE_PREFIX,
} from '../../server/lifecycle/ensure-server';
import { supervisorArgs } from '../../server/lifecycle/hc-supervisor';

const HELLO_WAIT_MS = 30_000;

/**
 * A fake machine: one hc core, one supervisor terminal, one server. startSupervisor brings the
 * server up (pid `spawn`) unless the supervisor is already live. A restart takes the server and
 * the supervisor down; the supervisor may take a few polls to exit. The options break one step at
 * a time, so each failure path has a world that reaches it.
 */
function world(o: {
  running?: EnsureHello | null;
  supervisorAlive?: boolean;
  spawn?: EnsureHello | null;
  restartExitPolls?: number;
  startCoreError?: string;
  startCoreHangs?: boolean;
  startSupervisorFails?: string;
  /** server.restart is refused with this error reply; nothing exits. */
  restartError?: string;
  /** server.restart is accepted but the server keeps answering. */
  restartIgnored?: boolean;
  /** The supervisor never exits. */
  supervisorStuck?: boolean;
  supervisorLiveThrows?: string;
  /** Once the old supervisor is seen gone, an older app relaunches its own server first. */
  relaunchOnExit?: EnsureHello;
}) {
  let now = 0;
  let running: EnsureHello | null = o.running ?? null;
  let supervisorAlive = o.supervisorAlive ?? false;
  let exitingPolls = 0;
  let relaunch = o.relaunchOnExit;
  const trace: string[] = [];
  const prefixes: (readonly string[])[] = [];
  const deps: EnsureDeps = {
    collectGarbage: async () => {
      trace.push('gc');
    },
    startCore: async (prefix) => {
      trace.push('startCore');
      prefixes.push(prefix);
      if (o.startCoreHangs) return new Promise<void>(() => undefined);
      if (o.startCoreError) throw new Error(o.startCoreError);
    },
    startSupervisor: async () => {
      trace.push('startSupervisor');
      if (supervisorAlive) return { ok: false, reason: 'name_taken: already named' };
      if (o.startSupervisorFails) return { ok: false, reason: o.startSupervisorFails };
      supervisorAlive = true;
      running = o.spawn ?? null;
      return { ok: true };
    },
    supervisorLive: async () => {
      if (o.supervisorLiveThrows) throw new Error(o.supervisorLiveThrows);
      if (o.supervisorStuck) {
        trace.push('supervisorLive:live');
        return true;
      }
      if (exitingPolls > 0) {
        exitingPolls -= 1;
        if (exitingPolls === 0) supervisorAlive = false;
        trace.push('supervisorLive:live');
        return true;
      }
      if (!supervisorAlive && relaunch) {
        // The old supervisor is seen gone; the older app brings its own server up before ensure's next call.
        supervisorAlive = true;
        running = relaunch;
        relaunch = undefined;
        trace.push('supervisorLive:gone');
        return false;
      }
      trace.push(supervisorAlive ? 'supervisorLive:live' : 'supervisorLive:gone');
      return supervisorAlive;
    },
    hello: async () => {
      trace.push('hello');
      return running;
    },
    restart: async () => {
      trace.push('restart');
      if (o.restartError) return o.restartError;
      if (o.restartIgnored) return null;
      running = null;
      exitingPolls = o.restartExitPolls ?? 0;
      if (exitingPolls === 0) supervisorAlive = false;
      return null;
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
  return { deps, trace, prefixes, clock: () => now };
}

function run(
  method: 'scope' | 'plain' | 'windows-task',
  w: ReturnType<typeof world>,
  opts: { version?: string; survivesLogout?: boolean; deadlineMs?: number } = {},
) {
  let out = '';
  const stdout = {
    write: (chunk: string) => {
      out += chunk;
      return true;
    },
  };
  return runEnsureServer(
    {
      method,
      survivesLogout: opts.survivesLogout ?? true,
      version: opts.version ?? '1.0.0',
      stdout,
      ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
    },
    w.deps,
  ).then((code) => ({ code, out, trace: w.trace }));
}

const hello = (serverVersion: string, pid: number): EnsureHello => ({
  serverVersion,
  generation: 1,
  pid,
  instance: 'abc',
});

const resultLine = (out: string) => {
  const lines = out.split('\n').filter((l) => l.length > 0);
  expect(lines).toHaveLength(1);
  expect(lines[0].startsWith('CONDUIT_RESULT ')).toBe(true);
  return JSON.parse(lines[0].slice('CONDUIT_RESULT '.length)) as Record<string, unknown>;
};

describe('runEnsureServer', () => {
  it('starts the core and supervisor, then reports up with exit 0', async () => {
    const w = world({ spawn: hello('1.0.0', 10) });
    const r = await run('plain', w);
    expect(r.code).toBe(0);
    expect(resultLine(r.out)).toEqual({
      ok: true,
      state: 'up',
      version: '1.0.0',
      survivesLogout: true,
    });
    expect(r.trace).toEqual(['gc', 'startCore', 'startSupervisor', 'hello']);
  });

  it('plain passes no prefix to the core start', async () => {
    const w = world({ spawn: hello('1.0.0', 10) });
    await run('plain', w);
    expect(w.prefixes).toEqual([[]]);
  });

  it('scope passes the systemd-run prefix as argv', async () => {
    const w = world({ spawn: hello('1.0.0', 10) });
    const r = await run('scope', w, { survivesLogout: true });
    expect(w.prefixes).toEqual([['systemd-run', '--user', '--scope', '--quiet', '--']]);
    expect(SCOPE_PREFIX).toEqual(['systemd-run', '--user', '--scope', '--quiet', '--']);
    expect(resultLine(r.out)).toMatchObject({ ok: true, survivesLogout: true });
  });

  it('a supervisor name_taken means one is live: carry on and report up', async () => {
    const w = world({ running: hello('1.0.0', 5), supervisorAlive: true });
    const r = await run('plain', w);
    expect(r.code).toBe(0);
    expect(resultLine(r.out)).toMatchObject({ ok: true, state: 'up', version: '1.0.0' });
    expect(r.trace).not.toContain('restart');
  });

  it('gives step start when no hello answers within 30 s', async () => {
    const w = world({ spawn: null });
    const r = await run('plain', w);
    expect(r.code).toBe(3);
    const result = resultLine(r.out);
    expect(result).toMatchObject({ ok: false, step: 'start' });
    expect(typeof result.detail).toBe('string');
    expect(w.clock()).toBeGreaterThanOrEqual(HELLO_WAIT_MS);
  });

  it('restarts an older running server, then reports the fresh one up', async () => {
    const w = world({
      running: hello('0.9.0', 5),
      supervisorAlive: true,
      spawn: hello('1.0.0', 6),
    });
    const r = await run('plain', w, { version: '1.0.0' });
    expect(r.code).toBe(0);
    expect(resultLine(r.out)).toMatchObject({ ok: true, state: 'up', version: '1.0.0' });
    expect(r.trace.filter((t) => t === 'restart')).toHaveLength(1);
    expect(r.trace.indexOf('restart')).toBeLessThan(r.trace.lastIndexOf('startSupervisor'));
  });

  it('does not start a supervisor while the old one is still exiting after restart', async () => {
    const w = world({
      running: hello('0.9.0', 5),
      supervisorAlive: true,
      spawn: hello('1.0.0', 6),
      restartExitPolls: 2,
    });
    const r = await run('plain', w, { version: '1.0.0' });
    expect(resultLine(r.out)).toMatchObject({ ok: true, version: '1.0.0' });
    const afterRestart = r.trace.slice(r.trace.indexOf('restart'));
    const started = afterRestart.indexOf('startSupervisor');
    expect(started).toBeGreaterThan(-1);
    expect(afterRestart.slice(0, started)).toContain('supervisorLive:live');
    expect(afterRestart[afterRestart.indexOf('startCore')]).toBe('startCore');
    expect(afterRestart[afterRestart.indexOf('startCore') - 1]).toBe('supervisorLive:gone');
  });

  it('never downgrades a newer running server: reports its version, no restart', async () => {
    const w = world({ running: hello('1.1.0', 5), supervisorAlive: true });
    const r = await run('plain', w, { version: '1.0.0' });
    expect(r.code).toBe(0);
    expect(resultLine(r.out)).toMatchObject({ ok: true, state: 'up', version: '1.1.0' });
    expect(r.trace).not.toContain('restart');
  });

  it('a same-version running server is up without a restart', async () => {
    const w = world({ running: hello('1.0.0', 5), supervisorAlive: true });
    const r = await run('plain', w, { version: '1.0.0' });
    expect(resultLine(r.out)).toMatchObject({ ok: true, version: '1.0.0' });
    expect(r.trace).not.toContain('restart');
  });

  it('windows-task skips the core and the supervisor and only waits for hello', async () => {
    const w = world({ running: hello('1.0.0', 9) });
    const r = await run('windows-task', w, { survivesLogout: false });
    expect(r.code).toBe(0);
    expect(resultLine(r.out)).toEqual({
      ok: true,
      state: 'up',
      version: '1.0.0',
      survivesLogout: false,
    });
    expect(r.trace).not.toContain('gc');
    expect(r.trace).not.toContain('startCore');
    expect(r.trace).not.toContain('startSupervisor');
  });

  it('windows-task with an older running server fails fast, without a restart', async () => {
    const w = world({ running: hello('0.9.0', 5) });
    const r = await run('windows-task', w, { version: '1.0.0' });
    expect(r.code).toBe(3);
    expect(resultLine(r.out)).toEqual({
      ok: false,
      step: 'start',
      detail: 'windows_upgrade_pending',
    });
    expect(r.trace).not.toContain('restart');
    expect(r.trace).not.toContain('startCore');
  });

  it('windows-task with no server times out at step start', async () => {
    const w = world({ spawn: null });
    const r = await run('windows-task', w);
    expect(r.code).toBe(3);
    expect(resultLine(r.out)).toMatchObject({ ok: false, step: 'start' });
    expect(r.trace).not.toContain('startCore');
  });

  it('a failed core start is step start and never starts a supervisor', async () => {
    const w = world({ spawn: hello('1.0.0', 10), startCoreError: 'hc server start: boom' });
    const r = await run('plain', w);
    expect(r.code).toBe(3);
    expect(resultLine(r.out)).toMatchObject({
      ok: false,
      step: 'start',
      detail: expect.stringContaining('boom'),
    });
    expect(r.trace).not.toContain('startSupervisor');
  });

  it('a supervisor that fails to start (not name_taken) is step start', async () => {
    const w = world({ startSupervisorFails: 'terminal.run: bad argv' });
    const r = await run('plain', w);
    expect(r.code).toBe(3);
    expect(resultLine(r.out)).toMatchObject({
      ok: false,
      step: 'start',
      detail: expect.stringContaining('bad argv'),
    });
  });

  describe('after the older server was asked to restart', () => {
    it('an older app that relaunches its own server first is refused, not reported up', async () => {
      // The old desktop app wins the race: name_taken, and the server it brought up is still 0.9.0.
      const w = world({
        running: hello('0.9.0', 5),
        supervisorAlive: true,
        relaunchOnExit: hello('0.9.0', 7),
      });
      const r = await run('plain', w, { version: '1.0.0' });
      expect(r.code).toBe(3);
      expect(resultLine(r.out)).toEqual({
        ok: false,
        step: 'start',
        detail: 'older_server_relaunched',
      });
    });

    it('a server.restart error reply is the fail detail', async () => {
      const w = world({
        running: hello('0.9.0', 5),
        supervisorAlive: true,
        restartError: 'auth refused',
      });
      const r = await run('plain', w, { version: '1.0.0' });
      expect(r.code).toBe(3);
      expect(resultLine(r.out)).toEqual({ ok: false, step: 'start', detail: 'auth refused' });
      expect(r.trace.slice(r.trace.indexOf('restart'))).not.toContain('startSupervisor');
    });

    it('an old server that never exits fails at once, with no second supervisor', async () => {
      const w = world({
        running: hello('0.9.0', 5),
        supervisorAlive: true,
        restartIgnored: true,
        spawn: hello('1.0.0', 6),
      });
      const r = await run('plain', w, { version: '1.0.0' });
      expect(r.code).toBe(3);
      expect(resultLine(r.out)).toEqual({
        ok: false,
        step: 'start',
        detail: 'the older server did not exit after server.restart',
      });
      expect(r.trace.slice(r.trace.indexOf('restart'))).not.toContain('startSupervisor');
    });

    it('an old supervisor that never exits fails and does not start another', async () => {
      const w = world({
        running: hello('0.9.0', 5),
        supervisorAlive: true,
        supervisorStuck: true,
        spawn: hello('1.0.0', 6),
      });
      const r = await run('plain', w, { version: '1.0.0' });
      expect(r.code).toBe(3);
      expect(resultLine(r.out)).toEqual({
        ok: false,
        step: 'start',
        detail: 'the old supervisor did not exit after server.restart',
      });
      expect(r.trace.slice(r.trace.indexOf('restart'))).not.toContain('startSupervisor');
    });

    it('a fresh hello that still carries the old pid is not a fresh server', async () => {
      const w = world({
        running: hello('0.9.0', 5),
        supervisorAlive: true,
        spawn: hello('1.0.0', 5),
      });
      const r = await run('plain', w, { version: '1.0.0' });
      expect(r.code).toBe(3);
      expect(resultLine(r.out)).toEqual({
        ok: false,
        step: 'start',
        detail: 'no fresh C2 hello after server.restart',
      });
    });
  });

  describe('bounded and unexpected failures', () => {
    it('an unexpected throw still prints exactly one result line and exits 3', async () => {
      const w = world({
        running: hello('0.9.0', 5),
        supervisorAlive: true,
        supervisorLiveThrows: 'boom from hc',
      });
      const r = await run('plain', w, { version: '1.0.0' });
      expect(r.code).toBe(3);
      expect(resultLine(r.out)).toEqual({ ok: false, step: 'start', detail: 'boom from hc' });
    });

    it('a call that never returns is cut off by the run deadline: one line, exit 3', async () => {
      const w = world({ startCoreHangs: true, spawn: hello('1.0.0', 10) });
      const r = await run('plain', w, { deadlineMs: 20 });
      expect(r.code).toBe(3);
      expect(resultLine(r.out)).toEqual({ ok: false, step: 'start', detail: 'timeout' });
    });

    it('bounded() rejects a call that never resolves, so a supervisor lookup cannot hang', async () => {
      await expect(
        bounded(new Promise<never>(() => undefined), 10, 'supervisor lookup'),
      ).rejects.toThrow('supervisor lookup timed out');
      await expect(bounded(Promise.resolve(7), 10, 'x')).resolves.toBe(7);
    });
  });
});

describe('ensureServerArgs', () => {
  it('forwards --shim-dir to the server through the supervisor argv', () => {
    const serverArgs = ensureServerArgs({ shimDir: '/s/shim' });
    expect(serverArgs).toEqual(['--shim-dir', '/s/shim']);
    const argv = supervisorArgs('/rt/hc', {
      superviseJs: '/rt/server/supervise.js',
      userData: '/u',
      serverArgs,
    });
    expect(argv.slice(-2)).toEqual(['--shim-dir', '/s/shim']);
  });

  it('is empty without a shim dir, as the app passes nothing it did not build', () => {
    expect(ensureServerArgs({})).toEqual([]);
  });
});
