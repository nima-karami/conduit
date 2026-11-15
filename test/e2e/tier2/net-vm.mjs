// Tier 2 run (docs/runs/2026-11-14-CON-27/test-env.md; plan Slice 9): server A on this host, server B
// in a QEMU VM reached only through 127.0.0.1 forwards, a real kernel and NIC between them. Pairs the
// two, sends A→B, pauses the whole VM as the blip, sends again, resumes, and checks B has each
// message exactly once. Run: `node tools/vm-peer.mjs up && node test/e2e/tier2/net-vm.mjs`.
// Not part of the CI e2e set: it needs KVM and the VM image.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { GUEST, PORTS, sshArgs } from '../../../tools/vm-peer.mjs';
import { until } from '../conduit-mcp-helpers.mjs';
import { assert, makeLog, REPO, resolveHcBinary } from '../harness.mjs';
import { callTool, startAgent, startServer } from '../net-helpers.mjs';

const log = makeLog('net-vm');
const WAIT_MS = 30_000;
/** A on the host, loopback only; QEMU's guest gateway 10.0.2.2 reaches it from inside the VM. */
const A_PORT = 47591;
const HOST_FROM_GUEST = '10.0.2.2';

const sshRun = (cmd, input) => {
  const r = spawnSync('ssh', [...sshArgs(), cmd], {
    input,
    encoding: 'buffer',
    maxBuffer: 1 << 30,
  });
  assert(r.status === 0, `ssh ${cmd}: ${r.stderr?.toString()}`);
  return r.stdout.toString();
};
const vm = (cmd) => {
  const r = spawnSync(process.execPath, [`${REPO}/tools/vm-peer.mjs`, cmd], { encoding: 'utf8' });
  assert(r.status === 0, `vm-peer ${cmd}: ${r.stderr}`);
};

function copyIntoVm() {
  log('copying node, hc, out/server and test/e2e into the VM');
  sshRun('mkdir -p ~/bin ~/conduit');
  sshRun('cat > ~/bin/node && chmod +x ~/bin/node', readFileSync(process.execPath));
  sshRun('cat > ~/bin/conduit-hc && chmod +x ~/bin/conduit-hc', readFileSync(resolveHcBinary()));
  const tar = spawnSync(
    'tar',
    [
      '-C',
      REPO,
      '-czf',
      '-',
      'package.json',
      'out/server',
      'test/e2e',
      'src/contracts/hc.ts',
      'resources/conduit-mcp',
    ],
    {
      maxBuffer: 1 << 30,
    },
  );
  assert(tar.status === 0, 'tar failed');
  sshRun('tar -C ~/conduit -xzf -', tar.stdout);
}

/** Server B in the VM, driven over the ssh session's stdio (vm-b.mjs). */
function startRemoteB() {
  const child = spawn(
    'ssh',
    [
      ...sshArgs(),
      'cd ~/conduit && CONDUIT_HC_BINARY=$HOME/bin/conduit-hc PATH=$HOME/bin:$PATH ~/bin/node test/e2e/tier2/vm-b.mjs',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const waiting = new Map();
  let ready;
  let failed;
  const readyP = new Promise((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  // B dying in the VM must fail the run, not leave it waiting.
  child.on('exit', (code) => {
    const error = new Error(`server B in the VM exited (${code})`);
    failed(error);
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  });
  let next = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.startsWith('@@')) return log(`[vm] ${line}`);
    const msg = JSON.parse(line.slice(2));
    if (msg.ready) return ready();
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) w?.reject(new Error(msg.error));
    else w?.resolve(msg.result);
  });
  const send = (req) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
  return {
    ready: readyP,
    call: (method, params) => send({ op: 'call', method, params }),
    agent: () => send({ op: 'agent' }),
    tool: (sessionId, tool, args) => send({ op: 'tool', sessionId, tool, args }),
    stop: () => send({ op: 'stop' }).catch(() => undefined),
    kill: () => child.kill(),
  };
}

async function eventually(what, check) {
  assert(await until(check, WAIT_MS), `timed out waiting for: ${what}`);
}

async function run() {
  copyIntoVm();
  const a = await startServer('host-a');
  const b = startRemoteB();
  try {
    await a.c2.call('serverSettings.patch', {
      patch: { networkBindHost: '127.0.0.1', networkPort: A_PORT, networkSelfName: 'host-a' },
    });
    await b.ready;
    log('B is up in the VM');

    // Pairing: A opens on loopback; B joins through the guest gateway.
    const opened = await a.c2.call('pairing.start', {});
    const pairPort = opened.addresses[0].slice(opened.addresses[0].lastIndexOf(':') + 1);
    const joined = await b.call('pairing.join', {
      code: opened.code.join(' '),
      address: `${HOST_FROM_GUEST}:${pairPort}`,
    });
    await eventually('both sides at confirm', async () => {
      const [sa, sb] = await Promise.all([a.c2.call('link.list', {}), b.call('link.list', {})]);
      return sa.pairing?.state === 'confirm' && sb.pairing?.state === 'confirm';
    });
    const [pa, pb] = await Promise.all([a.c2.call('link.list', {}), b.call('link.list', {})]);
    assert(pa.pairing.fingerprint === pb.pairing.fingerprint, 'fingerprints differ');
    log(`fingerprint ${pa.pairing.fingerprint} matches on both`);
    await a.c2.call('pairing.confirm', { pairingId: opened.pairingId });
    await b.call('pairing.confirm', { pairingId: joined.pairingId });
    const aId = pa.machineId;
    const bId = pb.machineId;
    // Each side advertised addresses the other can't reach across QEMU's NAT; point them at the
    // forwards, as a person would type an address.
    await a.c2.call('link.setAddresses', {
      machineId: bId,
      addresses: [`127.0.0.1:${PORTS.link}`],
    });
    await b.call('link.setAddresses', {
      machineId: aId,
      addresses: [`${HOST_FROM_GUEST}:${A_PORT}`],
    });
    const linkUp = async () => {
      const [sa, sb] = await Promise.all([a.c2.call('link.list', {}), b.call('link.list', {})]);
      return (
        sa.links.some((l) => l.machineId === bId && l.state === 'up') &&
        sb.links.some((l) => l.machineId === aId && l.state === 'up')
      );
    };
    await eventually('link up both ways', linkUp);
    log(`linked: A ${aId} (host) ↔ B ${bId} (VM, guest port ${GUEST.link})`);

    const aa = await startAgent(a);
    const ba = await b.agent();
    let address;
    await eventually('B agent listed on A', async () => {
      const listed = await callTool(a, aa, 'list_sessions', {});
      address = listed.sessions?.find((s) => s.session_id === ba.sessionId)?.address;
      return !!address;
    });
    log(`B agent address ${address}`);

    const first = await callTool(a, aa, 'send_message', { to: [address], body: 'tier2 first' });
    const inboxOf = async (id) =>
      ((await b.tool(ba.sessionId, 'read_inbox', { unread_only: false })).messages ?? []).filter(
        (m) => m.message_id === id,
      );
    await eventually(
      'B reads the first message',
      async () => (await inboxOf(first.message_id)).length === 1,
    );
    log('first message delivered once');

    // The blip: the whole VM stops, kernel and all, so A's TLS session sees silence, not a reset.
    vm('pause');
    const blip = await callTool(a, aa, 'send_message', {
      to: [address],
      body: 'tier2 during blip',
    });
    assert(blip.recipients?.[0]?.status === 'queued', `send during blip: ${JSON.stringify(blip)}`);
    await eventually('A notices the link is not up', async () => {
      const sa = await a.c2.call('link.list', {});
      return sa.links.some((l) => l.machineId === bId && l.state !== 'up');
    });
    const during = (await a.c2.call('link.list', {})).links.find((l) => l.machineId === bId)?.state;
    log(`A sees the link as ${during} while the VM is paused`);
    vm('resume');
    await eventually('link back up after resume', linkUp);
    await eventually(
      'B reads the blip message',
      async () => (await inboxOf(blip.message_id)).length === 1,
    );
    assert((await inboxOf(first.message_id)).length === 1, 'first message duplicated');
    assert((await inboxOf(blip.message_id)).length === 1, 'blip message duplicated');
    log('short blip: both messages delivered exactly once');

    // A long blip: held until A gives the link up, so recovery is a fresh TLS session and an
    // outbox resend, not a stalled socket that resumes.
    vm('pause');
    const pausedAt = Date.now();
    const long = await callTool(a, aa, 'send_message', { to: [address], body: 'tier2 long blip' });
    assert(
      await until(async () => {
        const sa = await a.c2.call('link.list', {});
        return sa.links.some((l) => l.machineId === bId && l.state === 'down');
      }, 120_000),
      'A never marked the link down while the VM was paused',
    );
    const downAfterS = Math.round((Date.now() - pausedAt) / 1000);
    log(`A marked the link down ${downAfterS}s into the pause`);
    vm('resume');
    await eventually('link back up after the long blip', linkUp);
    await eventually(
      'B reads the long-blip message',
      async () => (await inboxOf(long.message_id)).length === 1,
    );
    for (const m of [first, blip, long])
      assert((await inboxOf(m.message_id)).length === 1, `${m.message_id} duplicated`);
    log('PASS: three messages delivered exactly once across a short and a long whole-VM pause');
    return { aId, bId, fingerprint: pa.pairing.fingerprint, during, downAfterS };
  } finally {
    await b.stop();
    b.kill();
    await a.stop();
  }
}

try {
  const r = await run();
  log('result', JSON.stringify(r));
  process.exit(0);
} catch (error) {
  log('FAIL', error?.stack ?? String(error));
  process.exit(1);
}
