import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
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

const INITIAL_STREAM_CREDIT = 256 * 1024;
const BULK_LINES = 4000;
// Paced so ConPTY renders every line: a burst that scrolls past the viewport between its frames
// would be repainted, not replayed, and the count below would measure ConPTY rather than credit.
const BULK_PROGRAM = String.raw`process.stdout.write('HC-READY\n');process.stdin.once('data',()=>{let n=0;const tick=()=>{let s='';for(let i=0;i<40&&n<${BULK_LINES};i++){n++;const id=String(n).padStart(6,'0');s+='L'+id+':'+id.repeat(13)+'\n'}process.stdout.write(s,()=>{if(n<${BULK_LINES})setTimeout(tick,10);else process.stdout.write('HC-BULK-END\n',()=>setTimeout(()=>process.exit(0),200))})};tick()})`;
const IDLE_PROGRAM = 'setTimeout(()=>{},120000)';

function frame(channel, kind, payload) {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel, 0);
  header[4] = kind;
  header.writeUInt32LE(payload.byteLength, 5);
  return Buffer.concat([header, payload]);
}

/**
 * Observer attach + detach on a raw framed connection, recording whether hc answers the viewer's
 * CLOSE (schema/README.md says it does); the client ends locally either way.
 */
async function measureDetachEcho(endpoint, terminal) {
  const socket = createConnection(endpoint);
  let buffer = Buffer.alloc(0);
  let framed = false;
  const frames = [];
  socket.on('data', (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    if (!framed) {
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      buffer = buffer.subarray(newline + 1);
      framed = true;
    }
    while (buffer.byteLength >= 9 && buffer.byteLength >= 9 + buffer.readUInt32LE(5)) {
      const length = buffer.readUInt32LE(5);
      frames.push({
        channel: buffer.readUInt32LE(0),
        kind: buffer[4],
        payload: buffer.subarray(9, 9 + length),
      });
      buffer = buffer.subarray(9 + length);
    }
  });
  try {
    socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { framed: true, generation: 1 } })}\n`,
    );
    harnessAssert(await until(() => framed, 10000), 'raw hello got no reply');
    const attach = { terminal, cols: 80, rows: 24, observe: true };
    socket.write(
      frame(
        0,
        0,
        Buffer.from(
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'terminal.attach', params: attach }),
        ),
      ),
    );
    let channel;
    harnessAssert(
      await until(() => {
        const reply = frames.find((f) => f.channel === 0);
        if (reply) channel = JSON.parse(reply.payload.toString('utf8')).result?.channel;
        return reply !== undefined;
      }, 10000),
      'raw terminal.attach got no reply',
    );
    harnessAssert(typeof channel === 'number', 'raw terminal.attach returned no channel');
    socket.write(frame(channel, 2, Buffer.alloc(0)));
    const echoed = await until(
      () => frames.some((f) => f.channel === channel && f.kind === 2),
      3000,
    );
    const echo = frames.find((f) => f.channel === channel && f.kind === 2);
    return { echoed, payloadBytes: echo?.payload.byteLength ?? null };
  } finally {
    socket.destroy();
  }
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
    const { NodeHcClient, resolveHcEndpoint } = requireFromHere(bundlePath);

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

    phase('bulk output past the initial credit window');
    const runParams = (argv, labels) => ({
      argv,
      cwd: directory,
      labels,
      name: randomBytes(16).toString('hex'),
      keep: false,
      no_parent: true,
      no_notify: true,
    });
    const bulk = await client.call(
      'terminal.run',
      runParams([process.execPath, '-e', BULK_PROGRAM], {}),
    );
    const bulkStream = (
      await client.attach({ terminal: bulk.address, cols: 200, rows: 120, history: 0 })
    ).stream;
    const bulkChunks = [];
    let bulkBytes = 0;
    let bulkEnd;
    bulkStream.onData((bytes) => {
      bulkChunks.push(Buffer.from(bytes));
      bulkBytes += bytes.byteLength;
      bulkStream.credit(bytes.byteLength);
    });
    bulkStream.onClose((end) => {
      bulkEnd = end;
    });
    const bulkText = () => Buffer.concat(bulkChunks).toString('utf8');
    harnessAssert(
      await until(() => bulkText().includes('HC-READY'), 15000),
      'bulk terminal did not emit HC-READY',
    );
    bulkStream.write(Buffer.from('go\r'));
    harnessAssert(await until(() => bulkEnd !== undefined, 60000), 'bulk terminal never closed');
    // Lines are narrower than the 200-column screen, so ConPTY never splits one with an escape.
    const plain = bulkText();
    const missing = [];
    for (let n = 1; n <= BULK_LINES; n++)
      if (!plain.includes(`L${String(n).padStart(6, '0')}:`)) missing.push(n);
    log(
      `bulk: ${bulkBytes} bytes over credit window ${INITIAL_STREAM_CREDIT}, ${BULK_LINES - missing.length}/${BULK_LINES} lines, end ${JSON.stringify(bulkEnd)}`,
    );
    harnessAssert(bulkBytes > INITIAL_STREAM_CREDIT, `bulk stayed within one window: ${bulkBytes}`);
    harnessAssert(plain.includes('HC-BULK-END'), 'bulk output missing HC-BULK-END');
    harnessAssert(
      missing.length === 0,
      `bulk lines missing: ${missing.length} (first ${missing.slice(0, 5).join(',')})`,
    );
    harnessAssert(bulkEnd?.reason === 'exited', `bulk close: ${JSON.stringify(bulkEnd)}`);
    await client.call('terminal.rm', { terminal: bulk.address });

    phase('events.subscribe with a label filter');
    const tag = randomUUID().slice(0, 8);
    const notifications = [];
    // C3's subscribe hides the snapshot seq; a bare call reads it (its channel is left unread).
    const snapshotSeq = (await client.call('events.subscribe', { labels: { e2e: tag } })).seq;
    const sub = await client.subscribe({ labels: { e2e: tag } }, (n) => notifications.push(n));
    const other = await client.call(
      'terminal.run',
      runParams([process.execPath, '-e', IDLE_PROGRAM], { e2e: `${tag}-other` }),
    );
    const matching = await client.call(
      'terminal.run',
      runParams([process.execPath, '-e', IDLE_PROGRAM], { e2e: tag }),
    );
    const createdFor = (address) =>
      notifications.find(
        (n) => n.method === 'event' && n.params.type === 'created' && n.params.terminal === address,
      );
    harnessAssert(
      await until(() => createdFor(matching.address) !== undefined, 15000),
      `no created event for the matching terminal: ${JSON.stringify(notifications)}`,
    );
    const foreign = notifications.filter(
      (n) => n.method === 'event' && n.params.terminal !== matching.address,
    );
    harnessAssert(foreign.length === 0, `filter leaked events: ${JSON.stringify(foreign)}`);
    harnessAssert(
      !notifications.some((n) => n.method === 'missed'),
      `unexpected missed: ${JSON.stringify(notifications)}`,
    );

    phase('observer detach');
    const echo = await measureDetachEcho(resolveHcEndpoint({ session, env }), matching.address);
    log(
      `measured: detach CLOSE echo=${echo.echoed} (payload ${echo.payloadBytes} bytes); filtered seqs ${JSON.stringify(
        notifications.filter((n) => n.method === 'event').map((n) => [n.params.seq, n.params.type]),
      )} after snapshot seq ${snapshotSeq}`,
    );
    const observer = (
      await client.attach({ terminal: matching.address, cols: 80, rows: 24, observe: true })
    ).stream;
    let observerEnd;
    observer.onClose((end) => {
      observerEnd = end;
    });
    observer.close();
    harnessAssert(
      await until(() => observerEnd !== undefined, 5000),
      'client onClose did not fire on detach',
    );
    harnessAssert(observerEnd.reason === 'detached', `detach end: ${JSON.stringify(observerEnd)}`);

    await client.call('terminal.kill', { terminal: matching.address });
    await client.call('terminal.kill', { terminal: other.address });
    harnessAssert(
      await until(
        () =>
          notifications.some(
            (n) =>
              n.method === 'event' &&
              n.params.type === 'finished' &&
              n.params.terminal === matching.address,
          ),
        15000,
      ),
      'no finished event for the matching terminal',
    );
    sub.close();
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
