import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, REPO, resolveHcBinary } from './harness.mjs';
import { assertOwnSession } from './harness-server-teardown.mjs';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const log = makeLog('hc-binary-rename');

async function run() {
  const source = resolveHcBinary();
  const version = await execFile(source, ['--version'], { windowsHide: true });
  assert(version.stdout.includes('0.1.16'), `expected pinned hc 0.1.16: ${version.stdout}`);
  const root = await mkdtemp(join(tmpdir(), 'runtime-rename-'));
  const extension = process.platform === 'win32' ? '.exe' : '';
  let client;
  let coreStarted = false;
  let engine;
  let env;
  try {
    const bundle = join(root, 'runtime.cjs');
    await require('esbuild').build({
      stdin: {
        contents: [
          "export { prepareRuntime } from './server/runtime-dir/prepare';",
          "export { instanceNames, coreStartEnv, coreStartCwd, ensureHcSocketDirectory } from './src/instance-names';",
          "export { NodeHcClient } from './src/hc-client';",
        ].join('\n'),
        resolveDir: REPO,
        loader: 'ts',
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
    });
    const {
      prepareRuntime,
      instanceNames,
      coreStartEnv,
      coreStartCwd,
      ensureHcSocketDirectory,
      NodeHcClient,
    } = require(bundle);
    const userData = join(root, 'profile');
    const names = instanceNames(userData, process.platform, tmpdir());
    assertOwnSession(names.hcSession, process.env.HC_SESSION);
    env = coreStartEnv(process.env, names);
    ensureHcSocketDirectory(names);
    const legacyDir = join(userData, 'runtime', 'hc', '0.1.16');
    const legacy = join(legacyDir, `hc${extension}`);
    const resourcesDir = join(root, 'resources');
    const bundledHc = join(resourcesDir, 'runtime', 'hc');
    for (const dir of [
      legacyDir,
      bundledHc,
      join(resourcesDir, 'runtime', 'server'),
      join(resourcesDir, 'conduit-mcp'),
    ])
      await mkdir(dir, { recursive: true });
    await copyFile(source, legacy);
    if (existsSync(join(dirname(source), 'conpty')))
      await cp(join(dirname(source), 'conpty'), join(legacyDir, 'conpty'), { recursive: true });
    await cp(legacyDir, bundledHc, { recursive: true });
    await rename(join(bundledHc, `hc${extension}`), join(bundledHc, `conduit-hc${extension}`));
    await writeFile(join(resourcesDir, 'runtime', `node${extension}`), 'unused node fixture');
    await writeFile(
      join(resourcesDir, 'conduit-mcp', 'conduit-mcp-shim.cjs'),
      'unused shim fixture',
    );
    const invoke = (file, args, cwd = coreStartCwd(names.runtimeRoot, '0.1.16')) =>
      execFile(file, args, { env, cwd, windowsHide: true, timeout: 20_000 });
    engine = legacy;
    coreStarted = true;
    await invoke(legacy, ['server', 'start'], legacyDir);
    client = new NodeHcClient({ session: names.hcSession, env });
    const before = await client.call('server.status', {});
    const heartbeat = join(root, 'heartbeat');
    const program = `let n=0;setInterval(()=>require('node:fs').writeFileSync(process.argv[1],String(++n)),100)`;
    const pane = await client.call('terminal.run', {
      argv: [process.execPath, '-e', program, heartbeat],
      cwd: root,
      name: 'rename-survivor',
      no_parent: true,
      no_notify: true,
      keep: false,
    });
    assert(await until(() => existsSync(heartbeat), 15_000), 'pane never wrote its heartbeat');
    const first = Number(await readFile(heartbeat, 'utf8'));

    const prepared = await prepareRuntime({
      resourcesDir,
      userData,
      appVersion: '0.55.1',
      hcVersion: '0.1.16',
      shimVersion: 1,
    });
    engine = prepared.hcExe;
    assert(engine !== legacy && existsSync(legacy), 'preparation replaced the legacy runtime');
    const [oldFile, newFile] = await Promise.all([
      stat(legacy, { bigint: true }),
      stat(engine, { bigint: true }),
    ]);
    assert(
      oldFile.dev !== newFile.dev || oldFile.ino !== newFile.ino,
      'engine copies share a file identity',
    );
    await invoke(engine, ['server', 'start']);
    client.close();
    client = new NodeHcClient({ session: names.hcSession, env });
    const after = await client.call('server.status', {});
    assert(after.pid === before.pid, `live core replaced: ${before.pid} -> ${after.pid}`);
    assert(
      (await client.call('terminal.get', { terminal: pane.address })).state === 'live',
      'live pane lost',
    );
    assert(
      await until(async () => Number(await readFile(heartbeat, 'utf8')) > first, 10_000),
      'pane stopped progressing',
    );
    log(
      `legacy core pid ${before.pid} retained; live pane ${pane.address} survived preparation and renamed CLI start`,
    );
    client.close();
    client = undefined;
    await invoke(engine, ['server', 'stop']);
    await invoke(engine, ['server', 'start']);
    client = new NodeHcClient({ session: names.hcSession, env });
    const fresh = await client.call('server.status', {});
    assert(fresh.pid !== before.pid, 'fresh engine did not start');
    const image =
      process.platform === 'win32'
        ? await execFile(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${fresh.pid}").Name`,
            ],
            { windowsHide: true },
          )
        : await execFile('ps', ['-p', String(fresh.pid), '-o', 'comm=']);
    assert(
      image.stdout.trim().endsWith(`conduit-hc${extension}`),
      `unexpected process name: ${image.stdout}`,
    );
    log(
      `fresh core pid ${fresh.pid}, image ${image.stdout.trim()}, same private session ${names.hcSession}`,
    );
  } finally {
    client?.close();
    try {
      if (coreStarted)
        await execFile(engine, ['server', 'stop'], { env, windowsHide: true, timeout: 20_000 });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

let code = 0;
try {
  await run();
  log('PASS');
} catch (error) {
  code = 1;
  log('FAIL', error.stack ?? String(error));
}
await finishScenario(code);
