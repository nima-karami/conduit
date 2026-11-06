import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function smokeMacHc() {
  // This profile may belong to a live Conduit on a developer's Mac.
  assert.ok(process.env.CI, 'Refusing to smoke-test the real Conduit profile outside CI');
  assert.equal(process.platform, 'darwin', 'This smoke test needs a Mac');
  const { instanceNames, coreStartEnv, coreStartCwd, ensureHcSocketDirectory } = createRequire(
    import.meta.url,
  )('../out/server/instance-names.js');
  const userData = `${homedir()}/Library/Application Support/conduit`;
  const names = instanceNames(userData, process.platform, tmpdir());
  assert.ok(!names.hcEndpointError, names.hcEndpointError);
  const env = coreStartEnv(process.env, names);
  assert.ok(env.HC_SOCKET, 'The standard Mac profile must use a short socket');
  assert.notEqual(env.HC_SESSION, process.env.HC_SESSION, 'Refusing the parent core');
  ensureHcSocketDirectory(names);
  const pins = JSON.parse(
    readFileSync(new URL('../build/runtime-pins.json', import.meta.url), 'utf8'),
  );
  const cwd = coreStartCwd(names.runtimeRoot, pins['darwin-arm64'].hc.version);
  mkdirSync(cwd, { recursive: true });
  const binary = fileURLToPath(new URL('../build/vendor/hc/conduit-hc', import.meta.url));
  const run = (args) => execFileSync(binary, args, { env, cwd, encoding: 'utf8', timeout: 20_000 });
  checkMacCore({ run, socket: env.HC_SOCKET });
}

export function checkMacCore({
  run,
  socket,
  exists = existsSync,
  log = console.log,
  error = console.error,
}) {
  let failed = false;
  let failure;
  try {
    run(['server', 'start']);
    assert.ok(exists(socket), `hc did not create its socket at ${socket}`);
    run([
      'run',
      '--bg',
      '--no-parent',
      '--name',
      'smoke',
      '--',
      '/bin/sh',
      '-c',
      'echo ok; sleep 5',
    ]);
    const listing = JSON.parse(run(['ls', '--json']));
    assert.ok(
      listing.terminals.some((t) => t.name === 'smoke' && t.state === 'live'),
      'smoke terminal is not live',
    );
    log(`PASS: Mac background service and live terminal at ${socket}`);
  } catch (caught) {
    failed = true;
    failure = caught;
  } finally {
    try {
      run(['server', 'stop']);
    } catch (cleanup) {
      if (failed) error('hc smoke cleanup failed:', cleanup);
      else {
        failed = true;
        failure = cleanup;
      }
    }
  }
  if (failed) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) smokeMacHc();
