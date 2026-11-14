import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STATUS_LINE_CASES } from '../helpers/claude-status-line-cases';
import { onLines } from '../helpers/line-socket';
import { tempRoots } from '../helpers/temp-roots';
import { testEndpoint } from '../helpers/test-endpoint';

const HOOK = path.join(__dirname, '..', '..', 'resources', 'conduit-mcp', 'conduit-hook.cjs');
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'claude-hooks');
const fixtureText = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
const TOKEN = 'tok_hook_test';
const ACK = '{"conduitHook":1,"ok":true}';
const STARTUP = fixtureText('statusline-startup.json');
const RATE_LIMITS = fixtureText('statusline-rate-limits.json');
const NODE = process.execPath;
const printing = (text: string) => `"${NODE}" -e "process.stdout.write('${text}')"`;
const ECHO = `"${NODE}" -e "process.stdin.pipe(process.stdout)"`;

interface HookModule {
  statusLineOutput(
    text: string,
    platform: string,
    env: Record<string, string | undefined>,
  ): Promise<string>;
  statusLineShell(
    platform: string,
    env: Record<string, string | undefined>,
    command: string,
  ): { file: string; args: string[] };
}
const hookModule = createRequire(__filename)(HOOK) as HookModule;

const onDisk = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : JSON.stringify(v, (key, value: unknown) =>
        key === 'command' && typeof value === 'string' && value !== '' ? printing(value) : value,
      );

const roots = tempRoots('conduit-hook-');
const peers: Peer[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) await p.close();
  roots.cleanup();
});

interface Peer {
  path: string;
  lines: string[];
  readonly connections: number;
  close(): Promise<void>;
}

async function peer(mode: 'ack' | 'silent'): Promise<Peer> {
  const sockets: net.Socket[] = [];
  const lines: string[] = [];
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.push(socket);
    socket.on('error', () => undefined);
    onLines(socket, (line) => {
      lines.push(line);
      if (mode === 'ack') socket.write(`${ACK}\n`);
    });
  });
  const endpoint = testEndpoint();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });
  const self: Peer = {
    path: endpoint,
    lines,
    get connections() {
      return connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  peers.push(self);
  return self;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(args: string[], env: Record<string, string>, stdin: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child: ChildProcessWithoutNullStreams = spawn(NODE, [HOOK, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    const guard = setTimeout(() => child.kill(), 10_000);
    child.on('error', (err) => {
      clearTimeout(guard);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

function envFor(opts: {
  config: string;
  endpoint?: string;
  token?: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    CLAUDE_CONFIG_DIR: opts.config,
    ...opts.extra,
  };
  if (opts.endpoint !== undefined) env.CONDUIT_MCP_ENDPOINT = opts.endpoint;
  if (opts.token !== undefined) env.CONDUIT_SESSION_TOKEN = opts.token;
  return env;
}

function userSettings(config: string, command: string): void {
  fs.writeFileSync(
    path.join(config, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command } }),
  );
}

describe('conduit-hook.cjs hook <Event>', () => {
  it('posts one HookPost line to the endpoint and exits 0', async () => {
    const p = await peer('ack');
    const config = roots.root();
    const payload = fixtureText('stop-failure-rate-limit.json');
    const r = await run(
      ['hook', 'StopFailure'],
      envFor({ config, endpoint: p.path, token: TOKEN }),
      payload,
    );
    expect(r.code).toBe(0);
    expect(p.lines.map((l) => JSON.parse(l))).toEqual([
      { conduitHook: 1, token: TOKEN, event: 'StopFailure', payload: JSON.parse(payload) },
    ]);
  });

  it('prints nothing to stdout or stderr, even when the server acks', async () => {
    const p = await peer('ack');
    const r = await run(
      ['hook', 'Stop'],
      envFor({ config: roots.root(), endpoint: p.path, token: TOKEN }),
      fixtureText('stop.json'),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('with no token it exits 0 without connecting', async () => {
    const p = await peer('ack');
    const r = await run(
      ['hook', 'Stop'],
      envFor({ config: roots.root(), endpoint: p.path }),
      fixtureText('stop.json'),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(p.connections).toBe(0);
  });

  it('with no endpoint it exits 0 without posting', async () => {
    const r = await run(
      ['hook', 'Stop'],
      envFor({ config: roots.root(), token: TOKEN }),
      fixtureText('stop.json'),
    );
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
  });

  it('an unreachable endpoint exits 0 within 2 s', async () => {
    const root = roots.root();
    const r = await run(
      ['hook', 'StopFailure'],
      envFor({ config: root, endpoint: path.join(root, 'missing.sock'), token: TOKEN }),
      fixtureText('stop-failure-rate-limit.json'),
    );
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2000);
    expect(r.stdout + r.stderr).toBe('');
  });

  it('a server that never acks is abandoned within the post budget, exiting 0', async () => {
    const p = await peer('silent');
    const r = await run(
      ['hook', 'Stop'],
      envFor({ config: roots.root(), endpoint: p.path, token: TOKEN }),
      fixtureText('stop.json'),
    );
    expect(r.code).toBe(0);
    expect(p.lines).toHaveLength(1);
    expect(r.ms).toBeLessThan(3000);
  });

  it('stdin over the contract limit is not posted', async () => {
    const p = await peer('ack');
    const r = await run(
      ['hook', 'Notification'],
      envFor({ config: roots.root(), endpoint: p.path, token: TOKEN }),
      JSON.stringify({ message: 'x'.repeat(300_000) }),
    );
    expect(r.code).toBe(0);
    expect(p.lines).toEqual([]);
  });

  it('stdin over the read cap is not posted, even when its JSON is small', async () => {
    const p = await peer('ack');
    const r = await run(
      ['hook', 'Stop'],
      envFor({ config: roots.root(), endpoint: p.path, token: TOKEN }),
      `${JSON.stringify({ stop_hook_active: false })}${' '.repeat(300_000)}`,
    );
    expect(r.code).toBe(0);
    expect(p.lines).toEqual([]);
  });

  it('stdin that is not JSON is not posted', async () => {
    const p = await peer('ack');
    const r = await run(
      ['hook', 'Stop'],
      envFor({ config: roots.root(), endpoint: p.path, token: TOKEN }),
      'not json',
    );
    expect(r.code).toBe(0);
    expect(p.lines).toEqual([]);
  });
});

describe('conduit-hook.cjs statusline', () => {
  it('prints the user command output unchanged, given the same stdin', async () => {
    const config = roots.root();
    userSettings(config, ECHO);
    const r = await run(['statusline'], envFor({ config }), STARTUP);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(STARTUP);
    expect(r.stderr).toBe('');
  });

  it('the user status line never inherits ELECTRON_RUN_AS_NODE from the hook command', async () => {
    const config = roots.root();
    userSettings(
      config,
      `"${NODE}" -e "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE || 'unset')"`,
    );
    const r = await run(
      ['statusline'],
      envFor({ config, extra: { ELECTRON_RUN_AS_NODE: '1' } }),
      STARTUP,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('unset');
  });

  it('prints nothing when the user has no status line', async () => {
    const r = await run(['statusline'], envFor({ config: roots.root() }), STARTUP);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('resolves the project settings before the user config, from workspace.project_dir', async () => {
    const config = roots.root();
    const project = roots.root();
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: printing('PROJECT') } }),
    );
    userSettings(config, printing('USER'));
    const stdin = JSON.stringify({ ...JSON.parse(STARTUP), workspace: { project_dir: project } });
    const r = await run(['statusline'], envFor({ config }), stdin);
    expect(r.stdout).toBe('PROJECT');
  });

  it('ignores a user command that names conduit-hook.cjs', async () => {
    const config = roots.root();
    userSettings(config, `${printing('SHOULD NOT RUN')} conduit-hook.cjs`);
    const r = await run(['statusline'], envFor({ config }), STARTUP);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('exits 0 and prints nothing when the user command fails', async () => {
    const config = roots.root();
    userSettings(config, `"${NODE}" -e "process.exit(3)"`);
    const r = await run(['statusline'], envFor({ config }), STARTUP);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('forwards rate_limits to the endpoint and still prints the user output', async () => {
    const p = await peer('ack');
    const config = roots.root();
    userSettings(config, printing('USER'));
    const r = await run(
      ['statusline'],
      envFor({ config, endpoint: p.path, token: TOKEN }),
      RATE_LIMITS,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('USER');
    expect(p.lines.map((l) => JSON.parse(l))).toEqual([
      {
        conduitHook: 1,
        token: TOKEN,
        event: 'StatusLine',
        payload: { rate_limits: JSON.parse(RATE_LIMITS).rate_limits },
      },
    ]);
  });

  it('posts nothing when the stdin has no rate_limits', async () => {
    const p = await peer('ack');
    const r = await run(
      ['statusline'],
      envFor({ config: roots.root(), endpoint: p.path, token: TOKEN }),
      STARTUP,
    );
    expect(r.code).toBe(0);
    expect(p.lines).toEqual([]);
  });

  it('prints the user output within 1 s when the server is unreachable', async () => {
    const config = roots.root();
    userSettings(config, ECHO);
    const r = await run(
      ['statusline'],
      envFor({ config, endpoint: path.join(config, 'missing.sock'), token: TOKEN }),
      RATE_LIMITS,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(RATE_LIMITS);
    expect(r.ms).toBeLessThan(1000);
  });
});

describe('conduit-hook.cjs statusLineShell', () => {
  const CMD = 'echo a | tr a b';

  it('win32 runs the status line in Git Bash from CLAUDE_CODE_GIT_BASH_PATH when it is set', () => {
    expect(
      hookModule.statusLineShell(
        'win32',
        { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' },
        CMD,
      ),
    ).toEqual({ file: 'C:\\Git\\bin\\bash.exe', args: ['-c', CMD] });
  });

  it('win32 without it resolves bash from PATH, never cmd.exe', () => {
    expect(hookModule.statusLineShell('win32', {}, CMD)).toEqual({
      file: 'bash',
      args: ['-c', CMD],
    });
  });

  it('other platforms run /bin/sh, whatever the Git Bash variable says', () => {
    const env = { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' };
    expect(hookModule.statusLineShell('linux', env, CMD)).toEqual({
      file: '/bin/sh',
      args: ['-c', CMD],
    });
    expect(hookModule.statusLineShell('darwin', {}, CMD)).toEqual({
      file: '/bin/sh',
      args: ['-c', CMD],
    });
  });
});

describe('conduit-hook.cjs statusline budgets and precedence', () => {
  it('a server that accepts but never acks does not hold up the user output', async () => {
    const p = await peer('silent');
    const config = roots.root();
    userSettings(config, ECHO);
    const r = await run(
      ['statusline'],
      envFor({ config, endpoint: p.path, token: TOKEN }),
      RATE_LIMITS,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(RATE_LIMITS);
    expect(p.lines).toHaveLength(1);
    expect(r.ms).toBeLessThan(1000);
  }, 15_000);

  it.each(STATUS_LINE_CASES)('$name', async (c) => {
    const config = roots.root();
    const project = roots.root();
    fs.mkdirSync(path.join(project, '.claude'));
    if (c.files.local !== undefined)
      fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), onDisk(c.files.local));
    if (c.files.shared !== undefined)
      fs.writeFileSync(path.join(project, '.claude', 'settings.json'), onDisk(c.files.shared));
    if (c.files.user !== undefined)
      fs.writeFileSync(path.join(config, 'settings.json'), onDisk(c.files.user));
    const stdin = JSON.stringify({ ...JSON.parse(STARTUP), workspace: { project_dir: project } });
    const r = await run(['statusline'], envFor({ config }), stdin);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(c.expect ?? '');
  });
});

describe('conduit-hook.cjs statusLineOutput on win32', () => {
  it('runs the user command as `bash -c <command>` in CLAUDE_CODE_GIT_BASH_PATH and prints its stdout', async () => {
    const dir = roots.root();
    const record = path.join(dir, 'argv.txt');
    const bash = path.join(dir, 'bash-stub');
    fs.writeFileSync(
      bash,
      `#!/bin/sh\nprintf '%s\\n' "$1" "$2" > '${record}'\nprintf 'STUB:%s' "$2"\n`,
    );
    fs.chmodSync(bash, 0o755);
    const config = roots.root();
    const command = `echo 'it works' "quoted"`;
    userSettings(config, command);
    const out = await hookModule.statusLineOutput(STARTUP, 'win32', {
      PATH: process.env.PATH ?? '',
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_GIT_BASH_PATH: bash,
    });
    expect(out).toBe(`STUB:${command}`);
    expect(fs.readFileSync(record, 'utf8')).toBe(`-c\n${command}\n`);
  });
});
