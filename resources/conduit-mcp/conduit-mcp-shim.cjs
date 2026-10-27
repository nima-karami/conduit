'use strict';
// The stdio MCP server every CLI spawns: a byte relay to Conduit's local endpoint. All MCP
// handling lives in the host; this answers by itself only when the host can't be reached.
// Dependency-free and run by Conduit's own executable as Node (ELECTRON_RUN_AS_NODE=1), so no
// system Node is needed. See docs/specs/2026-10-25-conduit-mcp-server.md §3.1.
//
// Usage: <node> conduit-mcp-shim.cjs [--endpoint <pipe-or-socket-path>] (or CONDUIT_MCP_ENDPOINT)
const net = require('node:net');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const endpointValue = argValue('--endpoint') ?? process.env.CONDUIT_MCP_ENDPOINT;
const endpoint = endpointValue && !endpointValue.startsWith('${') ? endpointValue : undefined;
const tokenValue = process.env.CONDUIT_SESSION_TOKEN;
const token = tokenValue && !tokenValue.startsWith('${') ? tokenValue : null;

/** 'connecting' buffers stdin; 'relay' pipes bytes; 'fallback' answers requests itself. */
let mode = 'connecting';
let early = [];
let fallbackBuf = '';
let stdinEnded = false;
let socket = null;

const exit = () => {
  // Let pending stdout writes flush before the process goes.
  process.stdout.write('', () => process.exit(0));
};

const reply = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

function answer(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof req !== 'object' || req === null || Array.isArray(req)) return;
  if (req.id === undefined || req.id === null) return;
  const id = req.id;
  const params = req.params && typeof req.params === 'object' ? req.params : {};
  if (req.method === 'initialize') {
    const version =
      typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
    reply({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'conduit', version: 'fallback' },
      },
    });
  } else if (req.method === 'tools/list') {
    reply({ jsonrpc: '2.0', id, result: { tools: [] } });
  } else if (req.method === 'tools/call') {
    const error = {
      code: 'host_unavailable',
      message: 'Conduit is not reachable from this session',
      retryable: true,
    };
    reply({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true },
    });
  } else {
    reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
}

function feedFallback(chunk) {
  fallbackBuf += chunk.toString('utf8');
  let nl = fallbackBuf.indexOf('\n');
  while (nl >= 0) {
    const line = fallbackBuf.slice(0, nl).trim();
    fallbackBuf = fallbackBuf.slice(nl + 1);
    if (line) answer(line);
    nl = fallbackBuf.indexOf('\n');
  }
}

function toFallback() {
  if (mode === 'fallback') return;
  const unsent = mode === 'connecting' ? early : [];
  mode = 'fallback';
  early = [];
  for (const chunk of unsent) feedFallback(chunk);
  if (stdinEnded) exit();
}

process.stdin.on('data', (chunk) => {
  if (mode === 'relay') socket.write(chunk);
  else if (mode === 'connecting') early.push(chunk);
  else feedFallback(chunk);
});

process.stdin.on('end', () => {
  stdinEnded = true;
  // Relay: the host ends its side in turn, and 'close' (via toFallback) exits. Connecting: the
  // connect outcome decides the same way.
  if (mode === 'relay') socket.end();
  else if (mode === 'fallback') exit();
});

if (!endpoint) {
  toFallback();
} else {
  socket = net.connect(endpoint);
  socket.on('connect', () => {
    if (mode !== 'connecting') return;
    socket.write(`${JSON.stringify({ conduit: 1, token })}\n`);
    for (const chunk of early) socket.write(chunk);
    early = [];
    mode = 'relay';
    if (stdinEnded) socket.end();
  });
  socket.on('data', (chunk) => process.stdout.write(chunk));
  // An error is always followed by 'close'; the fallback takes over there.
  socket.on('error', () => {});
  socket.on('close', () => toFallback());
}
