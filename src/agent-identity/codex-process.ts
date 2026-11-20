import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentIdentityLaunch, ConversationScope } from '../contracts/agent-identity';
import { type CodexEvents, type CodexPeer, CodexRpc } from './codex-rpc';
import { CODEX_PTY_WRAPPER } from './codex-wrapper';

const STARTUP_MS = 8_000;
const RENDEZVOUS_MS = 20_000;

export interface CodexServer {
  command?: string;
  tuiArgs: readonly string[];
  env?: NodeJS.ProcessEnv;
  connect(events: CodexEvents): Promise<CodexPeer>;
  release?(): Promise<void>;
  onExit?(listener: () => void): void;
  close(): void;
}

function stop(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 2_000);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

async function connect(url: string, events: CodexEvents): Promise<CodexPeer> {
  const ws = new WebSocket(url);
  const rpc = new CodexRpc({ send: (line) => ws.send(line), close: () => ws.close() }, events);
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') rpc.receive(event.data);
  });
  await new Promise<void>((resolve, reject) => {
    const rejectOpen = () => {
      clearTimeout(timer);
      reject(new Error('Could not connect to Codex App Server'));
    };
    const timer = setTimeout(rejectOpen, STARTUP_MS);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener('error', rejectOpen, { once: true });
    ws.addEventListener('close', rejectOpen, { once: true });
  }).catch((error: unknown) => {
    ws.close();
    throw error;
  });
  ws.addEventListener('close', () => rpc.close(), { once: true });
  try {
    await rpc.initialize();
    return rpc;
  } catch (error) {
    rpc.close();
    throw error;
  }
}

async function bridge(target: () => Duplex, token?: string) {
  const path = `/${randomBytes(32).toString('hex')}`;
  const sockets = new Set<Duplex>();
  const server = createServer((_, response) => {
    response.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== path || req.method !== 'GET' || req.headers.origin !== undefined) {
      socket.destroy();
      return;
    }
    const upstream = target();
    sockets.add(socket);
    sockets.add(upstream);
    const end = () => {
      sockets.delete(socket);
      sockets.delete(upstream);
      socket.destroy();
      upstream.destroy();
    };
    socket.once('close', end);
    upstream.once('close', end);
    socket.once('error', end);
    upstream.once('error', end);
    const headers = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version'].map(
      (name) => `${name}: ${req.headers[name] ?? ''}`,
    );
    if (token) headers.push(`authorization: Bearer ${token}`);
    upstream.write(`GET / HTTP/1.1\r\nhost: localhost\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Codex RPC bridge has no TCP address');
  }
  return {
    url: `ws://127.0.0.1:${address.port}${path}`,
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

export const defaultCodexRendezvousDir = () =>
  join(tmpdir(), `conduit-codex-rendezvous-${process.getuid?.() ?? 'local'}`);

function layout(launch: AgentIdentityLaunch, rendezvousDir: string) {
  const id = launch.ids.launchId;
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid Codex launch ID');
  const dir = resolve(rendezvousDir);
  const manifest = join(dir, `${id}.json`);
  const hash = createHash('sha256').update(manifest).digest('hex').slice(0, 24);
  const local = join(dir, id);
  const socketDir =
    Buffer.byteLength(join(local, 'rpc.sock')) < 96
      ? local
      : join(tmpdir(), `conduit-codex-${hash}`);
  return { dir, manifest, socketDir };
}

async function privateDirectory(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (
    !info.isDirectory() ||
    (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
  ) {
    throw new Error('Codex rendezvous directory must be private');
  }
}

async function endpointAt(manifest: string, socketDir: string, signal: AbortSignal) {
  const until = Date.now() + RENDEZVOUS_MS;
  while (Date.now() < until) {
    signal.throwIfAborted();
    try {
      const info = await lstat(manifest);
      if (
        !info.isFile() ||
        (process.platform !== 'win32' &&
          (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
      ) {
        throw new Error('Codex rendezvous file must be private');
      }
      const row: { endpoint?: unknown; auth?: unknown } = JSON.parse(
        await readFile(manifest, 'utf8'),
      );
      if (process.platform !== 'win32' && row.endpoint === `unix://${join(socketDir, 'rpc.sock')}`)
        return { target: () => createConnection(join(socketDir, 'rpc.sock')) };
      if (
        process.platform === 'win32' &&
        typeof row.endpoint === 'string' &&
        typeof row.auth === 'string' &&
        /^[a-f0-9]{64}$/.test(row.auth)
      ) {
        const port = /^ws:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(row.endpoint)?.[1];
        if (port && Number(port) > 0 && Number(port) <= 65535)
          return {
            target: () => createConnection({ host: '127.0.0.1', port: Number(port) }),
            auth: row.auth,
          };
      }
      throw new Error('Invalid Codex rendezvous endpoint');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await delay(50, undefined, { signal });
    }
  }
  throw new Error('Codex PTY rendezvous timed out');
}

export async function startCodexServer(
  launch: AgentIdentityLaunch,
  config: readonly string[],
  tui: readonly string[],
  rendezvousDir: string,
  adopting = false,
): Promise<CodexServer> {
  launch.signal.throwIfAborted();
  const { dir, manifest, socketDir } = layout(launch, rendezvousDir);
  await privateDirectory(dir);
  const abort = new AbortController();
  let relay: Awaited<ReturnType<typeof bridge>> | undefined;
  const close = () => {
    abort.abort();
    relay?.close();
    relay = undefined;
    launch.signal.removeEventListener('abort', close);
  };
  launch.signal.addEventListener('abort', close, { once: true });
  if (launch.signal.aborted) close();
  return {
    command: process.execPath,
    tuiArgs: [
      '-e',
      CODEX_PTY_WRAPPER,
      '--',
      launch.command,
      JSON.stringify(config),
      JSON.stringify(tui),
      manifest,
      socketDir,
    ],
    env: { CODEX_HOME: launch.scope.storageHome, ELECTRON_RUN_AS_NODE: '1' },
    async connect(events) {
      if (!relay) {
        const endpoint = await endpointAt(manifest, socketDir, abort.signal);
        const owned = await bridge(endpoint.target, endpoint.auth);
        if (abort.signal.aborted) {
          owned.close();
          abort.signal.throwIfAborted();
        }
        relay = owned;
      }
      return connect(relay.url, events);
    },
    release: adopting
      ? undefined
      : async () => {
          await writeFile(`${manifest}.ready`, '', { mode: 0o600, flag: 'wx' });
        },
    close,
  };
}

export async function readSavedCodexThread(scope: ConversationScope, id: string, command: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: scope.storageHome,
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, ['app-server', '--stdio'], {
    env,
    cwd: scope.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const rpc = new CodexRpc(
    { send: (line) => child.stdin.write(`${line}\n`), close: () => stop(child) },
    { notify: () => undefined, disconnected: () => undefined },
  );
  child.on('error', () => rpc.close());
  child.stdin.on('error', () => rpc.close());
  child.once('close', () => rpc.close());
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => rpc.receive(line));
  try {
    await rpc.initialize();
    return await rpc.request('thread/read', { threadId: id, includeTurns: false });
  } finally {
    lines.close();
    rpc.close();
  }
}
