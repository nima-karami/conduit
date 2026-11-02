import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { until } from './conduit-mcp-helpers.mjs';
import { assert as harnessAssert, phase, REPO, runScenario } from './harness.mjs';

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

runScenario('hc-client', async ({ log }) => {
  const hc = process.env.CONDUIT_HC_BINARY || 'hc';
  const version = await execFile(hc, ['--version'], { windowsHide: true });
  const versionText = `${version.stdout}${version.stderr}`;
  harnessAssert(
    /(?:^|[^\d.])0\.1\.16(?:$|[^\d.])/u.test(versionText),
    `expected hc 0.1.16, got ${versionText.trim()}`,
  );

  phase('private hc setup');
  const directory = await mkdtemp(join(tmpdir(), 'hc-client-e2e-'));
  const session = `conduit-e2e-${randomUUID().slice(0, 8)}`;
  const launchId = randomBytes(16).toString('hex');
  const env = privateHcEnvironment(directory, session);
  const bundlePath = join(directory, 'hc-client.cjs');
  let client;
  let startAttempted = false;
  let primaryError;
  let cleanupErrors = [];

  try {
    const esbuild = requireFromRepo('esbuild');
    await esbuild.build({
      entryPoints: [fileURLToPath(new URL('../../src/hc-client/index.ts', import.meta.url))],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    const { NodeHcClient } = requireFromHere(bundlePath);

    phase('start private hc terminal');
    startAttempted = true;
    await execFile(
      hc,
      [
        'run',
        '--bg',
        '--no-parent',
        '--no-notify',
        '--name',
        launchId,
        '--',
        process.execPath,
        '-e',
        String.raw`process.stdout.write('HC-READY\n');let done=false;const timer=setTimeout(()=>{if(!done){process.stderr.write('HC-TIMEOUT\n');process.exit(2)}},30000);process.stdin.on('data',d=>{if(!done&&d.includes('go')){done=true;clearTimeout(timer);process.stdout.write('HC-RESULT\n',()=>process.exit(0))}})`,
      ],
      { env, windowsHide: true, timeout: 15000 },
    );

    client = new NodeHcClient({ session, env });
    const terminal = await client.call('terminal.get', { terminal: launchId });
    const attached = await client.attach({
      terminal: terminal.address,
      cols: 80,
      rows: 24,
      history: 100,
    });
    let output = '';
    let closeResolve;
    const closed = new Promise((resolve) => {
      closeResolve = resolve;
    });
    attached.stream.onData((bytes) => {
      output += Buffer.from(bytes).toString('utf8');
      attached.stream.credit(bytes.byteLength);
    });
    attached.stream.onClose((end) => closeResolve(end));

    harnessAssert(
      await until(() => output.includes('HC-READY'), 15000),
      'terminal did not emit HC-READY',
    );
    attached.stream.write(Buffer.from('go\r'));
    const timer = setTimeout(
      () => closeResolve(new Error('Timed out waiting for terminal CLOSE')),
      30000,
    );
    const end = await closed;
    clearTimeout(timer);
    harnessAssert(
      !(end instanceof Error),
      end instanceof Error ? end.message : 'terminal did not close',
    );
    harnessAssert(
      end.reason === 'exited' && end.exit_code === 0,
      `unexpected terminal close: ${JSON.stringify(end)}`,
    );
    harnessAssert(output.includes('HC-RESULT'), `terminal output missing HC-RESULT: ${output}`);

    const finalRead = await client.call('terminal.read', {
      terminal: terminal.address,
      lines: 100,
    });
    harnessAssert(
      finalRead.text.includes('HC-RESULT'),
      'terminal.read did not include the final HC-RESULT output',
    );
    await client.call('terminal.rm', { terminal: terminal.address });
    log(`PASS: hc ${versionText.trim()}, terminal ${terminal.address} exited and was removed`);
  } catch (error) {
    primaryError = error;
  }

  const clientCleanup = async () => client?.close();
  const serverCleanup = async () => {
    if (startAttempted)
      await execFile(hc, ['server', 'stop'], { env, windowsHide: true, timeout: 15000 });
  };
  const directoryCleanup = async () => {
    if (!startAttempted || cleanupErrors.length === 0)
      await rm(directory, { recursive: true, force: true });
  };
  cleanupErrors = await settleCleanup([clientCleanup, serverCleanup]);
  if (!cleanupErrors.length) {
    try {
      await directoryCleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError && cleanupErrors.length)
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'hc client smoke and cleanup failed',
    );
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'hc client cleanup failed');
});
