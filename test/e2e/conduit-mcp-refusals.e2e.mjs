/**
 * conduit-mcp-refusals — the host refuses what it must (spec docs/specs/2026-10-25-conduit-mcp-server.md
 * §3.2, §3.3, §7; plan T9.4). Notices are paused for every session here, so no notice can land in
 * the middle of a typed `call` line.
 *   - `../../.ssh/id_rsa` → path_outside_roots, and B's inbox stays empty;
 *   - a junction inside the root pointing outside it → path_outside_roots;
 *   - C, not in A↔B's thread, reading it → not_found;
 *   - the shim run directly with no token → tools/list [] and tools/call not_in_session;
 *   - 21 alternating agent sends in one thread → the 21st is thread_limit;
 *   - messaging turned off in Settings → messaging_off.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTool,
  fakeAgentProfile,
  openFake,
  pauseNotices,
  setMessaging,
  sleep,
  tapMcp,
} from './conduit-mcp-helpers.mjs';
import { assert, REPO, runScenario } from './harness.mjs';

const require = createRequire(import.meta.url);
const errCode = (r) => r?.error?.code;

/** Run the shim the way a CLI would, but outside any session: no token in its env. */
async function bareShim(endpoint) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.CONDUIT_SESSION_TOKEN;
  const shim = join(REPO, 'resources', 'conduit-mcp', 'conduit-mcp-shim.cjs');
  const child = spawn(require('electron'), [shim, '--endpoint', endpoint], {
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buf = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
      i = buf.indexOf('\n');
    }
  });
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      const t = setTimeout(() => reject(new Error(`bare shim: no reply to ${method}`)), 15_000);
      waiting.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { child, request };
}

await runScenario(
  'conduit-mcp-refusals',
  async ({ page, userDataDir, log }) => {
    await tapMcp(page);
    const work = mkdtempSync(join(tmpdir(), 'conduit-mcp-refusals-'));
    const outside = mkdtempSync(join(tmpdir(), 'conduit-mcp-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'not yours\n');
    mkdirSync(join(work, 'sub'), { recursive: true });
    symlinkSync(outside, join(work, 'sub', 'link'), 'junction');

    const a = await openFake(page, work);
    const b = await openFake(page, work);
    const c = await openFake(page, work);
    for (const s of [a, b, c]) await pauseNotices(page, s.sessionId, true);
    log(`A=${a.handle} B=${b.handle} C=${c.handle}`);
    await sleep(1_000);

    // Exfiltration by `..`
    const dots = await callTool(page, a.sessionId, 'send_message', {
      to: [b.handle],
      body: 'here',
      attachments: [{ path: '../../.ssh/id_rsa' }],
    });
    assert(errCode(dots) === 'path_outside_roots', `../ send: ${JSON.stringify(dots)}`);
    const empty = await callTool(page, b.sessionId, 'read_inbox', {});
    assert(
      Array.isArray(empty.messages) && empty.messages.length === 0,
      `B's inbox after a refused send: ${JSON.stringify(empty)}`,
    );

    // Exfiltration by a junction inside the root
    const viaJunction = await callTool(page, a.sessionId, 'send_message', {
      to: [b.handle],
      body: 'here',
      attachments: [{ path: 'sub/link/secret.txt' }],
    });
    assert(
      errCode(viaJunction) === 'path_outside_roots',
      `junction send: ${JSON.stringify(viaJunction)}`,
    );

    // Participation: C is not in A↔B's thread
    const ab = await callTool(page, a.sessionId, 'send_message', {
      to: [b.handle],
      priority: 'fyi',
      body: 'private',
    });
    assert(ab.thread_id, `A→B send: ${JSON.stringify(ab)}`);
    const peek = await callTool(page, c.sessionId, 'read_inbox', { thread_id: ab.thread_id });
    assert(errCode(peek) === 'not_found', `C reading A↔B's thread: ${JSON.stringify(peek)}`);

    // No token: the shim outside a session
    const cfg = JSON.parse(
      readFileSync(join(userDataDir, 'conduit-mcp', 'launch', `${a.sessionId}.json`), 'utf8'),
    );
    const endpoint = cfg.mcpServers.conduit.args[2];
    const bare = await bareShim(endpoint);
    try {
      await bare.request('initialize', { protocolVersion: '2025-06-18' });
      const list = await bare.request('tools/list', {});
      assert(
        Array.isArray(list.result?.tools) && list.result.tools.length === 0,
        `tokenless tools/list: ${JSON.stringify(list)}`,
      );
      const call = await bare.request('tools/call', { name: 'list_sessions', arguments: {} });
      const body = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
      assert(
        call.result?.isError === true && body.error?.code === 'not_in_session',
        `tokenless tools/call: ${JSON.stringify(call)}`,
      );
    } finally {
      bare.child.kill();
    }

    // Loop guard: 20 agent messages since the human last posted, then thread_limit
    let thread = null;
    for (let i = 1; i <= 20; i += 1) {
      const [from, to] = i % 2 === 1 ? [a, b] : [b, a];
      const r = await callTool(page, from.sessionId, 'send_message', {
        to: [to.handle],
        priority: 'fyi',
        body: `ping ${i}`,
        ...(thread ? { thread_id: thread } : {}),
      });
      assert(r.thread_id, `send ${i}: ${JSON.stringify(r)}`);
      thread = r.thread_id;
    }
    const over = await callTool(page, a.sessionId, 'send_message', {
      to: [b.handle],
      priority: 'fyi',
      body: 'ping 21',
      thread_id: thread,
    });
    assert(errCode(over) === 'thread_limit', `21st send: ${JSON.stringify(over)}`);

    // Messaging off
    await setMessaging(page, false);
    const off = await callTool(page, a.sessionId, 'list_sessions', {});
    assert(errCode(off) === 'messaging_off', `with messaging off: ${JSON.stringify(off)}`);
    await setMessaging(page, true);
  },
  { userDataDir: fakeAgentProfile('conduit-mcp-refusals') },
);
