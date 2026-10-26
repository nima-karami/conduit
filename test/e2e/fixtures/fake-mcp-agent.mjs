// A fake MCP-capable agent CLI for the conduit-mcp scenarios (docs/plans/2026-10-25-conduit-mcp-server.plan.md
// T9.4): the remote runner has no logged-in claude or codex. Launched as
// `node fake-mcp-agent.mjs --records <dir> --mcp-config <file>`, it spawns the REAL shim from the config's
// `mcpServers.conduit` entry (env merged over its own, as claude does), so the token, the endpoint
// and every tool call cross the same path a real CLI's would.
//
// Every record is appended as one JSON line ({kind, pid, seq, …}) to `<--records dir>/<id>.jsonl`,
// where <id> is the --mcp-config file's name (the session id), and the scenarios read that file.
// The terminal stream is no transport: ConPTY re-emits a wrapped row's last cell on the next row,
// so a record wider than the terminal came back with a character doubled (a 17-char thread id
// that still parsed). The records are also printed, for screenshots, ending in " <<END>>":
//   FAKE-MCP READY {"seq":n,"tools":[…]}
//   FAKE-MCP INPUT {"seq":n,"line":"…"}            every submitted line
//   FAKE-MCP INBOX {"seq":n,"result":…}             after a `[conduit] …` line, its read_inbox
//   FAKE-MCP RESULT {"seq":n,"tool":"…","result":…} for `call <tool> <json>`
//   FAKE-MCP PROMPT-ENTER {"seq":n}                 Enter while the permission prompt is up
//   FAKE-MCP ARGV {"seq":n,"argv":[…]}              once at startup: the launch args, so a scenario sees what the host appended
//
// Screen: the prompt `fake❯ ` sits on the cursor row and typed keys are echoed after it, so a
// notice's echo is visible there. `permit` draws `Allow tool?` / `❯ 1. Yes` / `2. No` at the
// cursor, then 10 blank lines, then `Esc to cancel` — S0's cursor-far-from-footer layout — until
// `1`, `2` or Esc. `busy <ms>` prints a line every 100 ms. Idle prints nothing at all.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const ESC = '\x1b';
const CSI_SEQ = new RegExp(`^${ESC}\\[[0-9;?<>]*[ -/]*[@-~]`);
const PROMPT = 'fake❯ ';
const write = (s) => process.stdout.write(s);
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const recordsDir = argAfter('--records');
const mcpConfig = argAfter('--mcp-config');
const recordsName = mcpConfig ? basename(mcpConfig, '.json') : `unwired-${process.pid}`;
const recordsFile = recordsDir ? join(recordsDir, `${recordsName}.jsonl`) : undefined;
if (recordsDir) mkdirSync(recordsDir, { recursive: true });

let seq = 0;
const record = (kind, payload) => {
  seq += 1;
  const body = payload === undefined ? { seq } : { seq, ...payload };
  if (recordsFile) {
    appendFileSync(recordsFile, `${JSON.stringify({ kind, pid: process.pid, ...body })}\n`);
  }
  write(`\r\nFAKE-MCP ${kind} ${JSON.stringify(body)} <<END>>\r\n`);
};
const prompt = () => write(`\r\n${PROMPT}`);

record('ARGV', { argv: process.argv.slice(2) });

// ── MCP client over the shim ────────────────────────────────────────────────

const entry = mcpConfig
  ? JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers?.conduit
  : undefined;

let server = null;
let nextId = 0;
const waiting = new Map();
let rx = '';

function rpc(method, params) {
  if (!server) return Promise.resolve({ error: { message: 'no conduit server configured' } });
  nextId += 1;
  const id = nextId;
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}
const notify = (method) => server?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);

/** A tool result's payload: the structured JSON of its first text block. */
async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) return { rpcError: r.error };
  const text = r.result?.content?.find((c) => c.type === 'text')?.text;
  try {
    return text === undefined ? r.result : JSON.parse(text);
  } catch {
    return { text };
  }
}

async function connect() {
  if (!entry) {
    record('READY', { tools: [] });
    write(PROMPT);
    return;
  }
  server = spawn(entry.command, entry.args ?? [], {
    env: { ...process.env, ...(entry.env ?? {}) },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (d) => {
    rx += d;
    let i = rx.indexOf('\n');
    while (i >= 0) {
      const line = rx.slice(0, i);
      rx = rx.slice(i + 1);
      i = rx.indexOf('\n');
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
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-mcp-agent', version: '1' },
  });
  notify('notifications/initialized');
  const list = await rpc('tools/list', {});
  record('READY', { tools: (list.result?.tools ?? []).map((t) => t.name) });
  write(PROMPT);
}

// ── the CLI ─────────────────────────────────────────────────────────────────

let line = '';
let permit = false;
let busyUntil = 0;

function startBusy(ms) {
  busyUntil = Date.now() + ms;
  let n = 0;
  const t = setInterval(() => {
    n += 1;
    write(`working ${n}\r\n`);
    if (Date.now() >= busyUntil) {
      clearInterval(t);
      busyUntil = 0;
      write(PROMPT);
    }
  }, 100);
}

function closePermit() {
  permit = false;
  // Clear the dialog and its footer, so the old prompt can't keep matching as blocking.
  write(`${ESC}[2J${ESC}[H${PROMPT}`);
}

async function submit() {
  const got = line;
  line = '';
  record('INPUT', { line: got });
  if (got === 'quit') {
    server?.kill();
    process.exit(0);
  }
  if (got.startsWith('[conduit]')) {
    record('INBOX', { result: await callTool('read_inbox', {}) });
    prompt();
    return;
  }
  const call = /^call (\S+)(?: (.*))?$/.exec(got);
  if (call) {
    let args = {};
    try {
      args = call[2] ? JSON.parse(call[2]) : {};
    } catch (e) {
      record('RESULT', { tool: call[1], result: { parseError: String(e) } });
      prompt();
      return;
    }
    record('RESULT', { tool: call[1], result: await callTool(call[1], args) });
    prompt();
    return;
  }
  if (got === 'permit') {
    permit = true;
    write(`\r\nAllow tool?\r\n❯ 1. Yes\r\n  2. No${'\r\n'.repeat(10)}Esc to cancel`);
    // The cursor goes back up to the menu, far from the footer.
    write(`${ESC}[11A\r`);
    return;
  }
  const busy = /^busy (\d+)$/.exec(got);
  if (busy) {
    write('\r\n');
    startBusy(Number(busy[1]));
    return;
  }
  prompt();
}

function key(ch) {
  if (permit) {
    if (ch === '\r') record('PROMPT-ENTER');
    else if (ch === '1' || ch === '2') closePermit();
    return;
  }
  if (ch === '\r') {
    void submit();
  } else if (ch === '\x7f' || ch === '\b') {
    if (line.length > 0) {
      line = line.slice(0, -1);
      write('\b \b');
    }
  } else if (ch === '\x03') {
    line = '';
    write('^C');
    prompt();
  } else if (ch !== '\n') {
    line += ch;
    write(ch);
  }
}

let pending = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  let s = pending + chunk;
  pending = '';
  while (s.length > 0) {
    if (s[0] === ESC) {
      const m = CSI_SEQ.exec(s);
      if (m) {
        // Terminal replies and cursor keys: never part of the line.
        s = s.slice(m[0].length);
      } else if (s.length > 1 && s[1] === '[') {
        pending = s;
        s = '';
      } else {
        if (permit) closePermit();
        s = s.slice(1);
      }
      continue;
    }
    const ch = s[0];
    s = s.slice(1);
    key(ch);
  }
});

await connect();
// Exits only on a typed `quit` or a kill (restart / dispose / quit).
setInterval(() => {}, 1 << 30);
