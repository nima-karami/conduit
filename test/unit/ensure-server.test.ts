import { describe, expect, it } from 'vitest';
import {
  type EnsureDeps,
  type EnsureHello,
  runEnsureServer,
  SCOPE_PREFIX,
} from '../../server/lifecycle/ensure-server';

const HELLO_WAIT_MS = 30_000;

/**
 * A fake machine: one hc core, one supervisor terminal, one server. startSupervisor brings the
 * server up (pid `spawnPid`) unless the supervisor is already live. A restart takes the server
 * and the supervisor down; the supervisor may take a few polls to exit.
 */
function world(o: {
  running?: EnsureHello | null;
  supervisorAlive?: boolean;
  spawn?: EnsureHello | null;
  restartExitPolls?: number;
  startCoreError?: string;
  startSupervisorFails?: string;
}) {
  let now = 0;
  let running: EnsureHello | null = o.running ?? null;
  let supervisorAlive = o.supervisorAlive ?? false;
  let exitingPolls = 0;
  const trace: string[] = [];
  const prefixes: (readonly string[])[] = [];
  const deps: EnsureDeps = {
    collectGarbage: async () => {
      trace.push('gc');
    },
    startCore: async (prefix) => {
      trace.push('startCore');
      prefixes.push(prefix);
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
      if (exitingPolls > 0) {
        exitingPolls -= 1;
        if (exitingPolls === 0) supervisorAlive = false;
        trace.push('supervisorLive:live');
        return true;
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
      running = null;
      exitingPolls = o.restartExitPolls ?? 0;
      if (exitingPolls === 0) supervisorAlive = false;
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
  opts: { version?: string; survivesLogout?: boolean } = {},
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
});
