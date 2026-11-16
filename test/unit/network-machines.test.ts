import { describe, expect, it } from 'vitest';
import { type LinkStoreIo, openLinkStore } from '../../server/network/link-store';
import { createMachines, type MachinesManager } from '../../server/network/machines';
import type { LinkState } from '../../src/contracts/link-protocol';
import type { MachineMeta } from '../../src/contracts/machines';
import type { BootstrapResult, SshFailure } from '../../src/contracts/ssh-link';

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
    waitUp: async (machineId) => states.get(machineId) === 'up',
  };
  return {
    manager,
    calls,
    states,
    setDialWorks(v: boolean) {
      dialWorks = v;
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
  const exitCalls: string[] = [];
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
    sshExit: async (target) => {
      exitCalls.push(target);
      return null;
    },
  });
  return { store, fake, machines, bootstrapCalls, exitCalls };
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
      sshExit: async () => null,
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
      sshExit: async () => null,
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
  it('a disconnect of a down machine is a no-op success, and still exits its master', async () => {
    const { store, fake, machines, exitCalls } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'down' });
    expect(await machines.disconnect('vm-a')).toEqual({
      ok: true,
      value: { machine: 'vm-a', state: 'down' },
    });
    expect(exitCalls).toEqual(['a.example']);
  });

  it('disconnect clears enabled and then exits the master with the dialer ControlPath', async () => {
    const { store, fake, machines, exitCalls } = setup();
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'up' });
    await machines.disconnect('vm-a');
    expect(fake.calls).toEqual(['disconnect m-00000001']);
    expect(store.get('m-00000001')?.machine?.enabled).toBe(false);
    expect(exitCalls).toEqual(['a.example']);
  });

  it('disconnect keeps the remote sessions: it only closes the manager link', async () => {
    const entries = [{ machineId: 'm-00000001' }, { machineId: 'm-00000001' }];
    const { store, fake, machines } = setup(entries);
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'up' });
    await machines.disconnect('vm-a');
    expect(fake.calls).toEqual(['disconnect m-00000001']);
    expect(entries).toHaveLength(2);
  });

  it('a failed master exit is reported, not hidden behind success', async () => {
    const store = openLinkStore('/net/links.json', { now: Date.now, log: quiet, io: memIo() });
    const fake = fakeManager(store);
    const machines = createMachines({
      manager: fake.manager,
      store,
      bootstrap: async () => ({ ok: false, error: { code: 'ssh_failed', detail: 'x' } }),
      directory: { entries: () => [] },
      sshExit: async () => ({ code: 'ssh_failed', detail: 'mux gone' }),
    });
    pin(store, fake, { id: 'm-00000001', name: 'vm-a', target: 'a.example', n: 1, state: 'up' });
    expect(await machines.disconnect('vm-a')).toEqual({
      ok: false,
      error: { code: 'ssh_unreachable', detail: { detail: 'mux gone' } },
    });
  });

  it('an unknown machine, or a bare target, is machine_unknown', async () => {
    const { machines, exitCalls } = setup();
    expect(await machines.disconnect('nobody')).toEqual({
      ok: false,
      error: { code: 'machine_unknown', detail: {} },
    });
    expect(await machines.disconnect('new.example')).toEqual({
      ok: false,
      error: { code: 'machine_unknown', detail: {} },
    });
    expect(exitCalls).toEqual([]);
  });

  it('a machine with no machine block cannot hold enabled, so disconnect says so', async () => {
    const { store, fake, machines, exitCalls } = setup();
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
    expect(exitCalls).toEqual([]);
    expect(fake.calls).toEqual([]);
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
