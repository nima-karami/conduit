// A fake agent CLI as the user would install it (docs/plans/2026-10-27-conduit-mcp-install.plan.md
// T5.1): unlike fake-mcp-agent.mjs it gets no --mcp-config from Conduit. It reads the `conduit`
// entry Install wrote into the Claude user config — `$CLAUDE_CONFIG_DIR/.claude.json` when that is
// set, else `<home>/.claude.json` — and expands `${VAR}` / `${VAR:-}` in its env from its own env,
// as Claude does, so the identity a Conduit terminal hands down crosses the real shim and endpoint.
//
//   node fake-agent-cli.mjs --records <dir> --name <label> [--as claude]
//
// `--as claude` sends clientInfo `claude-code` and draws Claude's bare `❯ ` input row, so a session
// that typed `claude` (a claude.cmd on PATH that runs this) is bound to Claude's notice adapter
// (spec §2.4, amendment A1). Without it: clientInfo `conduit-e2e-fake` and a `fake❯ ` row.
//
// Records go to <dir>/<label>.jsonl as JSON lines {kind, pid, …}; never the token:
//   READY {tools}       after initialize + tools/list
//   INPUT {line}        every submitted line
//   INBOX {bodies}      after a line holding `[conduit]`: the bodies read_inbox returned
//   NO_ENTRY            no `conduit` entry in the config: exits 3
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ESC = String.fromCharCode(27);
const CSI_SEQ = new RegExp(`^${ESC}\\[[0-9;?<>]*[ -/]*[@-~]`);
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const asClaude = argAfter('--as') === 'claude';
const PROMPT = asClaude ? '❯ ' : 'fake❯ ';
const CLIENT = asClaude ? 'claude-code' : 'conduit-e2e-fake';
const recordsDir = argAfter('--records');
const label = argAfter('--name') ?? `cli-${process.pid}`;
if (recordsDir) mkdirSync(recordsDir, { recursive: true });

const write = (s) => process.stdout.write(s);
const record = (kind, payload = {}) => {
  if (!recordsDir) return;
  appendFileSync(
    join(recordsDir, `${label}.jsonl`),
    `${JSON.stringify({ kind, pid: process.pid, ...payload })}\n`,
  );
};
const prompt = () => write(`\r\n${PROMPT}`);

const configDir = process.env.CLAUDE_CONFIG_DIR || homedir();
const configFile = join(configDir, '.claude.json');
const entry = existsSync(configFile)
  ? JSON.parse(readFileSync(configFile, 'utf8')).mcpServers?.conduit
  : undefined;
if (!entry) {
  record('NO_ENTRY', { configFile });
  process.exit(3);
}

const expand = (value) =>
  String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g, (_, name, dflt) => {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
    return dflt ? dflt.slice(2) : '';
  });
const env = { ...process.env };
for (const [k, v] of Object.entries(entry.env ?? {})) env[k] = expand(v);

const server = spawn(entry.command, entry.args ?? [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
server.stdout.setEncoding('utf8');
let nextId = 0;
const waiting = new Map();
let rx = '';
server.stdout.on('data', (d) => {
  rx += d;
  for (let i = rx.indexOf('\n'); i >= 0; i = rx.indexOf('\n')) {
    const line = rx.slice(0, i);
    rx = rx.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const w = waiting.get(msg.id);
    if (w) {
      waiting.delete(msg.id);
      w(msg);
    }
  }
});
function rpc(method, params) {
  nextId += 1;
  const id = nextId;
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function readInbox() {
  const r = await rpc('tools/call', { name: 'read_inbox', arguments: {} });
  const text = r.result?.content?.find((c) => c.type === 'text')?.text;
  try {
    return (JSON.parse(text ?? '{}').messages ?? []).map((m) => m.body);
  } catch {
    return [];
  }
}

let line = '';
async function submit() {
  const got = line;
  line = '';
  record('INPUT', { line: got });
  if (got === 'quit') {
    server.kill();
    process.exit(0);
  }
  if (got.includes('[conduit]')) record('INBOX', { bodies: await readInbox() });
  prompt();
}

// Same key handling as fake-mcp-agent.mjs: echo after the prompt, so a notice's echo is on the row.
let pending = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  let s = pending + chunk;
  pending = '';
  while (s.length > 0) {
    if (s[0] === ESC) {
      const m = CSI_SEQ.exec(s);
      if (m) s = s.slice(m[0].length);
      else if (s.length > 1 && s[1] === '[') {
        pending = s;
        s = '';
      } else s = s.slice(1);
      continue;
    }
    const ch = s[0];
    s = s.slice(1);
    if (ch === '\r') void submit();
    else if (ch === '\x7f' || ch === '\b') {
      if (line.length > 0) {
        line = line.slice(0, -1);
        write('\b \b');
      }
    } else if (ch === '\x03') {
      line = '';
      prompt();
    } else if (ch !== '\n') {
      line += ch;
      write(ch);
    }
  }
});

await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: CLIENT, version: '1' },
});
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const list = await rpc('tools/list', {});
record('READY', { tools: (list.result?.tools ?? []).map((t) => t.name) });
write(`\r\n${PROMPT}`);
setInterval(() => {}, 1 << 30);
