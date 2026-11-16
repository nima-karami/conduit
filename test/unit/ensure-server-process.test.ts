import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { version } from '../../package.json';
import { hcBinaryOf, hcClient, serverChildEnv } from '../../server/hc-cli';
import { HC_PINNED_VERSION } from '../../src/contracts/hc';
import type { InstanceNames } from '../../src/contracts/session-identity';
import { coreStartCwd, instanceNames } from '../../src/instance-names';
import { runtimeBinaryName } from '../../src/runtime-binary';
import { readServerSecret } from '../../src/server-secret';

// A real server and a real hc core: needs the vendored hc and a build (`node esbuild.mjs`).
const repo = join(__dirname, '..', '..');
const vendoredHc =
  process.env.CONDUIT_HC_BINARY ??
  join(repo, 'build', 'vendor', 'hc', runtimeBinaryName('hc', 'linux'));
const mainJs = join(repo, 'out', 'server', 'main.js');
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const enabled = process.platform !== 'win32' && existsSync(vendoredHc);

const run = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile(process.execPath, [mainJs, ...args], { timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolveRun({ code, stdout, stderr });
    });
  });

function resultOf(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((l) => l.startsWith('CONDUIT_RESULT '));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0].slice('CONDUIT_RESULT '.length)) as Record<string, unknown>;
}

/** One hello on its own socket: the server's pid, read from its own answer. */
function helloPid(endpoint: string, secret: string): Promise<number> {
  return new Promise((resolveHello, reject) => {
    const socket = connect(endpoint);
    let buffer = '';
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { appVersion: version, generation: 1, auth: secret } })}\n`,
      ),
    );
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.destroy();
      const reply = JSON.parse(buffer.slice(0, end)) as {
        result?: { pid?: number };
        error?: unknown;
      };
      if (typeof reply.result?.pid === 'number') resolveHello(reply.result.pid);
      else reject(new Error(`hello refused: ${JSON.stringify(reply)}`));
    });
    socket.on('error', reject);
  });
}

describe.skipIf(!enabled)('--ensure-server (real process)', () => {
  // Made in beforeAll: a skipped run never reaches afterAll, so a dir made here would leak.
  let dir = '';
  let names: InstanceNames;
  let env: Record<string, string>;
  let pid: number | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ensure-e2e-'));
    names = instanceNames(dir, 'linux', tmpdir());
    env = serverChildEnv(process.env, names);
  });

  afterAll(async () => {
    // Only the --stop-all path, then the pid this test captured; never a kill by name.
    await run(['--stop-all', '--user-data', dir]);
    if (pid !== undefined) {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone: the stop above did its job.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('is isolated from the user own Conduit', () => {
    const own = instanceNames(
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'conduit'),
      'linux',
      tmpdir(),
    );
    expect(names.instance).not.toBe(own.instance);
    expect(names.supervisorName).not.toBe(own.supervisorName);
  });

  it('brings a fresh userData up, idempotently, with one supervisor, then stops it', async () => {
    const hcDest = hcBinaryOf(undefined, names);
    mkdirSync(coreStartCwd(names.runtimeRoot, HC_PINNED_VERSION), { recursive: true });
    copyFileSync(vendoredHc, hcDest);
    chmodSync(hcDest, 0o755);

    const args = [
      '--ensure-server',
      '--user-data',
      dir,
      '--start',
      'plain',
      '--survives-logout',
      'yes',
    ];
    const first = await run(args);
    expect(first.code, first.stderr).toBe(0);
    expect(resultOf(first.stdout)).toEqual({
      ok: true,
      state: 'up',
      version,
      survivesLogout: true,
    });

    const secret = readServerSecret(dir);
    expect(secret).not.toBeNull();
    pid = await helloPid(names.serverEndpoint, secret ?? '');

    const second = await run(args);
    expect(second.code, second.stderr).toBe(0);
    expect(resultOf(second.stdout)).toMatchObject({ ok: true, state: 'up', version });
    expect(await helloPid(names.serverEndpoint, readServerSecret(dir) ?? '')).toBe(pid);

    const client = hcClient(names, env, () => undefined);
    try {
      const { terminals } = await client.call('terminal.list', {});
      const live = terminals.filter((t) => t.name === names.supervisorName && t.state === 'live');
      expect(live).toHaveLength(1);
    } finally {
      client.close();
    }

    const stop = await run(['--stop-all', '--user-data', dir]);
    expect(stop.code, stop.stderr).toBe(0);
    await expect(helloPid(names.serverEndpoint, readServerSecret(dir) ?? '')).rejects.toThrow();
    // A client never starts a core, so a refused call means the stop took it down. The core
    // closes its socket a moment after `hc server stop` returns, hence the poll.
    const refused = await waitFor(async () => {
      const after = hcClient(names, env, () => undefined);
      try {
        await after.call('terminal.list', {});
        return false;
      } catch {
        return true;
      } finally {
        after.close();
      }
    }, 15_000);
    expect(refused).toBe(true);
  }, 180_000);
});
