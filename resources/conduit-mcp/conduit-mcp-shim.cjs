'use strict';
// The stdio MCP server every CLI spawns: a line relay to the Conduit server's local endpoint,
// speaking C6 (src/contracts/shim-protocol.ts, generation 2). All MCP handling lives in the host;
// this answers by itself only while no server answers. It outlives server restarts, so it reconnects
// and resumes the client's one handshake instead of falling back for good.
// Dependency-free, so it runs from the write-once runtime/shim/ dir on any Node (D2b).
//
// Usage: <node> conduit-mcp-shim.cjs [--endpoint <pipe-or-socket-path>] (or CONDUIT_MCP_ENDPOINT)
const net = require('node:net');

// C6's frozen values: a dependency-free script can't import the contract, so
// test/unit/conduit-mcp-shim.test.ts checks this line against it.
const C6 = JSON.parse(
  '{"generation":2,"reconnect":{"firstMs":250,"maxMs":5000},"welcomeTimeoutMs":3000,"initialConnectDeadlineMs":2000,"connectBufferMaxBytes":1048576,"helloMaxBytes":65536,"fallbackCapabilities":{"tools":{"listChanged":true}},"errors":{"host_unavailable":{"message":"Conduit is restarting; retry shortly","retryable":true},"outcome_unknown":{"message":"Conduit restarted mid-call; it may have completed, check before retrying","retryable":false},"reinitialize_required":{"message":"Conduit lost this session’s handshake; restart the MCP client","retryable":false}},"errorRpcCode":-32000,"build":"0.52.0"}',
);

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const endpointValue = argValue('--endpoint') ?? process.env.CONDUIT_MCP_ENDPOINT;
const endpoint = endpointValue && !endpointValue.startsWith('${') ? endpointValue : undefined;
const tokenValue = process.env.CONDUIT_SESSION_TOKEN;
const token = tokenValue && !tokenValue.startsWith('${') ? tokenValue : null;

// Process lifetime: survives every reconnect.
/** connecting | relaying | reconnecting | fallback | permanent_fallback | exiting */
let mode = endpoint ? 'connecting' : 'permanent_fallback';
/** idle | init-pending | init-done */
let phase = 'idle';
/** The client's initialize: { id, key, params, line }. */
let init = null;
let initializedRead = false;
/** A resume that can't fit a hello: the next host-bound request learns it once. */
let reinitOwed = false;
let stdinBuf = '';
/** Lines read while no connection relays: { line, msg, bytes }. */
let buffer = [];
let bufferBytes = 0;
// Attempt lifetime: dies with its socket.
let attempt = null;
let retryTimer = null;
let initialTimer = null;
let pendingTimer = null;
let backoff = C6.reconnect.firstMs;

const keyOf = (id) => `${typeof id}:${String(id)}`;
const parse = (line) => {
  try {
    const v = JSON.parse(line);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const isRequest = (m) =>
  m !== null &&
  typeof m.method === 'string' &&
  (typeof m.id === 'string' || typeof m.id === 'number');
const isNotification = (m, method) => m !== null && m.method === method && !('id' in m);

const out = (msg) => {
  process.stdout.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
};

/** C6 shimErrorReply: a CallToolResult for tools/call, a JSON-RPC error otherwise. */
function errorReply(id, method, code) {
  const { message, retryable } = C6.errors[code];
  if (method === 'tools/call') {
    const text = JSON.stringify({ error: { code, message, retryable } });
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: C6.errorRpcCode, message, data: { code, retryable } },
  };
}

function answerInitLocally(id, params) {
  const p = params && typeof params === 'object' ? params : {};
  out({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
      capabilities: C6.fallbackCapabilities,
      serverInfo: { name: 'conduit', version: 'fallback' },
    },
  });
  setPhase('init-done');
}

/** The fallback's answers: enough for a client to start, with no tools until the host is back. */
function answerLocally(msg) {
  if (!isRequest(msg)) return;
  if (reinitOwed) {
    reinitOwed = false;
    out(errorReply(msg.id, msg.method, 'reinitialize_required'));
  } else if (msg.method === 'initialize') answerInitLocally(msg.id, msg.params);
  else if (msg.method === 'tools/list') out({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
  else if (msg.method === 'ping') out({ jsonrpc: '2.0', id: msg.id, result: {} });
  else out(errorReply(msg.id, msg.method, 'host_unavailable'));
}

function takeBuffer() {
  const b = buffer;
  buffer = [];
  bufferBytes = 0;
  return b;
}

/**
 * The snapshot rule: a hello carries the phase and `initialized` it was sent with, so a change of
 * either before its welcome abandons that attempt and dials again with the new snapshot. Exactly
 * one initialize response then ever reaches the client.
 */
function resnapshot() {
  if (attempt?.helloSent && !attempt.welcomed) {
    abandon(attempt);
    connect();
  }
}

function setPhase(next) {
  if (phase === next) return;
  phase = next;
  if (next !== 'init-pending') clearTimeout(pendingTimer);
  resnapshot();
}

function helloLine() {
  const resume =
    phase === 'init-done' && init
      ? { initialize: init.params, initialized: initializedRead }
      : null;
  const line = JSON.stringify({ conduit: C6.generation, token, shim: C6.build, resume });
  return Buffer.byteLength(line, 'utf8') > C6.helloMaxBytes ? null : line;
}

function send(a, line, msg) {
  a.socket.write(`${line}\n`);
  if (!isRequest(msg)) return;
  // The pending initialize is tracked by the phase, never failed with outcome_unknown.
  if (init && keyOf(msg.id) === init.key && phase !== 'init-done') setPhase('init-pending');
  else a.outstanding.set(keyOf(msg.id), { id: msg.id, method: msg.method });
}

function enqueue(line, msg) {
  const bytes = Buffer.byteLength(line, 'utf8') + 1;
  if (bufferBytes + bytes > C6.connectBufferMaxBytes) {
    if (isRequest(msg)) {
      if (init && keyOf(msg.id) === init.key && phase !== 'init-done') init = null;
      out(errorReply(msg.id, msg.method, 'host_unavailable'));
    }
    return;
  }
  buffer.push({ line, msg, bytes });
  bufferBytes += bytes;
}

function onClientLine(line) {
  const msg = parse(line);
  const initialized = isNotification(msg, 'notifications/initialized');
  if (initialized && !initializedRead) {
    initializedRead = true;
    // Part of the snapshot: a resume hello already out says initialized:false, and its server
    // would wait for a notification this attempt never relays.
    if (phase === 'init-done') resnapshot();
  }
  if (isNotification(msg, 'notifications/cancelled')) {
    const target = msg.params?.requestId;
    if (typeof target === 'string' || typeof target === 'number') {
      const k = keyOf(target);
      const i = buffer.findIndex((b) => isRequest(b.msg) && keyOf(b.msg.id) === k);
      if (i >= 0) {
        // Never written: dropping both lines is the cancellation.
        bufferBytes -= buffer[i].bytes;
        buffer.splice(i, 1);
        return;
      }
      attempt?.outstanding.delete(k);
    }
  }
  if (isRequest(msg) && msg.method === 'initialize' && phase !== 'init-done') {
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params);
    init = { id: msg.id, key: keyOf(msg.id), params: params ? msg.params : {}, line };
  }
  if (mode === 'relaying') send(attempt, line, msg);
  else if (mode === 'connecting' || mode === 'reconnecting') enqueue(line, msg);
  // Kept for the attempt that promotes: a server told initialized:false waits for this line.
  else if (mode === 'fallback' && initialized) enqueue(line, msg);
  else if (mode === 'fallback' || mode === 'permanent_fallback') answerLocally(msg);
}

function onServerLine(a, line) {
  const msg = parse(line);
  if (msg && !('method' in msg) && (typeof msg.id === 'string' || typeof msg.id === 'number')) {
    const k = keyOf(msg.id);
    if (init && k === init.key && phase === 'init-pending') {
      // Only a successful result is a handshake; an error leaves the client to initialize again.
      if ('result' in msg) setPhase('init-done');
      else {
        init = null;
        setPhase('idle');
      }
    } else a.outstanding.delete(k);
  }
  out(line);
}

function stopTimers() {
  clearTimeout(retryTimer);
  clearTimeout(initialTimer);
  clearTimeout(pendingTimer);
  retryTimer = null;
}

function abandon(a) {
  a.done = true;
  clearTimeout(a.welcomeTimer);
  a.socket.destroy();
  if (attempt === a) attempt = null;
}

function promote(a) {
  a.welcomed = true;
  clearTimeout(a.welcomeTimer);
  clearTimeout(initialTimer);
  clearTimeout(pendingTimer);
  mode = 'relaying';
  backoff = C6.reconnect.firstMs;
  // initialize is idempotent: re-sent with the same id, so its one reply still matches.
  if (phase === 'init-pending' && init) send(a, init.line, parse(init.line));
  for (const b of takeBuffer()) send(a, b.line, b.msg);
}

function permanent(a) {
  if (a) abandon(a);
  mode = 'permanent_fallback';
  stopTimers();
  if (phase === 'init-pending' && init) answerInitLocally(init.id, init.params);
  for (const b of takeBuffer()) answerLocally(b.msg);
}

function dropped(a) {
  mode = 'reconnecting';
  for (const { id, method } of a.outstanding.values())
    out(errorReply(id, method, 'outcome_unknown'));
  // Without a bound a pending initialize would wait for an absent server forever.
  if (phase === 'init-pending') {
    pendingTimer = setTimeout(() => {
      if (mode !== 'relaying' && phase === 'init-pending' && init)
        answerInitLocally(init.id, init.params);
    }, C6.initialConnectDeadlineMs);
  }
}

function fail(a) {
  // A connect error is followed by a close: one attempt schedules exactly one retry.
  if (a.done) return;
  a.done = true;
  clearTimeout(a.welcomeTimer);
  a.socket.destroy();
  if (a !== attempt) return;
  attempt = null;
  if (a.welcomed) dropped(a);
  scheduleRetry();
}

function scheduleRetry() {
  if (retryTimer || !(mode === 'connecting' || mode === 'reconnecting' || mode === 'fallback'))
    return;
  retryTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, C6.reconnect.maxMs);
}

function onWelcome(a, line) {
  const w = parse(line);
  if (!w || w.conduit !== C6.generation || typeof w.ok !== 'boolean') return fail(a);
  if (w.ok) return promote(a);
  if (w.reason === 'unknown_token' || w.reason === 'unsupported_generation') return permanent(a);
  // `draining`, or a reason this build doesn't know: the server is there, try again.
  fail(a);
}

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (!(mode === 'connecting' || mode === 'reconnecting' || mode === 'fallback')) return;
  if (helloLine() === null) {
    // The resume can't be sent, so no handshake can be restored: no hello at all.
    reinitOwed = true;
    return permanent(null);
  }
  const a = {
    socket: net.connect(endpoint),
    helloSent: false,
    welcomed: false,
    done: false,
    outstanding: new Map(),
    rbuf: '',
    welcomeTimer: null,
  };
  attempt = a;
  a.socket.setEncoding('utf8');
  a.socket.on('connect', () => {
    if (a !== attempt || a.done) return;
    const hello = helloLine();
    if (hello === null) {
      reinitOwed = true;
      return permanent(a);
    }
    a.socket.write(`${hello}\n`);
    a.helloSent = true;
    a.welcomeTimer = setTimeout(() => fail(a), C6.welcomeTimeoutMs);
  });
  a.socket.on('data', (chunk) => {
    if (a !== attempt || a.done) return;
    a.rbuf += chunk;
    let i = a.rbuf.indexOf('\n');
    while (i >= 0 && a === attempt && !a.done) {
      const line = a.rbuf.slice(0, i).replace(/\r$/, '');
      a.rbuf = a.rbuf.slice(i + 1);
      if (a.welcomed) onServerLine(a, line);
      else onWelcome(a, line);
      i = a.rbuf.indexOf('\n');
    }
  });
  a.socket.on('error', () => {});
  a.socket.on('close', () => fail(a));
}

function exit() {
  mode = 'exiting';
  stopTimers();
  if (attempt) {
    attempt.done = true;
    attempt.socket.end();
  }
  // Let pending stdout writes flush before the process goes.
  process.stdout.write('', () => process.exit(0));
}

process.stdout.on('error', () => process.exit(0));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let i = stdinBuf.indexOf('\n');
  while (i >= 0) {
    const line = stdinBuf.slice(0, i).replace(/\r$/, '');
    stdinBuf = stdinBuf.slice(i + 1);
    if (line.trim() !== '' && mode !== 'exiting') onClientLine(line);
    i = stdinBuf.indexOf('\n');
  }
});
process.stdin.on('end', exit);

if (endpoint) {
  initialTimer = setTimeout(() => {
    if (mode !== 'connecting') return;
    mode = 'fallback';
    for (const b of takeBuffer()) {
      if (!isRequest(b.msg)) continue;
      if (b.msg.method === 'initialize' && phase !== 'init-done')
        answerInitLocally(b.msg.id, b.msg.params);
      else out(errorReply(b.msg.id, b.msg.method, 'host_unavailable'));
    }
  }, C6.initialConnectDeadlineMs);
  connect();
}
