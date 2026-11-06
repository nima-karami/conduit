import { describe, expect, it } from 'vitest';
import {
  createHelperLauncher,
  type HelperChild,
  type HelperSpawnOptions,
  helperEnv,
  nodeSpawnHelper,
} from '../../server/tray/helper-process';
import type { HelperToSupervisor, TrayView } from '../../src/contracts/tray-protocol';

const flush = () => new Promise<void>((r) => setImmediate(r));

class FakeChild implements HelperChild {
  written: string[] = [];
  ended = false;
  killed = false;
  private out: ((b: Buffer) => void)[] = [];
  private err: ((b: Buffer) => void)[] = [];
  private exit: ((c: number | null) => void)[] = [];
  constructor(readonly pid: number | undefined) {}
  write(line: string) {
    this.written.push(line);
  }
  end() {
    this.ended = true;
  }
  kill() {
    this.killed = true;
  }
  onStdout(cb: (b: Buffer) => void) {
    this.out.push(cb);
  }
  onStderr(cb: (b: Buffer) => void) {
    this.err.push(cb);
  }
  onExit(cb: (c: number | null) => void) {
    this.exit.push(cb);
  }
  stdout(s: string | Buffer) {
    for (const cb of this.out) cb(Buffer.isBuffer(s) ? s : Buffer.from(s));
  }
  stderr(s: string) {
    for (const cb of this.err) cb(Buffer.from(s));
  }
  exits(code: number | null) {
    for (const cb of this.exit) cb(code);
  }
  messages() {
    return this.written.map((l) => JSON.parse(l) as { type: string });
  }
}

const view = (tooltip: string): TrayView => ({
  visible: true,
  icon: 'normal',
  tooltip,
  items: [],
  confirm: { title: 't', body: 'b', confirm: 'c', cancel: 'x' },
  openFailed: { title: 't', body: 'b' },
});

function harness(
  o: { install?: () => Promise<{ exe: string; swapped: boolean; note?: string }> } = {},
) {
  let clock = 1_000_000;
  const timers: { at: number; ms: number; cb: () => void; cancelled: boolean }[] = [];
  const children: FakeChild[] = [];
  const spawns: { exe: string; args: readonly string[]; options: HelperSpawnOptions }[] = [];
  const logs: { level: string; who: string; message: string }[] = [];
  const launcher = createHelperLauncher({
    install:
      o.install ?? (async () => ({ exe: '/u/runtime/tray/conduit-tray.exe', swapped: false })),
    spawn: (exe, args, options) => {
      spawns.push({ exe, args, options });
      const c = new FakeChild(100 + children.length);
      children.push(c);
      return c;
    },
    env: {
      PATH: '/bin',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\T',
      TMP: 'C:\\T',
      USERPROFILE: 'C:\\Users\\a',
      LOCALAPPDATA: 'C:\\Users\\a\\L',
      APPDATA: 'C:\\Users\\a\\R',
      HC_SESSION: 'conduit-abc',
      HC_TERMINAL_ID: 't1',
      CONDUIT_MCP_TOKEN: 'secret',
      CONDUIT_BOOTSTRAP_FILE: '/u/boot',
      XDG_CONFIG_HOME: '/u/hc/config',
    },
    cwd: '/u/runtime/tray',
    log: { write: (level, who, message) => logs.push({ level, who, message }) },
    now: () => clock,
    setTimer: (ms, cb) => {
      const t = { at: clock + ms, ms, cb, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (const t of timers.filter((x) => !x.cancelled && x.at <= clock)) {
      t.cancelled = true;
      t.cb();
    }
    await flush();
  };
  const pendingTimers = () => timers.filter((t) => !t.cancelled).map((t) => t.ms);
  return {
    launcher,
    children,
    spawns,
    logs,
    advance,
    pendingTimers,
    skip: (ms: number) => {
      clock += ms;
    },
  };
}

async function started(h: ReturnType<typeof harness>) {
  const got: HelperToSupervisor[] = [];
  const handle = await h.launcher.start((m) => got.push(m));
  if (!handle) throw new Error('no handle');
  return { handle, got };
}

describe('helperEnv', () => {
  it('passes only the allowlist, matched case-insensitively', () => {
    expect(
      helperEnv({
        SYSTEMROOT: 'C:\\Windows',
        temp: 'C:\\T',
        HC_SESSION: 's',
        CONDUIT_BOOTSTRAP_FILE: 'f',
        CONDUIT_MCP_TOKEN: 't',
        PATH: '/bin',
        APPDATA: undefined,
      }),
    ).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\T' });
  });
});

describe('createHelperLauncher', () => {
  it('spawns with the minimal env, piped stdio, hidden, attached, cwd = stable dir', async () => {
    const h = harness();
    const { handle } = await started(h);
    expect(h.spawns).toHaveLength(1);
    const { exe, args, options } = h.spawns[0];
    expect(exe).toBe('/u/runtime/tray/conduit-tray.exe');
    expect(args).toEqual([]);
    expect(options).toEqual({
      cwd: '/u/runtime/tray',
      env: {
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\T',
        TMP: 'C:\\T',
        USERPROFILE: 'C:\\Users\\a',
        LOCALAPPDATA: 'C:\\Users\\a\\L',
        APPDATA: 'C:\\Users\\a\\R',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    });
    const keys = Object.keys(options.env).join(' ');
    expect(keys).not.toMatch(/HC_|MCP|BOOTSTRAP|XDG|PATH/);
    expect(handle.pid).toBe(100);
  });

  it('frames sends as JSON lines and forwards parsed messages; unknown ones are logged only', async () => {
    const h = harness();
    const { handle, got } = await started(h);
    handle.send({ type: 'init', v: 1, app: null });
    expect(h.children[0].written).toEqual(['{"type":"init","v":1,"app":null}\n']);
    h.children[0].stdout('{"type":"hello","v":1,"helperVersion":"0.53.0","pid":100}\n{"type":"fu');
    h.children[0].stdout('ture"}\n{"type":"shown"}\n');
    expect(got).toEqual([
      { type: 'hello', v: 1, helperVersion: '0.53.0', pid: 100 },
      { type: 'shown' },
    ]);
    expect(h.logs.some((l) => l.level === 'warn' && /future/.test(l.message))).toBe(true);
  });

  it('logs the helper stderr line by line as the helper', async () => {
    const h = harness();
    await started(h);
    h.children[0].stderr('first\nsec');
    h.children[0].stderr('ond\n');
    expect(h.logs.filter((l) => l.who === 'helper').map((l) => l.message)).toEqual([
      'first',
      'second',
    ]);
  });

  it('logs install swaps and notes', async () => {
    const h = harness({
      install: async () => ({ exe: '/x.exe', swapped: true, note: 'kept busy .old' }),
    });
    await started(h);
    const text = h.logs.map((l) => l.message).join('\n');
    expect(text).toMatch(/swap/);
    expect(text).toMatch(/kept busy \.old/);
  });

  it('restarts after 1 s, 5 s, 30 s, replaying init and the last view, then gives up', async () => {
    const h = harness();
    const { handle } = await started(h);
    handle.send({ type: 'init', v: 1, app: null });
    handle.send({ type: 'view', view: view('a') });
    handle.send({ type: 'view', view: view('b') });
    handle.send({ type: 'stopResult', ok: true });

    h.children[0].exits(1);
    expect(h.pendingTimers()).toEqual([1_000]);
    await h.advance(999);
    expect(h.children).toHaveLength(1);
    await h.advance(1);
    expect(h.children).toHaveLength(2);
    expect(h.children[1].messages()).toEqual([
      { type: 'init', v: 1, app: null },
      { type: 'view', view: view('b') },
    ]);
    expect(handle.pid).toBe(101);

    h.children[1].exits(null);
    expect(h.pendingTimers()).toEqual([5_000]);
    await h.advance(5_000);
    h.children[2].exits(3);
    expect(h.pendingTimers()).toEqual([30_000]);
    await h.advance(30_000);
    expect(h.children).toHaveLength(4);

    let final: number | null | 'pending' = 'pending';
    void handle.exited.then((c) => {
      final = c;
    });
    h.children[3].exits(1);
    await flush();
    expect(h.pendingTimers()).toEqual([]);
    expect(final).toBe(1);
    expect(h.logs.some((l) => /give up|gave up/i.test(l.message))).toBe(true);
    await h.advance(60_000);
    expect(h.children).toHaveLength(4);
  });

  it('crashes older than 10 min fall out of the budget', async () => {
    const h = harness();
    await started(h);
    for (let i = 0; i < 6; i++) {
      h.children[i].exits(1);
      expect(h.pendingTimers()).toEqual([1_000]);
      h.skip(600_000);
      await h.advance(1_000);
    }
    expect(h.children).toHaveLength(7);
  });

  it.each([0, 10, 11])('exit %i is never restarted', async (code) => {
    const h = harness();
    const { handle } = await started(h);
    h.children[0].exits(code);
    expect(await handle.exited).toBe(code);
    expect(h.pendingTimers()).toEqual([]);
  });

  it('an oversize stdout line is a protocol error: killed, logged, not restarted', async () => {
    const h = harness();
    const { handle, got } = await started(h);
    h.children[0].stdout(Buffer.alloc(70_000, 0x61));
    expect(h.children[0].killed).toBe(true);
    expect(h.logs.some((l) => l.level === 'error' && /protocol/i.test(l.message))).toBe(true);
    h.children[0].exits(null);
    expect(await handle.exited).toBeNull();
    expect(h.pendingTimers()).toEqual([]);
    expect(got).toEqual([]);
  });

  it('a hello with another protocol version is a protocol error too', async () => {
    const h = harness();
    const { handle } = await started(h);
    h.children[0].stdout('{"type":"hello","v":2,"helperVersion":"9","pid":1}\n');
    expect(h.children[0].killed).toBe(true);
    h.children[0].exits(1);
    await handle.exited;
    expect(h.children).toHaveLength(1);
  });

  it('exit is written, stdin closed, and any later exit code is final', async () => {
    const h = harness();
    const { handle } = await started(h);
    handle.send({ type: 'exit' });
    expect(h.children[0].messages()).toEqual([{ type: 'exit' }]);
    expect(h.children[0].ended).toBe(true);
    h.children[0].exits(1);
    expect(await handle.exited).toBe(1);
    expect(h.pendingTimers()).toEqual([]);
  });

  it('exit during a restart wait cancels the respawn and ends at once', async () => {
    const h = harness();
    const { handle } = await started(h);
    h.children[0].exits(1);
    handle.send({ type: 'view', view: view('while down') });
    handle.send({ type: 'exit' });
    expect(await handle.exited).toBeNull();
    await h.advance(1_000);
    expect(h.children).toHaveLength(1);
  });

  it('a failing first install means no binary: start returns null and logs', async () => {
    const h = harness({
      install: async () => {
        throw new Error('no tray binary at /x');
      },
    });
    expect(await h.launcher.start(() => {})).toBeNull();
    expect(h.spawns).toEqual([]);
    expect(h.logs.some((l) => /no tray binary/.test(l.message))).toBe(true);
  });

  it('a failing install on restart gives up', async () => {
    let calls = 0;
    const h = harness({
      install: async () => {
        calls++;
        if (calls > 1) throw new Error('disk gone');
        return { exe: '/x.exe', swapped: false };
      },
    });
    const { handle } = await started(h);
    h.children[0].exits(1);
    await h.advance(1_000);
    expect(await handle.exited).toBe(1);
    expect(h.logs.some((l) => /disk gone/.test(l.message))).toBe(true);
  });

  it('a throwing onMessage is logged and never breaks the read loop', async () => {
    const h = harness();
    await h.launcher.start((m) => {
      if (m.type === 'shown') throw new Error('relay bug');
    });
    h.children[0].stdout('{"type":"shown"}\n{"type":"hidden"}\n');
    expect(h.logs.some((l) => /relay bug/.test(l.message))).toBe(true);
  });

  it('an unencodable send is logged, not thrown', async () => {
    const h = harness();
    const { handle } = await started(h);
    expect(() => handle.send({ type: 'view', view: view('x'.repeat(70_000)) })).not.toThrow();
    expect(h.logs.some((l) => l.level === 'error')).toBe(true);
  });
});

describe('nodeSpawnHelper (real child process)', () => {
  it('pipes stdin/stdout/stderr and reports the exit code once', async () => {
    const script =
      "process.stdin.on('data',d=>process.stdout.write(d));" +
      "process.stdin.on('end',()=>{process.stderr.write('bye\\n');process.exit(3)});";
    const logs: string[] = [];
    const child = nodeSpawnHelper(
      process.execPath,
      ['-e', script],
      {
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      },
      (m) => logs.push(m),
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.onStdout((b) => out.push(b));
    child.onStderr((b) => err.push(b));
    const codes: (number | null)[] = [];
    const done = new Promise<void>((resolve) =>
      child.onExit((c) => {
        codes.push(c);
        resolve();
      }),
    );
    child.write('{"type":"shown"}\n');
    child.end();
    await done;
    await new Promise((r) => setTimeout(r, 400));
    expect(codes).toEqual([3]);
    expect(Buffer.concat(out).toString()).toBe('{"type":"shown"}\n');
    expect(Buffer.concat(err).toString()).toBe('bye\n');
    expect(typeof child.pid).toBe('number');
  });

  it('a spawn error is an exit with null', async () => {
    const child = nodeSpawnHelper(
      '/definitely/not/here.exe',
      [],
      {
        cwd: process.cwd(),
        env: {},
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      },
      () => {},
    );
    const code = await new Promise<number | null>((resolve) => child.onExit(resolve));
    expect(code).toBeNull();
  });
});
