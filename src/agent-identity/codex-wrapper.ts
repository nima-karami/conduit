// This program runs in the adopted PTY, so its children outlive a Conduit host restart.
export const CODEX_PTY_WRAPPER = String.raw`
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { access, lstat, mkdir, rm, writeFile, rename } = require('node:fs/promises');
const { createConnection } = require('node:net');
const { dirname, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const [command, configJson, tuiJson, manifest, socketDir] = process.argv.slice(1);
const ready = manifest + '.ready';
delete process.env.ELECTRON_RUN_AS_NODE;

let app, tui, ending = false, ownSocket = false, published = false;
const children = new Map();
function child(argv, stdio, env) {
  const proc = spawn(command, argv, { stdio, env, windowsHide: true });
  const closed = new Promise((resolve) => {
    proc.once('error', () => {});
    proc.once('close', (code) => resolve(code ?? 1));
  });
  children.set(proc, closed);
  return proc;
}
let stopping;
function stopChildren() {
  ending = true;
  stopping ??= Promise.all([...children].map(async ([proc, closed]) => {
    if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return;
    proc.kill();
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 2000);
    await closed;
    clearTimeout(timer);
  }));
  return stopping;
}
async function cleanup() {
  await stopChildren();
  if (published) {
    await rm(manifest, { force: true });
    await rm(ready, { force: true });
  }
  if (ownSocket) await rm(socketDir, { recursive: true, force: true });
}
let interrupted = false;
function interrupt() {
  interrupted = true;
  void stopChildren();
}
process.on('SIGHUP', interrupt);
process.on('SIGTERM', interrupt);

async function main() {
  const win = process.platform === 'win32';
  const dir = await lstat(dirname(manifest));
  if (!dir.isDirectory() || (!win && (dir.uid !== process.getuid() || dir.mode & 0o077))) {
    throw new Error('Invalid Codex rendezvous directory');
  }
  const auth = win ? randomBytes(32).toString('hex') : undefined;
  if (!win) {
    await mkdir(socketDir, { mode: 0o700 });
    ownSocket = true;
  }
  if (ending) return;
  const socket = win ? undefined : join(socketDir, 'rpc.sock');
  const bind = win ? 'ws://127.0.0.1:0' : 'unix://' + socket;
  const args = ['app-server', ...JSON.parse(configJson), '--listen', bind];
  if (auth) {
    args.push('--ws-auth', 'capability-token', '--ws-token-sha256',
      createHash('sha256').update(auth).digest('hex'));
  }
  const env = { ...process.env, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' };
  app = child(args, ['ignore', 'ignore', 'pipe'], { ...env, NO_COLOR: '1' });
  let logs = '';
  app.stderr.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-4096); });
  let endpoint;
  const until = Date.now() + 15000;
  while (!ending && Date.now() < until && app.exitCode === null && app.signalCode === null) {
    if (socket) {
      const probe = createConnection(socket);
      const reachable = await new Promise((resolve) => {
        probe.once('connect', () => resolve(true));
        probe.once('error', () => resolve(false));
      });
      probe.destroy();
      if (reachable) { endpoint = bind; break; }
    } else {
      endpoint = /listening on: (ws:\/\/127\.0\.0\.1:\d+)/.exec(logs)?.[1];
      if (endpoint) break;
    }
    await delay(50);
  }
  if (ending) return;
  if (!endpoint) throw new Error('Codex App Server did not become ready');
  const temp = manifest + '.' + process.pid + '.tmp';
  try {
    await writeFile(temp, JSON.stringify({ endpoint, auth }), { flag: 'wx', mode: 0o600 });
    await rename(temp, manifest);
    published = true;
  } finally {
    await rm(temp, { force: true });
  }
  const readyBy = Date.now() + 30000;
  while (!ending && Date.now() < readyBy && app.exitCode === null && app.signalCode === null) {
    const allowed = await access(ready).then(() => true, () => false);
    if (allowed) {
      if (ending) return;
      const remote = ['--remote', endpoint];
      if (auth) {
        remote.push('--remote-auth-token-env', 'CONDUIT_CODEX_REMOTE_TOKEN');
        env.CONDUIT_CODEX_REMOTE_TOKEN = auth;
      }
      const args = JSON.parse(tuiJson);
      args.splice(args[0] === 'resume' ? 1 : 0, 0, ...remote);
      tui = child(args, 'inherit', env);
      return await Promise.race([children.get(tui), children.get(app)]);
    }
    await delay(50);
  }
  if (!ending) throw new Error('Conduit did not initialize Codex identity');
}
main().then((code) => {
  process.exitCode = interrupted ? 1 : (code ?? 0);
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(cleanup).catch(() => {
  process.exitCode = 1;
  console.error('Codex PTY cleanup failed.');
});
`;
