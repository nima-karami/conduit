import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RpcFault } from '../../server/transport/pipe';
import { type Identity, loadIdentity } from '../../server/network/identity';
import { createLinkManager, type LinkManager } from '../../server/network/link-manager';
import { type LinkStoreIo, openLinkStore } from '../../server/network/link-store';
import { createMachines, type MachinesManager } from '../../server/network/machines';
import type { LinkState } from '../../src/contracts/link-protocol';
import type { MachineMeta } from '../../src/contracts/machines';
import type { BootstrapResult, SshDial, SshFailure } from '../../src/contracts/ssh-link';

const quiet = { error: () => undefined };
const META: MachineMeta = {
  os: 'linux',
  arch: 'x64',
  version: '0.9.0',
  mode: 'full',
  agents: ['claude'],
  enabled: true,
  survivesLogout: true,
};
const SUMMARY = {
  os: 'linux' as const,
  arch: 'x64' as const,
  installed: true,
  upgraded: false,
  reused: false,
  survivesLogout: true,
  version: '0.9.0',
  agents: ['claude'],
};

function memIo(): LinkStoreIo {
  const files = new Map<string, string>();
  return {
    read: (p) => files.get(p) ?? null,
    write: (p, t) => {
      files.set(p, t);
    },
    rename: (a, b) => {
      const t = files.get(a);
      if (t !== undefined) files.set(b, t);
      files.delete(a);
    },
  };
}

/** A key for a machine id: 32 bytes, so the store and the hello check see a server key. */
const keyOf = (n: number) => Buffer.alloc(32, n).toString('base64');

/** A manager that mirrors the real one's writes: enabled goes to the store, state is its own. */
function fakeManager(store: ReturnType<typeof openLinkStore>) {
  const calls: string[] = [];
  const states = new Map<string, LinkState>();
  let dialWorks = true;
  let waitFailure: SshFailure | null = null;
  const manager: MachinesManager = {
    view: (machineId) => {
      const state = states.get(machineId);
      return state === undefined ? null : { state, lastActivity: null };
    },
    disconnect: (machineId) => {
      calls.push(`disconnect ${machineId}`);
      const meta = store.get(machineId)?.machine;
      if (!meta || !store.setMachine(machineId, { ...meta, enabled: false })) return false;
      states.set(machineId, 'down');
      return true;
    },
    enable: (machineId) => {
      calls.push(`enable ${machineId}`);
      const meta = store.get(machineId)?.machine;
      if (!meta || !store.setMachine(machineId, { ...meta, enabled: true })) return false;
      states.set(machineId, dialWorks ? 'up' : 'down');
      return true;
    },
    forget: (machineId) => {
      calls.push(`forget ${machineId}`);
      states.delete(machineId);
      return store.remove(machineId);
    },
    waitUp: async (machineId) =>
      states.get(machineId) === 'up' && waitFailure === null
        ? { up: true }
        : { up: false, failure: waitFailure },
  };
  return {
    manager,
    calls,
    states,
    setDialWorks(v: boolean) {
      dialWorks = v;
    },
    /** What the wait reports after a bootstrap: a dial that failed, or null for a silent wait. */
    setWaitFailure(f: SshFailure | null) {
      waitFailure = f;
    },
  };
}

/** A machine already pinned, as bootstrap leaves it; `meta: false` is a v2 record with no block. */
function pin(
  store: ReturnType<typeof openLinkStore>,
  fake: ReturnType<typeof fakeManager>,
  o: {
    id: string;
    name: string;
    target: string;
    n: number;
    state?: LinkState;
    enabled?: boolean;
    meta?: boolean;
  },
) {
  store.addSsh({
    machineId: o.id,
    serverKey: keyOf(o.n),
    ownerKey: null,
    name: o.name,
    ssh: { target: o.target, node: '/n', mainJs: '/m.js', userData: '/u' },
  });
  if (o.meta !== false) store.setMachine(o.id, { ...META, enabled: o.enabled ?? true });
  fake.states.set(o.id, o.state ?? 'down');
}

/** What bootstrapAndLink does for a target that pins: the pin, then its machine block. */
function bootstrapPins(
  store: ReturnType<typeof openLinkStore>,
  fake: ReturnType<typeof fakeManager>,
  id: string,
  name: string,
  target: string,
  n: number,
): BootstrapResult {
  store.addSsh({
    machineId: id,
    serverKey: keyOf(n),
    ownerKey: null,
    name,
    ssh: { target, node: '/n', mainJs: '/m.js', userData: '/u' },
  });
  store.setMachine(id, { ...META, enabled: true });
  fake.states.set(id, 'up');
  return {
    ok: true,
    machineId: id,
    ssh: { target, node: '/n', mainJs: '/m.js', userData: '/u' },
    summary: SUMMARY,
  };
}

function setup(
  entries: Array<{ machineId: string }> = [],
  pinAs = { id: 'm-0000000a', name: 'new-box' },
) {
  const store = openLinkStore('/net/links.json', { now: Date.now, log: quiet, io: memIo() });
  const fake = fakeManager(store);
  const bootstrapCalls: string[] = [];
  const machines = createMachines({
    manager: fake.manager,
    store,
    bootstrap: async (target) => {
      bootstrapCalls.push(target);
      // The real bootstrap pins after its remote steps, so a second connect can arrive first.
      await new Promise((r) => setTimeout(r, 0));
      return bootstrapPins(store, fake, pinAs.id, pinAs.name, target, 10);
    },
    directory: { entries: () => entries },
  });
  return { store, fake, machines, bootstrapCalls };
}

const LIVE = new AbortController().signal;

describe('machines: resolution order', () => {
  it('a machine id is matched before a name, and a name before an ssh target', async () => {
    const { store, fake, machines, bootstrapCalls } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'up' });
    // Named like the first machine's id: the id must win for m-00000001.
    pin(store, fake, {
      id: 'm-00000002',
      name: 'm-00000001',
      target: 'b.example',
      n: 2,
      state: 'up',
    });
    const byId = await machines.connect('m-00000001', LIVE);
    expect(byId).toMatchObject({ ok: true, value: { machine_id: 'm-00000001', reused: true } });
    const byName = await machines.connect('vm-a', LIVE);
    expect(byName).toMatchObject({ ok: true, value: { machine_id: 'm-00000001' } });
    const byTarget = await machines.connect('b.example', LIVE);
    expect(byTarget).toMatchObject({ ok: true, value: { machine_id: 'm-00000002', reused: true } });
    expect(bootstrapCalls).toEqual([]);
  });

  it('an ambiguous name is machine_unknown, and lists the candidates by id', async () => {
    const { store, fake, machines, bootstrapCalls } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'twin', target: 'a.example', n: 1, state: 'up' });
    pin(store, fake, { id: 'm-00000002', name: 'twin', target: 'b.example', n: 2, state: 'up' });
    const r = await machines.connect('twin', LIVE);
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'machine_unknown',
        detail: {},
        candidates: ['m-00000001', 'm-00000002'],
      },
    });
    expect(bootstrapCalls).toEqual([]);
  });

  it('a value that is not a target and matches nothing is machine_unknown, not a bootstrap', async () => {
    const { machines, bootstrapCalls } = setup();
    const r = await machines.connect('no spaces allowed', LIVE);
    expect(r).toEqual({ ok: false, error: { code: 'machine_unknown', detail: {} } });
    expect(bootstrapCalls).toEqual([]);
  });
});

describe('machines: connect', () => {
  it('a known machine that is up is reused: no dial, no bootstrap', async () => {
    const { store, fake, machines, bootstrapCalls } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'up' });
    const r = await machines.connect('vm-a', LIVE);
    expect(r).toEqual({
      ok: true,
      value: {
        machine: 'vm-a',
        machine_id: 'm-00000001',
        state: 'up',
        os: 'linux',
        arch: 'x64',
        mode: 'full',
        conduit_version: '0.9.0',
        reused: true,
        installed: false,
        upgraded: false,
      },
    });
    expect(fake.calls).toEqual([]);
    expect(bootstrapCalls).toEqual([]);
  });

  it('a known machine that is down is redialed and waited for', async () => {
    const { store, fake, machines } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'down' });
    const r = await machines.connect('vm-a', LIVE);
    expect(fake.calls).toEqual(['enable m-00000001']);
    expect(r).toMatchObject({ ok: true, value: { machine_id: 'm-00000001', reused: false } });
  });

  it('a known machine that stays down past its wait is ssh_unreachable with detail timeout', async () => {
    const { store, fake, machines } = setup();
    fake.setDialWorks(false);
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'down' });
    expect(await machines.connect('vm-a', LIVE)).toEqual({
      ok: false,
      error: { code: 'ssh_unreachable', detail: { detail: 'timeout' } },
    });
  });

  it('a known machine with no machine block is refreshed by bootstrap, not reused', async () => {
    const { store, fake, machines, bootstrapCalls } = setup([], {
      id: 'm-00000001',
      name: 'legacy',
    });
    pin(store, fake, {
      id: 'm-00000001',
      name: 'legacy',
      target: 'a.example',
      n: 1,
      state: 'up',
      meta: false,
    });
    const r = await machines.connect('legacy', LIVE);
    expect(bootstrapCalls).toEqual(['a.example']);
    expect(r).toMatchObject({
      ok: true,
      value: { machine_id: 'm-00000001', reused: false, os: 'linux' },
    });
    expect(store.get('m-00000001')?.machine?.enabled).toBe(true);
  });

  // An added machine gets its block from its hello, while its link is up: it is reused, no bootstrap.
  it('a record whose hello wrote its block while the link is up is reused, not bootstrapped', async () => {
    const { store, fake, machines, bootstrapCalls } = setup([], {
      id: 'm-00000002',
      name: 'added',
    });
    pin(store, fake, {
      id: 'm-00000002',
      name: 'added',
      target: 'b.example',
      n: 2,
      state: 'up',
      meta: false,
    });
    store.setMachine('m-00000002', { ...META, agents: [] });
    const r = await machines.connect('added', LIVE);
    expect(bootstrapCalls).toEqual([]);
    expect(r).toMatchObject({ ok: true, value: { machine_id: 'm-00000002', reused: true } });
  });

  // The bootstrap pinned the machine, but its link never stayed up: connect must say so, not ok.
  it('a bootstrap that pins a machine whose link then fails is that failure, not ok', async () => {
    const { fake, machines } = setup();
    fake.setWaitFailure({ code: 'ssh_auth_failed' });
    expect(await machines.connect('new.example', LIVE)).toEqual({
      ok: false,
      error: { code: 'ssh_auth_failed', detail: {} },
    });
  });

  it('an unknown target is bootstrapped, and the machine it pins is listed', async () => {
    const { machines, bootstrapCalls } = setup();
    const r = await machines.connect('new.example', LIVE);
    expect(bootstrapCalls).toEqual(['new.example']);
    expect(r).toMatchObject({
      ok: true,
      value: { machine: 'new-box', machine_id: 'm-0000000a', state: 'up', reused: false },
    });
    expect((await machines.list()).map((m) => m.machine_id)).toEqual(['m-0000000a']);
  });

  it('needs-person is a typed error with its reason, and nothing is stored', async () => {
    const store = openLinkStore('/net/links.json', { now: Date.now, log: quiet, io: memIo() });
    const fake = fakeManager(store);
    const failure: SshFailure = { code: 'ssh_needs_person', reason: 'host_key_unknown' };
    const machines = createMachines({
      manager: fake.manager,
      store,
      bootstrap: async () => ({ ok: false, error: failure }),
      directory: { entries: () => [] },
    });
    expect(await machines.connect('new.example', LIVE)).toEqual({
      ok: false,
      error: { code: 'ssh_needs_person', detail: { reason: 'host_key_unknown' } },
    });
    expect(store.links()).toEqual([]);
  });

  it('two concurrent connects to one target share one bootstrap run', async () => {
    const { machines, bootstrapCalls } = setup();
    const [a, b] = await Promise.all([
      machines.connect('new.example', LIVE),
      machines.connect('new.example', LIVE),
    ]);
    expect(bootstrapCalls).toEqual(['new.example']);
    expect(a).toEqual(b);
  });

  // The budget is the caller's signal: the work it started is not cancelled, and it still records.
  it('an abort returns ssh_unreachable timeout, and the bootstrap still records its pin', async () => {
    const store = openLinkStore('/net/links.json', { now: Date.now, log: quiet, io: memIo() });
    const fake = fakeManager(store);
    let finish: (r: BootstrapResult) => void = () => undefined;
    let starts = 0;
    const machines = createMachines({
      manager: fake.manager,
      store,
      bootstrap: () => {
        starts += 1;
        return new Promise<BootstrapResult>((resolve) => {
          finish = resolve;
        });
      },
      directory: { entries: () => [] },
    });
    const ac = new AbortController();
    const pending = machines.connect('slow.example', ac.signal);
    ac.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'ssh_unreachable', detail: { detail: 'timeout' } },
    });
    expect(store.links()).toEqual([]);
    // The run outlives the budget, so a later connect joins it rather than starting another install.
    const later = machines.connect('slow.example', LIVE);
    expect(starts).toBe(1);
    // Still running after the budget: when it lands, the pin and its machine block are recorded.
    finish(bootstrapPins(store, fake, 'm-0000000b', 'slow-box', 'slow.example', 11));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get('m-0000000b')).toMatchObject({ name: 'slow-box', machine: { enabled: true } });
    expect(await later).toMatchObject({ ok: true, value: { machine_id: 'm-0000000b' } });
  });
});

describe('machines: disconnect', () => {
  it('a disconnect of a down machine is a no-op success', async () => {
    const { store, fake, machines } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'down' });
    expect(await machines.disconnect('vm-a')).toEqual({
      ok: true,
      value: { machine: 'vm-a', state: 'down' },
    });
  });

  it('disconnect clears enabled and closes the link, leaving the ssh master to expire', async () => {
    const { store, fake, machines } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'up' });
    await machines.disconnect('vm-a');
    expect(fake.calls).toEqual(['disconnect m-00000001']);
    expect(store.get('m-00000001')?.machine?.enabled).toBe(false);
  });

  it('disconnect keeps the remote sessions: it only closes the manager link', async () => {
    const entries = [{ machineId: 'm-00000001' }, { machineId: 'm-00000001' }];
    const { store, fake, machines } = setup(entries);
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'up' });
    await machines.disconnect('vm-a');
    expect(fake.calls).toEqual(['disconnect m-00000001']);
    expect(entries).toHaveLength(2);
  });

  it('an unknown machine, or a bare target, is machine_unknown', async () => {
    const { machines } = setup();
    expect(await machines.disconnect('nobody')).toEqual({
      ok: false,
      error: { code: 'machine_unknown', detail: {} },
    });
    expect(await machines.disconnect('new.example')).toEqual({
      ok: false,
      error: { code: 'machine_unknown', detail: {} },
    });
  });

  it('a machine with no machine block cannot hold enabled, so disconnect says so', async () => {
    const { store, fake, machines } = setup();
    pin(store, fake, {
      id: 'm-00000001',
      name: 'legacy',
      target: 'a.example',
      n: 1,
      state: 'up',
      meta: false,
    });
    const r = await machines.disconnect('legacy');
    expect(r.ok).toBe(false);
    expect(fake.calls).toEqual([]);
  });
});

describe('machines: concurrent redials', () => {
  it('two concurrent connects to one known, down machine share one redial', async () => {
    const { store, fake, machines } = setup();
    fake.setDialWorks(false);
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'down' });
    const [x, y] = await Promise.all([
      machines.connect('vm-a', LIVE),
      machines.connect('vm-a', LIVE),
    ]);
    expect(fake.calls.filter((c) => c.startsWith('enable'))).toEqual(['enable m-00000001']);
    expect(x).toEqual(y);
  });
});

describe('machines: list', () => {
  it('shows a disabled machine as disabled, with its meta and its session count', async () => {
    const { store, fake, machines } = setup([
      { machineId: 'm-00000001' },
      { machineId: 'm-00000001' },
    ]);
    pin(store, fake, {
      id: 'm-00000001',
      name: 'vm-a',
      target: 'a.example',
      n: 1,
      state: 'down',
      enabled: false,
    });
    expect(await machines.list()).toEqual([
      {
        machine: 'vm-a',
        machine_id: 'm-00000001',
        target: 'a.example',
        state: 'disabled',
        mode: 'full',
        os: 'linux',
        arch: 'x64',
        conduit_version: '0.9.0',
        agents: ['claude'],
        sessions: 2,
        last_seen: null,
        survives_logout: true,
      },
    ]);
  });

  it('lists only pinned machines: a controller record with no endpoint is not one', async () => {
    const { store, fake, machines } = setup();
    store.addSsh({
      machineId: 'm-00000003',
      serverKey: keyOf(3),
      ownerKey: null,
      name: 'controller',
      ssh: null,
    });
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'up' });
    expect((await machines.list()).map((m) => m.machine_id)).toEqual(['m-00000001']);
  });

  it('a machine with no machine block shows its unknown fields as null', async () => {
    const { store, fake, machines } = setup();
    pin(store, fake, {
      id: 'm-00000001',
      name: 'legacy',
      target: 'a.example',
      n: 1,
      state: 'down',
      meta: false,
    });
    const [row] = await machines.list();
    expect(row).toMatchObject({
      os: null,
      arch: null,
      mode: null,
      conduit_version: null,
      survives_logout: null,
      agents: [],
    });
  });
});

/** A clock the manager reads through now and after: timers fire only when the test moves time. */
function fakeClock(start = Date.parse('2026-11-16T10:00:00.000Z')) {
  let t = start;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const nextDue = (end: number) =>
    timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
  return {
    now: () => t,
    after(fn: () => void, ms: number) {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    run(ms: number) {
      const end = t + ms;
      for (let next = nextDue(end); next; next = nextDue(end)) {
        next.live = false;
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** Every dial's ssh child dies before its hello, and its failure is the one given. */
const failingDial =
  (failure: SshFailure): SshDial =>
  () => {
    const stream = new PassThrough();
    stream.destroy();
    return { stream, failure: async () => failure };
  };

const nodeIdentity = (): Identity => {
  const r = loadIdentity('/net', {
    read: () => null,
    write: () => undefined,
    rename: () => undefined,
  });
  if (r.kind === 'newer') throw new Error('unexpected');
  return { ...r.identity, ownerKey: null };
};

/** The real manager on a fake clock, dialing through the given ssh dial. */
function realManager(dial: SshDial) {
  const clock = fakeClock();
  const store = openLinkStore('/net/links.json', { now: clock.now, log: quiet, io: memIo() });
  const quietLog = { debug: () => undefined, warn: () => undefined, error: () => undefined };
  const manager: LinkManager = createLinkManager({
    identity: nodeIdentity,
    selfName: () => 'controller',
    appVersion: '9.9.9',
    tls: () => ({ cert: '', key: '' }),
    store,
    audit: { record: () => undefined },
    sshDial: dial,
    log: quietLog,
    now: clock.now,
    rand: () => 0.5,
    after: (fn, ms) => clock.after(fn, ms),
    onFrame: () => undefined,
    changed: () => undefined,
    onOwnerKey: () => false,
    reconnected: () => undefined,
  });
  return { clock, store, manager };
}

/**
 * A known machine that is down: its dial is what the connect must wait on. Resolves to the connect's
 * answer, or to 'pending' if the connect is still waiting after the fake clock has run its dial.
 */
async function connectWhileDialFails(failure: SshFailure) {
  const { clock, store, manager } = realManager(failingDial(failure));
  store.addSsh({
    machineId: 'm-00000001',
    serverKey: Buffer.alloc(32, 1).toString('base64'),
    ownerKey: null,
    name: 'vm-a',
    ssh: { target: 'a.example', node: '/n', mainJs: '/m.js', userData: '/u' },
  });
  store.setMachine('m-00000001', { ...META, enabled: false });
  manager.start();
  const machines = createMachines({
    manager,
    store,
    bootstrap: async () => ({ ok: false, error: { code: 'ssh_failed', detail: 'unused' } }),
    directory: { entries: () => [] },
  });
  const started = clock.now();
  const pending = machines.connect('vm-a', LIVE);
  clock.run(0);
  await flush();
  const winner = await Promise.race([
    pending,
    new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
  ]);
  manager.stop();
  return { winner, elapsedMs: clock.now() - started };
}

describe('machines: a known machine whose dial reports why it failed', () => {
  it('a host key change is ssh_needs_person with its reason, well before the 30 s wait', async () => {
    const { winner, elapsedMs } = await connectWhileDialFails({
      code: 'ssh_needs_person',
      reason: 'host_key_changed',
    });
    expect(winner).toEqual({
      ok: false,
      error: { code: 'ssh_needs_person', detail: { reason: 'host_key_changed' } },
    });
    expect(elapsedMs).toBeLessThan(30_000);
  });

  it('an auth refusal is ssh_auth_failed, not a timeout', async () => {
    const { winner } = await connectWhileDialFails({ code: 'ssh_auth_failed' });
    expect(winner).toEqual({ ok: false, error: { code: 'ssh_auth_failed', detail: {} } });
  });

  it('a bridge refusal reaches the caller as ssh_unreachable with the bridge detail', async () => {
    const { winner } = await connectWhileDialFails({ code: 'bridge_refused' });
    expect(winner).toEqual({
      ok: false,
      error: { code: 'ssh_unreachable', detail: { detail: 'bridge_refused' } },
    });
  });
});

describe('machines: a target that claims a machine already added under another name', () => {
  it('identity_conflict carries the name of the machine the target is already added as', async () => {
    const store = openLinkStore('/net/links.json', { now: Date.now, log: quiet, io: memIo() });
    const fake = fakeManager(store);
    const machines = createMachines({
      manager: fake.manager,
      store,
      bootstrap: async () => ({
        ok: false,
        error: { code: 'identity-conflict', machine: 'office-pc' },
      }),
      directory: { entries: () => [] },
    });
    expect(await machines.connect('new.example', LIVE)).toEqual({
      ok: false,
      error: { code: 'identity_conflict', detail: { machine: 'office-pc' } },
    });
  });
});

/** The fault a call threw, so a test can assert its kind as well as its message. */
function faultOf(fn: () => unknown): RpcFault {
  try {
    fn();
  } catch (e) {
    if (e instanceof RpcFault) return e;
    throw e;
  }
  throw new Error('expected a RpcFault');
}

describe('machines: rename', () => {
  it('trims the name and stores it on the ssh record', () => {
    const { store, fake, machines } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1 });
    machines.rename('m-00000001', '  Build box  ');
    expect(store.get('m-00000001')?.name).toBe('Build box');
  });

  it('refuses an empty, 65-character or control-character name as invalid, and stores nothing', () => {
    const { store, fake, machines } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1 });
    for (const name of ['   ', 'x'.repeat(65), 'bad\tname', 'bad\nname']) {
      expect(faultOf(() => machines.rename('m-00000001', name)).kind).toBe('invalid');
    }
    expect(store.get('m-00000001')?.name).toBe('vm-a');
  });

  it('accepts a 64-character name', () => {
    const { store, fake, machines } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1 });
    machines.rename('m-00000001', 'x'.repeat(64));
    expect(store.get('m-00000001')?.name).toHaveLength(64);
  });

  it('an unknown machine id is not_found', () => {
    const { machines } = setup();
    expect(faultOf(() => machines.rename('m-99999999', 'ok')).kind).toBe('not_found');
  });

  it('only an ssh record can be renamed: a tls record is invalid', () => {
    const { store, machines } = setup();
    store.put({
      linkId: 'l-tls',
      machineId: 'm-0000000t',
      serverKey: keyOf(7),
      ownerKey: null,
      name: 'paired',
      trust: 'own',
      addresses: ['127.0.0.1:1'],
      capabilities: { messaging: true, monitor: true, drive: false },
      fingerprint: 'fp',
      createdAt: '2026-11-16T00:00:00.000Z',
      cert: 'PEM',
      ownerTransfer: null,
      transport: 'tls',
      ssh: null,
      machine: null,
    });
    expect(faultOf(() => machines.rename('m-0000000t', 'new')).kind).toBe('invalid');
    expect(store.get('m-0000000t')?.name).toBe('paired');
  });
});

describe('machines: remove', () => {
  it('remove forgets the machine: the manager closes it and its record is gone', () => {
    const { store, fake, machines } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'up' });
    machines.remove('m-00000001');
    expect(fake.calls).toEqual(['forget m-00000001']);
    expect(store.get('m-00000001')).toBeNull();
    expect(store.byServerKey(keyOf(1))).toBeNull();
  });

  it('an unknown machine is not_found and nothing is forgotten', () => {
    const { store, fake, machines } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1 });
    expect(faultOf(() => machines.remove('m-99999999')).kind).toBe('not_found');
    expect(fake.calls).toEqual([]);
    expect(store.get('m-00000001')).not.toBeNull();
  });
});
