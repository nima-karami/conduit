import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { instanceNames, coreStartEnv, coreStartCwd, ensureHcSocketDirectory } = createRequire(
  import.meta.url,
)('../out/server/instance-names.js');

export function smokeMacHc() {
  assert.equal(process.platform, 'darwin', 'This smoke test needs a Mac');
  const userData = `${homedir()}/Library/Application Support/conduit`;
  const names = instanceNames(userData, process.platform, tmpdir());
  const env = coreStartEnv(process.env, names, true);
  assert.ok(env.HC_SOCKET, 'The standard Mac profile must use a short socket');
  assert.notEqual(env.HC_SESSION, process.env.HC_SESSION, 'Refusing the parent core');
  ensureHcSocketDirectory(names);
  const pins = JSON.parse(
    readFileSync(new URL('../build/runtime-pins.json', import.meta.url), 'utf8'),
  );
  const cwd = coreStartCwd(names.runtimeRoot, pins['darwin-arm64'].hc.version);
  mkdirSync(cwd, { recursive: true });
  const binary = fileURLToPath(new URL('../build/vendor/hc/hc', import.meta.url));
  const run = (args) => execFileSync(binary, args, { env, cwd, encoding: 'utf8', timeout: 20_000 });
  try {
    run(['server', 'start']);
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
    console.log(`PASS: Mac background service and live terminal at ${env.HC_SOCKET}`);
  } finally {
    run(['server', 'stop']);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) smokeMacHc();
