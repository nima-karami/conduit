import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { until } from './conduit-mcp-helpers.mjs';
import { assert as harnessAssert, phase, REPO, runScenario } from './harness.mjs';

// W6's walking skeleton on real hc: the runtime, its ring and its screen model over W1's client,
// in a private HC_SESSION with its own XDG dirs, so the user's own hc session is never touched.

const execFile = promisify(execFileCallback);
const requireFromRepo = createRequire(join(REPO, 'package.json'));
const requireFromHere = createRequire(import.meta.url);

function privateHcEnvironment(directory, session) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^HC_/iu.test(key)) delete env[key];
  env.HC_SESSION = session;
  env.XDG_CONFIG_HOME = join(directory, 'config');
  env.XDG_STATE_HOME = join(directory, 'state');
  return env;
}

const ECHO_PROGRAM = String.raw`process.stdout.write('E2E-READY\n');process.stdin.on('data',d=>process.stdout.write('ECHO:'+d.toString().trim()+'\n'))`;
const FAST_PROGRAM = String.raw`process.stdout.write('FAST-OUT\n',()=>{process.exitCode=4})`;

async function settleCleanup(actions) {
  const errors = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

runScenario('server-runtime', async ({ log }) => {
  const hc = process.env.CONDUIT_HC_BINARY || 'hc';
  const version = await execFile(hc, ['--version'], { windowsHide: true });
  const versionText = `${version.stdout}${version.stderr}`;
  harnessAssert(
    /(?:^|[^\d.])0\.1\.16(?:$|[^\d.])/u.test(versionText),
    `expected hc 0.1.16, got ${versionText.trim()}`,
  );

  phase('private hc setup');
  const directory = await mkdtemp(join(tmpdir(), 'server-runtime-e2e-'));
  const session = `conduit-e2e-${randomUUID().slice(0, 8)}`;
  const instance = randomBytes(8).toString('hex');
  const env = privateHcEnvironment(directory, session);
  const hcOptions = { env, windowsHide: true, timeout: 15000, cwd: directory };
  const bundlePath = join(directory, 'server-runtime.cjs');
  let runtime;
  let startAttempted = false;
  let primaryError;
  let cleanupErrors = [];

  try {
    // One bundle, so the runtime's `instanceof HcDisconnectedError` sees the client's class.
    const esbuild = requireFromRepo('esbuild');
    await esbuild.build({
      stdin: {
        contents: [
          "export { createRuntimeServices } from './server/runtime/index.ts';",
          "export { NodeHcClient } from './src/hc-client/index.ts';",
          "export { createTokenStore } from './server/runtime/testing/token-store.ts';",
        ].join('\n'),
        resolveDir: REPO,
        loader: 'ts',
      },
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    const { createRuntimeServices, createTokenStore, NodeHcClient } = requireFromHere(bundlePath);

    startAttempted = true;
    await execFile(hc, ['server', 'start'], hcOptions);
    const client = new NodeHcClient({ session, env, log: (m, e) => log(m, String(e)) });
    // The fast-exit phase holds the attach back, so the program ends before it (C1 SpawnFinished).
    let attachDelayMs = 0;
    const hcPort = {
      call: (method, params) => client.call(method, params),
      attach: async (params) => {
        if (attachDelayMs) await new Promise((resolve) => setTimeout(resolve, attachDelayMs));
        return client.attach(params);
      },
      subscribe: (params, notify) => client.subscribe(params, notify),
      onConnection: (listener) => client.onConnection(listener),
      close: () => client.close(),
    };
    const tokens = createTokenStore({ randomToken: () => 'e2e' });
    const shown = [];
    const services = createRuntimeServices({
      hc: hcPort,
      tokens,
      emit: (type, data) => shown.push({ type, data }),
      instance,
      hcSession: session,
      appVersion: '0.0.0-e2e',
      logPath: join(directory, 'server.log'),
      userData: directory,
      recording: () => true,
      log: (m) => log(m),
    });
    runtime = services.runtime;
    const events = [];
    runtime.on((e) => events.push(e));
    const output = (sessionId) =>
      events
        .filter((e) => (e.type === 'data' || e.type === 'paint') && e.sessionId === sessionId)
        .map((e) => e.data)
        .join('');
    const ringFile = async (sessionId) => {
      services.scrollback.flushPending();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return readFile(join(directory, `scrollback-${sessionId}.json`), 'utf8');
    };
    const labels = (sessionId, ids) => ({
      'conduit.session': sessionId,
      'conduit.instance': instance,
      'conduit.generation': String(ids.generation),
      'conduit.launch': ids.launchId,
      'conduit.role': 'session',
    });
    const health = await runtime.start();
    harnessAssert(health.state === 'ready', `runtime health ${JSON.stringify(health)}`);

    phase('spawn, active attach, input');
    const echoIds = { generation: 1, launchId: randomBytes(16).toString('hex') };
    await tokens.reserve('echo', echoIds);
    runtime.resize('echo', { cols: 90, rows: 25 });
    const spawned = await runtime.spawn(
      'echo',
      { command: process.execPath, args: ['-e', ECHO_PROGRAM], cwd: directory, env: {} },
      labels('echo', echoIds),
      echoIds,
    );
    harnessAssert(spawned.ok && spawned.terminal, `echo spawn: ${JSON.stringify(spawned)}`);
    harnessAssert(tokens.row(echoIds.launchId)?.state === 'live', 'echo row not live');
    services.screens.ensure('echo', { seedTail: false });
    harnessAssert(
      await until(() => output('echo').includes('E2E-READY'), 15000),
      `echo never printed READY: ${JSON.stringify(output('echo'))}`,
    );
    harnessAssert(runtime.input('echo', 1, 'hello\r'), 'input refused on the active attach');
    harnessAssert(
      await until(() => output('echo').includes('ECHO:hello'), 15000),
      `no echo: ${JSON.stringify(output('echo'))}`,
    );
    const snap = await runtime.screen('echo');
    harnessAssert(
      snap?.lines.some((line) => line.includes('ECHO:hello')),
      `screen() missing the echo: ${JSON.stringify(snap)}`,
    );
    harnessAssert((await ringFile('echo')).includes('ECHO:hello'), 'ring file missing the echo');

    phase('resize');
    runtime.resize('echo', { cols: 100, rows: 30 });
    harnessAssert(
      await until(async () => {
        const t = await client.call('terminal.get', { terminal: spawned.terminal.target.terminal });
        return t.cols === 100 && t.rows === 30;
      }, 10000),
      'hc never took the requested size',
    );

    phase('core restart: reconcile re-attaches with resumed');
    await execFile(hc, ['server', 'restart'], hcOptions);
    harnessAssert(
      await until(() => events.some((e) => e.type === 'resynced'), 30000),
      'no resynced after the core restart',
    );
    harnessAssert(
      await until(() => events.some((e) => e.type === 'paint' && e.cause === 'gap'), 15000),
      'no gap paint on the re-attach',
    );
    harnessAssert(
      events.filter((e) => e.type === 'spawned' && e.sessionId === 'echo').length === 1,
      'a re-attach announced a second spawn',
    );
    harnessAssert(runtime.input('echo', 1, 'again\r'), 'input refused after the re-attach');
    harnessAssert(
      await until(() => output('echo').includes('ECHO:again'), 15000),
      'no echo after the re-attach',
    );
    harnessAssert((await ringFile('echo')).includes('output may be missing'), 'no gap marker');

    phase('kill: exit recorded, terminal removed');
    const echoAddress = spawned.terminal.target.terminal;
    await runtime.kill('echo');
    harnessAssert(
      await until(() => events.some((e) => e.type === 'exit' && e.sessionId === 'echo'), 15000),
      'no exit after kill',
    );
    harnessAssert(
      await until(async () => {
        try {
          await client.call('terminal.get', { terminal: echoAddress });
          return false;
        } catch (error) {
          return error?.kind === 'not_found';
        }
      }, 10000),
      'killed terminal was not removed',
    );

    phase('fast exit: finished with its output');
    attachDelayMs = 2000;
    const fastIds = { generation: 1, launchId: randomBytes(16).toString('hex') };
    await tokens.reserve('fast', fastIds);
    const fast = await runtime.spawn(
      'fast',
      { command: process.execPath, args: ['-e', FAST_PROGRAM], cwd: directory, env: {} },
      labels('fast', fastIds),
      fastIds,
    );
    attachDelayMs = 0;
    harnessAssert(
      fast.ok &&
        fast.finished?.exitCode === 4 &&
        fast.finished.reason === 'exited' &&
        fast.finished.output.includes('FAST-OUT'),
      `fast spawn: ${JSON.stringify(fast)}`,
    );
    harnessAssert((await ringFile('fast')).includes('FAST-OUT'), 'fast output not in the ring');
    harnessAssert(
      events.some((e) => e.type === 'exit' && e.sessionId === 'fast' && e.code === 4),
      'fast exit not recorded',
    );
    log(`PASS: hc ${versionText.trim()}; ${events.length} runtime events`);
  } catch (error) {
    primaryError = error;
  }

  const runtimeCleanup = async () => runtime?.close();
  const serverCleanup = async () => {
    if (startAttempted) await execFile(hc, ['server', 'stop'], hcOptions);
  };
  cleanupErrors = await settleCleanup([runtimeCleanup, serverCleanup]);
  if (!cleanupErrors.length) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError && cleanupErrors.length)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'server runtime e2e and cleanup failed',
    );
  if (primaryError) throw primaryError;
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'server runtime cleanup failed');
});
