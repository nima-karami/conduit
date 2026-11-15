import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase } from './harness.mjs';
import {
  LinkProxy,
  linkView,
  networkState,
  pairServers,
  readAudit,
  startServerPair,
} from './net-helpers.mjs';

const log = makeLog('net-drive');
const WAIT_MS = 15_000;
const ECHO_AGENT = 'e2e-echo';

async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}
/** The fault a call rejected with, or null when it succeeded. */
async function faultOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return String(error);
  }
}
function echoed(a, viewId, text) {
  return a.c2.events.some(
    (e) => e.type === 'remote.data' && e.data.viewId === viewId && e.data.data.includes(text),
  );
}
function dumpServerLog(server) {
  const file = join(server.userData, 'server.log');
  if (existsSync(file))
    log(`${server.label} server.log tail:\n`, readFileSync(file, 'utf8').slice(-8000));
  log(
    `${server.label} drive audit:\n`,
    readAudit(server.userData)
      .map((e) => JSON.stringify(e))
      .join('\n'),
  );
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

    const { sessionId: echo } = await b.c2.call('sessions.create', {
      agentId: ECHO_AGENT,
      home: b.work,
    });
    b.c2.notify('term.resize', { sessionId: echo, cols: 100, rows: 30 });
    const started = await b.c2.call('sessions.start', { sessionId: echo });
    assert(started.ok, `echo start: ${JSON.stringify(started)}`);
    // The program prints its ready line after spawn, so an attach can beat it: retry the attach.
    let view;
    await eventually('echo attached with its ready line', async () => {
      view = await a.c2.call('remote.attach', { machineId: bId, sessionId: echo });
      if (view.firstPaint.includes('E2E-READY')) return true;
      await a.c2.call('remote.detach', { viewId: view.viewId });
      return false;
    });

    phase('2. drive is off by default and A cannot type into B');
    const bSeesA = await linkView(b.c2, aId);
    assert(bSeesA?.capabilities.drive === false, `B's record of A: ${JSON.stringify(bSeesA)}`);
    const aSeesB = await linkView(a.c2, bId);
    assert(aSeesB?.peerCapabilities.drive === false, `A's view of B: ${JSON.stringify(aSeesB)}`);
    let fault = await faultOf(
      a.c2.call('remote.input', { machineId: bId, sessionId: echo, data: 'refused\r' }),
    );
    assert(fault?.includes('capability_off'), `remote.input while off: ${fault}`);
    fault = await faultOf(
      a.c2.call('remote.open', { machineId: bId, agentId: ECHO_AGENT, folder: b.work }),
    );
    assert(fault?.includes('capability_off'), `remote.open while off: ${fault}`);
    assert(!echoed(a, view.viewId, 'ECHO:refused'), 'echo received refused input');

    phase('3. B enables drive; A types and B echoes');
    await b.c2.call('link.setCapability', { machineId: aId, capability: 'drive', on: true });
    await eventually('B drive capability seen by A', () =>
      linkView(a.c2, bId).then((l) => l?.peerCapabilities.drive === true),
    );
    await a.c2.call('remote.input', { machineId: bId, sessionId: echo, data: 'ping\r' });
    await eventually('ECHO:ping forwarded', () => echoed(a, view.viewId, 'ECHO:ping'));

    phase('4. remote resize reaches B');
    // The PTY's own size, reported by the program on its resize event, is the observable: the
    // session's lastSize facts only move on an hc size event that a plain resize does not emit.
    await a.c2.call('remote.resize', { machineId: bId, sessionId: echo, cols: 120, rows: 40 });
    await eventually('B PTY resized to 120x40', () => echoed(a, view.viewId, 'SIZE:120x40'));

    phase('5. input during a cut is refused and never delivered after resume');
    proxy.pause();
    proxy.cut();
    await eventually('link down', () => linkView(a.c2, bId).then((l) => l?.state === 'down'));
    fault = await faultOf(
      a.c2.call('remote.input', { machineId: bId, sessionId: echo, data: 'cut-input\r' }),
    );
    assert(fault?.includes('peer_unreachable'), `remote.input during cut: ${fault}`);
    proxy.resume();
    await eventually('link reconnected', () => linkView(a.c2, bId).then((l) => l?.state === 'up'));
    await a.c2.call('remote.input', { machineId: bId, sessionId: echo, data: 'after-resume\r' });
    await eventually('ECHO:after-resume forwarded', () =>
      echoed(a, view.viewId, 'ECHO:after-resume'),
    );
    assert(!echoed(a, view.viewId, 'ECHO:cut-input'), 'input sent during the cut reached B');

    phase('6. B turns drive off; the next remote input is refused');
    await b.c2.call('link.setCapability', { machineId: aId, capability: 'drive', on: false });
    await eventually('B drive capability off seen by A', () =>
      linkView(a.c2, bId).then((l) => l?.peerCapabilities.drive === false),
    );
    fault = await faultOf(
      a.c2.call('remote.input', { machineId: bId, sessionId: echo, data: 'after-off\r' }),
    );
    assert(fault?.includes('capability_off'), `remote.input after off: ${fault}`);

    phase('7. drive back on; remote open and close');
    await b.c2.call('link.setCapability', { machineId: aId, capability: 'drive', on: true });
    await eventually('B drive capability on again', () =>
      linkView(a.c2, bId).then((l) => l?.peerCapabilities.drive === true),
    );
    const opened = await a.c2.call('remote.open', {
      machineId: bId,
      agentId: ECHO_AGENT,
      folder: b.work,
    });
    const inSnapshot = async (id) =>
      (await linkView(a.c2, bId))?.snapshot?.sessions.some((s) => s.sessionId === id) ?? false;
    await eventually('remote-opened session in A snapshot', () => inSnapshot(opened.sessionId));
    await a.c2.call('remote.close', { machineId: bId, sessionId: opened.sessionId });
    await eventually(
      'remote-closed session gone from A snapshot',
      async () => !(await inSnapshot(opened.sessionId)),
    );
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
