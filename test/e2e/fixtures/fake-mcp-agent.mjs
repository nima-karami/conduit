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
//   FAKE-MCP CALL {"seq":n,"tool":"…","id":n}       a `call` was sent, before its result is awaited
//   FAKE-MCP RESULT {"seq":n,"tool":"…","result":…} for `call <tool> <json>`
//   FAKE-MCP CANCEL {"seq":n,"id":n}                `cancel`: notifications/cancelled for the last call
//   FAKE-MCP PROMPT-ENTER {"seq":n}                 Enter while the permission prompt is up
//   FAKE-MCP ARGV {"seq":n,"argv":[…]}              once at startup: the launch args, so a scenario sees what the host appended
//   FAKE-MCP LIST_CHANGED {"seq":n}                 a notifications/tools/list_changed arrived; then it re-lists:
//   FAKE-MCP TOOLS {"seq":n,"tools":[…]}            the re-listed tool names, as a real CLI refreshes its tool set
//
// Screen: the prompt `fake❯ ` sits on the cursor row and typed keys are echoed after it, so a
// notice's echo is visible there. `permit` draws `Allow tool?` / `❯ 1. Yes` / `2. No` at the
// cursor, then 10 blank lines, then `Esc to cancel` — S0's cursor-far-from-footer layout — until
// `1`, `2` or Esc. `busy <ms>` prints a line every 100 ms. Idle prints nothing at all.
// `busyq <ms>` is `busy` with the prompt kept on the cursor row under the `working n` lines, as an
// agent that accepts input mid-turn draws its empty box. A line submitted meanwhile is recorded as
// `INPUT {"queued":true}`; a `[conduit]` one is still read, as the agent reads its queue.
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

function rpc(method, params, onSent) {
  if (!server) return Promise.resolve({ error: { message: 'no conduit server configured' } });
  nextId += 1;
  const id = nextId;
  onSent?.(id);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}
const notify = (method) => server?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);

/** The id of the last `call`, which `cancel` names. */
let lastCallId = null;

/** A tool result's payload: the structured JSON of its first text block. */
async function callTool(name, args, onSent) {
  const r = await rpc('tools/call', { name, arguments: args }, onSent);
  if (r.error) return { rpcError: r.error };
  if (r.result?.structuredContent !== undefined) return r.result.structuredContent;
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
      if (msg.method === 'notifications/tools/list_changed' && msg.id === undefined) {
        record('LIST_CHANGED');
        void rpc('tools/list', {}).then((list) => {
          record('TOOLS', { tools: (list.result?.tools ?? []).map((t) => t.name) });
          // The records scroll the prompt away; an idle CLI redraws it, or the notice gate never
          // sees an empty input (a server swap re-lists the tools while the agent sits idle).
          redrawIfIdle();
        });
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
let busyQueue = false;

// A function, not an inline check: the stdout handler's own `line` shadows the typed line.
function redrawIfIdle() {
  if (busyUntil === 0 && !permit && line === '') write(PROMPT);
}

/** The prompt on the cursor row, with whatever is typed so far: the row a queue-mode agent shows. */
function redrawBusyPrompt() {
  write(`\r${ESC}[2K${PROMPT}${line}`);
}

function startBusy(ms, queue = false) {
  busyUntil = Date.now() + ms;
  busyQueue = queue;
  let n = 0;
  const t = setInterval(() => {
    n += 1;
    if (queue) {
      write(`\r${ESC}[2Kworking ${n}\r\n`);
      redrawBusyPrompt();
    } else {
      write(`working ${n}\r\n`);
    }
    if (Date.now() >= busyUntil) {
      clearInterval(t);
      busyUntil = 0;
      busyQueue = false;
      if (queue) redrawBusyPrompt();
      else write(PROMPT);
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
  const queued = busyUntil > 0 && busyQueue;
  record('INPUT', queued ? { line: got, queued: true } : { line: got });
  if (got === 'quit') {
    server?.kill();
    process.exit(0);
  }
  if (queued) {
    if (got.startsWith('[conduit]')) {
      record('INBOX', { result: await callTool('read_inbox', {}) });
    }
    redrawBusyPrompt();
    return;
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
    const tool = call[1];
    const result = await callTool(tool, args, (id) => {
      lastCallId = id;
      record('CALL', { tool, id });
    });
    record('RESULT', { tool, result });
    prompt();
    return;
  }
  if (got === 'cancel') {
    if (lastCallId !== null) {
      const params = { requestId: lastCallId, reason: 'e2e' };
      server?.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params })}\n`,
      );
      record('CANCEL', { id: lastCallId });
    }
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
  const busyq = /^busyq (\d+)$/.exec(got);
  if (busyq) {
    write('\r\n');
    startBusy(Number(busyq[1]), true);
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
    const hadDraft = line !== '';
    line = '';
    if (busyUntil > 0 && busyQueue && hadDraft) {
      redrawBusyPrompt();
    } else {
      write('^C');
      prompt();
    }
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
