import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { until } from './conduit-mcp-helpers.mjs';
import { assert, finishScenario, makeLog, phase } from './harness.mjs';
import { linkView, networkState, pairServers, readAudit, startServerPair } from './net-helpers.mjs';

// Pairing between two standalone servers over loopback, with no Electron: a good code links them,
// a wrong code is refused on both sides without touching the standing link, and a revoke on one
// side is seen by the other. The audit files record each step.

const log = makeLog('net-pairing');
const WAIT_MS = 15_000;
const FINGERPRINT = /^[0-9A-F]{4}-[0-9A-F]{4}$/;
const CAPABILITIES = { messaging: true, monitor: true, drive: false };

/** Polls `check` until it holds, or fails naming what never happened. */
async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}

const pairingState = async (server) => (await networkState(server)).pairing?.state ?? null;

const sameCapabilities = (caps) =>
  caps !== null &&
  typeof caps === 'object' &&
  Object.keys(caps).length === Object.keys(CAPABILITIES).length &&
  Object.entries(CAPABILITIES).every(([key, value]) => caps[key] === value);

/** The last lines of a server's log, for a failure the scenario's own asserts cannot explain. */
function dumpServerLog(server) {
  const file = join(server.userData, 'server.log');
  if (existsSync(file))
    log(`${server.label} server.log tail:\n`, readFileSync(file, 'utf8').slice(-4000));
}

async function run() {
  let pair;
  try {
    phase('1. two standalone servers on loopback');
    pair = await startServerPair();
    const { a, b } = pair;

    phase('2. pair: both sides up, equal fingerprints, own trust, default capabilities');
    const { aId, bId, fingerprint } = await pairServers(a, b);
    assert(FINGERPRINT.test(fingerprint), `fingerprint shape: ${fingerprint}`);
    for (const [server, peerId] of [
      [a, bId],
      [b, aId],
    ]) {
      const link = await linkView(server.c2, peerId);
      assert(link?.trust === 'own', `${server.label} link trust: ${JSON.stringify(link)}`);
      assert(
        sameCapabilities(link.capabilities),
        `${server.label} capabilities: ${JSON.stringify(link.capabilities)}`,
      );
    }

    phase('3. wrong code: a fresh pairing refused on both sides, the standing link kept');
    const retry = await a.c2.call('pairing.start', {});
    // Any valid word other than the real first word makes the code wrong.
    const wrongCode = [
      retry.code[0] === 'abandon' ? 'ability' : 'abandon',
      retry.code[1],
      retry.code[2],
    ];
    await b.c2.call('pairing.join', {
      code: wrongCode.join(' '),
      address: retry.addresses[0],
    });
    await eventually('wrong-code on both sides', async () => {
      const [sa, sb] = [await pairingState(a), await pairingState(b)];
      return sa === 'wrong-code' && sb === 'wrong-code';
    });
    assert(
      (await linkView(a.c2, bId))?.state === 'up' && (await linkView(b.c2, aId))?.state === 'up',
      'the standing link left "up" after a wrong code',
    );

    phase('4. revoke on b: b sees its own revoke, a sees the peer revoke');
    await b.c2.call('link.revoke', { machineId: aId });
    await eventually('b to show the link revoked by itself', async () => {
      const link = await linkView(b.c2, aId);
      return link?.state === 'revoked' && link.revokedBy === 'me';
    });
    await eventually('a to show the link revoked by its peer', async () => {
      const link = await linkView(a.c2, bId);
      return link?.state === 'revoked' && link.revokedBy === 'peer';
    });

    phase('5. audit: each side records what it did');
    const kinds = (server) => readAudit(server.userData).map((entry) => entry.kind);
    await eventually('b audit to hold pairing.linked and link.revoked', () => {
      const k = kinds(b);
      return k.includes('pairing.linked') && k.includes('link.revoked');
    });
    await eventually('a audit to hold pairing.linked and pairing.failed', () => {
      const k = kinds(a);
      return k.includes('pairing.linked') && k.includes('pairing.failed');
    });
    for (const server of [a, b]) {
      for (const entry of readAudit(server.userData)) {
        assert(entry.v === 1, `${server.label} audit line without v:1: ${JSON.stringify(entry)}`);
      }
    }
  } catch (error) {
    for (const server of [pair?.a, pair?.b]) if (server) dumpServerLog(server);
    throw error;
  } finally {
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
