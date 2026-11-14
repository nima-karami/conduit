'use strict';
// Claude reads hook stdout as context, so hooks print nothing; nothing here may block Claude, so
// every path exits 0 and every wait is bounded. Wire: src/contracts/hook-protocol.ts.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const HOOK_POST_MAX_BYTES = 256 * 1024;
const STDIN_MS = 2000;
const POST_MS = 1500;
const STATUS_POST_MS = 300;
const USER_STATUS_LINE_MS = 5000;

const envValue = (name) => {
  const v = process.env[name];
  // An unexpanded ${...} placeholder is a config template, never a real token or endpoint.
  return v && !v.startsWith('${') ? v : null;
};

function readStdin(maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let overflow = false;
    const finish = () => {
      clearTimeout(timer);
      resolve({ text: Buffer.concat(chunks).toString('utf8'), overflow });
    };
    const timer = setTimeout(finish, STDIN_MS);
    process.stdin.on('data', (c) => {
      bytes += c.length;
      if (bytes > maxBytes) {
        overflow = true;
        finish();
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function parseObject(text) {
  // Claude always sends JSON; a line that is not still gets the user's status line, just no post.
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function post(endpoint, token, event, payload, ms) {
  const line = JSON.stringify({ conduitHook: 1, token, event, payload });
  if (Buffer.byteLength(line, 'utf8') > HOOK_POST_MAX_BYTES) return Promise.resolve();
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    let got = '';
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    timer = setTimeout(done, ms);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk) => {
      got += chunk;
      if (got.includes('\n')) done();
    });
    socket.on('error', done);
    socket.on('close', done);
  });
}

async function hook(event) {
  const endpoint = envValue('CONDUIT_MCP_ENDPOINT');
  const token = envValue('CONDUIT_SESSION_TOKEN');
  if (!endpoint || !token || !event) return;
  const { text, overflow } = await readStdin(HOOK_POST_MAX_BYTES);
  // Nothing to forward: an oversized or non-JSON payload is dropped, since stderr is not allowed.
  if (overflow) return;
  const payload = parseObject(text);
  if (payload === null) return;
  await post(endpoint, token, event, payload, POST_MS);
}

function statusLineCommand(projectDir, configDir) {
  const files = [
    ...(projectDir
      ? [
          path.join(projectDir, '.claude', 'settings.local.json'),
          path.join(projectDir, '.claude', 'settings.json'),
        ]
      : []),
    path.join(configDir, 'settings.json'),
  ];
  for (const file of files) {
    const command = commandOf(readJson(file));
    if (command) return command;
  }
  return null;
}

// Mirrors readUserStatusLine in src/claude-user-status-line.ts; keep the two in step.
function commandOf(settings) {
  const sl = settings?.statusLine;
  if (sl?.type !== 'command') return null;
  if (typeof sl.command !== 'string' || sl.command === '') return null;
  if (sl.command.includes('conduit-hook.cjs')) return null;
  return sl.command;
}

function readJson(file) {
  try {
    return parseObject(fs.readFileSync(file, 'utf8'));
  } catch {
    // Most layers are absent in practice; an unreadable one must not stop the next from applying.
    return null;
  }
}

function runUserStatusLine(input, text) {
  const projectDir = input?.workspace?.project_dir || input?.cwd || null;
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const command = statusLineCommand(typeof projectDir === 'string' ? projectDir : null, configDir);
  if (!command) return Promise.resolve('');
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      resolve(out);
    };
    timer = setTimeout(() => {
      child.kill();
      done();
    }, USER_STATUS_LINE_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('error', done);
    child.on('close', done);
    // A command that exits before reading its stdin raises EPIPE; its output still counts.
    child.stdin.on('error', () => undefined);
    child.stdin.end(text);
  });
}

async function statusline() {
  const { text } = await readStdin(Infinity);
  const input = parseObject(text);
  const endpoint = envValue('CONDUIT_MCP_ENDPOINT');
  const token = envValue('CONDUIT_SESSION_TOKEN');
  const forwarding =
    endpoint && token && input?.rate_limits && typeof input.rate_limits === 'object'
      ? post(endpoint, token, 'StatusLine', { rate_limits: input.rate_limits }, STATUS_POST_MS)
      : Promise.resolve();
  const [, out] = await Promise.all([forwarding, runUserStatusLine(input, text)]);
  return out;
}

process.stdout.on('error', () => process.exit(0));

async function main() {
  const [mode, event] = process.argv.slice(2);
  if (mode === 'hook') return hook(event);
  if (mode === 'statusline') {
    const out = await statusline();
    return new Promise((resolve) => process.stdout.write(out, resolve));
  }
  return undefined;
}

main().finally(() => process.exit(0));
