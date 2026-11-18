import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase } from './harness.mjs';
import {
  agentRecords,
  callTool,
  LinkProxy,
  linkView,
  networkState,
  pairServers,
  startAgent,
  startServerPair,
} from './net-helpers.mjs';

const log = makeLog('net-monitor');
const WAIT_MS = 15_000;
async function setCapability(server, params) {
  const state = await networkState(server);
  const link = state.links.find((row) => row.machineId === params.machineId);
  assert(link, 'link is present');
  return server.c2.call('link.setCapability', { ...params, expectedToken: link.editToken });
}
async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}
function dumpServerLog(server) {
  const file = join(server.userData, 'server.log');
  if (existsSync(file))
    log(`${server.label} server.log tail:\n`, readFileSync(file, 'utf8').slice(-8000));
}
async function run() {
  let pair;
  let proxy;
  try {
    phase('1. pair servers and route the link through a loopback proxy');
    pair = await startServerPair();
    const { a, b } = pair;
    const { aId, bId } = await pairServers(a, b);
    await b.c2.call('link.setAddresses', { machineId: aId, addresses: ['127.0.0.1:1'] });
    await b.restart();
    const listen = (await networkState(b)).listening[0];
    assert(listen?.startsWith('127.0.0.1:'), `B listener: ${listen}`);
    proxy = new LinkProxy({
      host: '127.0.0.1',
      port: Number(listen.slice(listen.lastIndexOf(':') + 1)),
    });
    const address = await proxy.listen();
    await a.c2.call('link.setAddresses', { machineId: bId, addresses: [address] });
    await eventually(
      'link through proxy',
      () => proxy.pairs.size > 0 && linkView(a.c2, bId).then((l) => l?.state === 'up'),
    );

    phase('2. observe an ordinary echo terminal');
    const { sessionId: echo } = await b.c2.call('sessions.create', {
      agentId: 'e2e-echo',
      home: b.work,
    });
    b.c2.notify('term.resize', { sessionId: echo, cols: 100, rows: 30 });
    const started = await b.c2.call('sessions.start', { sessionId: echo });
    assert(started.ok, `echo start: ${JSON.stringify(started)}`);
    await eventually('echo in monitor snapshot without an MCP handle', async () =>
      (await linkView(a.c2, bId))?.snapshot?.sessions.some(
        (s) => s.sessionId === echo && s.handle === null,
      ),
    );
    const view = await a.c2.call('remote.attach', { machineId: bId, sessionId: echo });
    assert(view.firstPaint.includes('E2E-READY'), `first paint: ${JSON.stringify(view)}`);
    b.c2.notify('term.input', { sessionId: echo, generation: started.generation, data: 'hello\r' });
    await eventually('echo output forwarded', () =>
      a.c2.events.some(
        (e) =>
          e.type === 'remote.data' &&
          e.data.viewId === view.viewId &&
          e.data.data.includes('ECHO:hello'),
      ),
    );

    phase('3. freeze, reconnect and repaint');
    proxy.pause();
    proxy.cut();
    await eventually('view frozen', () =>
      a.c2.events.some(
        (e) =>
          e.type === 'remote.state' && e.data.viewId === view.viewId && e.data.state === 'frozen',
      ),
    );
    b.c2.notify('term.input', {
      sessionId: echo,
      generation: started.generation,
      data: 'offline\r',
    });
    proxy.resume();
    await eventually('view resyncs and returns live', () => {
      const states = a.c2.events
        .filter((e) => e.type === 'remote.state' && e.data.viewId === view.viewId)
        .map((e) => e.data.state);
      return states.includes('frozen') && states.includes('resyncing') && states.includes('live');
    });
    await eventually('fresh paint contains the offline output', () =>
      a.c2.events.some(
        (e) =>
          e.type === 'remote.data' &&
          e.data.viewId === view.viewId &&
          e.data.data.includes('ECHO:offline'),
      ),
    );

    phase('4. request summary and remote wait');
    const aa = await startAgent(a);
    const ba = await startAgent(b);
    const question = await callTool(b, ba, 'send_message', {
      to: ['you'],
      kind: 'question',
      subject: 'Monitor question',
      body: 'Please choose',
    });
    assert(question.message_id, `question: ${JSON.stringify(question)}`);
    await eventually('request visible to A', async () =>
      (await linkView(a.c2, bId))?.snapshot?.requests.some(
        (r) => r.type === 'text' && r.summary.includes('asked you a question'),
      ),
    );
    let remote;
    await eventually('B MCP agent listed on A', async () => {
      const listed = await callTool(a, aa, 'list_sessions', {});
      remote = listed.sessions?.find((s) => s.session_id === ba.sessionId && s.machine_id === bId);
      return !!remote;
    });
    const before = agentRecords(a, aa.sessionId, 'CALL').length;
    const waiting = callTool(a, aa, 'wait_sessions', {
      sessions: [remote.address],
      until: ['exited'],
      timeout_s: 15,
    });
    await eventually(
      'remote wait started',
      () => agentRecords(a, aa.sessionId, 'CALL').length > before,
    );
    b.c2.notify('term.input', {
      sessionId: ba.sessionId,
      generation: ba.generation,
      data: 'quit\r',
    });
    const result = await waiting;
    assert(
      result.fired?.some((f) => f.session === remote.address && f.condition === 'exited'),
      `remote wait: ${JSON.stringify(result)}`,
    );

    phase('5. unreachable wait and monitor refusal');
    proxy.pause();
    proxy.cut();
    await eventually('link down', () => linkView(a.c2, bId).then((l) => l?.state === 'down'));
    const unreachable = await callTool(a, aa, 'wait_sessions', {
      sessions: [remote.address],
      until: ['exited'],
    });
    assert(
      unreachable.error?.code === 'peer_unreachable',
      `unreachable wait: ${JSON.stringify(unreachable)}`,
    );
    proxy.resume();
    await eventually('link reconnected', () => linkView(a.c2, bId).then((l) => l?.state === 'up'));
    await setCapability(b, { machineId: aId, capability: 'monitor', on: false });
    await eventually('peer capability disabled', () =>
      linkView(a.c2, bId).then((l) => l?.peerCapabilities?.monitor === false),
    );
    let refused = false;
    try {
      await a.c2.call('remote.attach', { machineId: bId, sessionId: echo });
    } catch (error) {
      refused = String(error).includes('capability_off');
    }
    assert(refused, 'remote.attach was not refused when monitor was disabled');
  } catch (error) {
    for (const server of [pair?.a, pair?.b]) if (server) dumpServerLog(server);
    if (proxy?.errors.length) log('proxy errors:', proxy.errors);
    throw error;
  } finally {
    await proxy?.close();
    await pair?.stopAll();
  }
}
let code = 0;
try {
  await run();
  log('PASS ✓');
} catch (error) {
  code = error?.name === 'AssertionError' ? 1 : 2;
  log('FAIL ✗', error?.stack || error?.message || String(error));
}
await finishScenario(code);
