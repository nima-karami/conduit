import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { disposeHarnesses, fakeIdentity, harness } from '../../server/domain/testing/fakes';
import type { SessionStartResult } from '../../src/contracts/server-protocol';

afterEach(disposeHarnesses);

it('persists names and exact references and fences native edits by generation and revision', async () => {
  const fake = fakeIdentity();
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude', name: 'First' });
  await h.call('sessions.start', { sessionId: id });
  await h.call('sessions.mutate', {
    sessionId: id,
    mutation: { op: 'rename', name: 'From Conduit' },
  });
  await expect.poll(() => fake.writes.at(-1)?.name).toBe('From Conduit');
  fake.observers[0].rename({
    conversationId: 'conversation-fixture',
    name: 'First',
    source: 'native',
    echoRevision: 0,
  });
  expect(h.domain.sessions.get(id)?.name).toBe('From Conduit');
  fake.observers[0].rename({
    conversationId: 'conversation-fixture',
    name: 'From Claude',
    source: 'native',
  });
  expect(h.domain.sessions.get(id)?.name).toBe('From Claude');
  expect(readFileSync(join(h.userData, 'sessions.json'), 'utf8')).toContain('From Claude');
  expect(fake.writes.at(-1)?.name).toBe('From Conduit');

  const child = join(h.home, 'subfolder');
  mkdirSync(child);
  const session = h.domain.sessions.get(id);
  if (!session) throw new Error('Expected live session');
  session.cwd = child;
  await h.call('sessions.restart', { sessionId: id });
  await h.call('sessions.start', { sessionId: id });
  expect(h.runtime.spawns.at(-1)?.spec.cwd).toBe(h.home);
  expect(h.runtime.spawns.at(-1)?.spec.args).toContain('conversation-fixture');
  fake.observers[0].rename({
    conversationId: 'conversation-fixture',
    name: 'Old launch',
    source: 'native',
  });
  expect(h.domain.sessions.get(id)?.name).toBe('From Claude');
});

it('leaves a missing reference unmodified on retry and requires fresh-start confirmation', async () => {
  const fake = fakeIdentity();
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude', name: 'My label' });
  await h.call('sessions.start', { sessionId: id });
  await h.call('sessions.restart', { sessionId: id });
  fake.setExists('missing');

  const start = async () =>
    (await h.call('sessions.start', { sessionId: id })) as SessionStartResult;
  const r = await start();
  if (r.ok || r.refusal.reason !== 'conversation-resume')
    throw new Error('Expected resume refusal');
  expect(r.refusal.problem).toBe('resume-conversation-missing');
  expect(h.runtime.spawns).toHaveLength(1);
  expect(h.domain.sessions.get(id)?.conversationRef?.conversationId).toBe('conversation-fixture');

  const retry = (await h.call('sessions.resolveConversationResume', {
    sessionId: id,
    refusalId: r.refusal.refusalId,
    action: 'retry',
  })) as SessionStartResult;
  if (retry.ok || retry.refusal.reason !== 'conversation-resume')
    throw new Error('Expected retry refusal');
  expect(h.runtime.spawns).toHaveLength(1);
  await expect(
    h.call('sessions.resolveConversationResume', {
      sessionId: id,
      refusalId: r.refusal.refusalId,
      action: 'start-new',
    }),
  ).rejects.toThrow('no longer current');
  expect(
    await h.call('sessions.resolveConversationResume', {
      sessionId: id,
      refusalId: retry.refusal.refusalId,
      action: 'start-new',
    }),
  ).toMatchObject({ ok: true, spawned: true });
  expect(h.runtime.spawns.at(-1)?.spec.args).toContain('--fake-new-conversation');
  expect(h.domain.sessions.get(id)?.name).toBe('My label');
});

it('reports adopted terminals as decoupled until exact relaunch', async () => {
  const fake = fakeIdentity();
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude' });
  const t = h.runtime.live(id, 2, 'b'.repeat(32), { rows: 24, cols: 80 });
  h.domain.adopted([
    {
      ...t,
      labels: {
        'conduit.session': id,
        'conduit.instance': 'test',
        'conduit.generation': String(t.generation),
        'conduit.launch': t.launchId,
      },
    },
  ]);
  expect(h.domain.snapshot().sessions.find((s) => s.id === id)?.namingState).toMatchObject({
    naming: 'decoupled',
    followTerminalTitle: false,
  });
  expect(await h.call('sessions.start', { sessionId: id })).toMatchObject({
    ok: true,
    spawned: false,
  });
  expect(h.runtime.spawns).toHaveLength(0);
});

it('keeps the current terminal alive when a permissions restart cannot resume', async () => {
  const fake = fakeIdentity();
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude' });
  await h.call('sessions.start', { sessionId: id });
  fake.setExists('missing');
  expect(await h.call('sessions.restart', { sessionId: id, expectedGeneration: 1 })).toMatchObject({
    ok: false,
    reason: 'conversationResume',
  });
  expect(h.runtime.get(id)?.generation).toBe(1);
  expect(h.runtime.calls).not.toContain(`retire:${id}`);
});

it('keeps a verified resume reference when the live binding is lost', async () => {
  const fake = fakeIdentity();
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude', name: 'Canonical' });
  await h.call('sessions.start', { sessionId: id });
  fake.observers[0].unbind('server-exited');
  fake.observers[0].rename({
    conversationId: 'conversation-fixture',
    name: 'Stale',
    source: 'native',
  });
  expect(h.domain.sessions.get(id)).toMatchObject({
    name: 'Canonical',
    conversationRef: { conversationId: 'conversation-fixture' },
  });
  expect(h.domain.snapshot().sessions.find((s) => s.id === id)).toMatchObject({
    namingState: { naming: 'decoupled' },
    namingUnavailableReason: expect.stringContaining('connection closed'),
  });
});

it('keeps a verified Claude switch and its native title when an old write completes late', async () => {
  const fake = fakeIdentity();
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude', name: 'Original' });
  await h.call('sessions.start', { sessionId: id });
  await expect.poll(() => fake.writes.at(-1)?.name).toBe('Original');

  let done: (() => void) | undefined;
  fake.adapter.setName = async () =>
    new Promise<void>((resolve) => {
      done = resolve;
    });
  await h.call('sessions.mutate', { sessionId: id, mutation: { op: 'rename', name: 'Old write' } });
  await expect.poll(() => typeof done).toBe('function');

  fake.observers[0].bind('replacement');
  fake.observers[0].rename({
    conversationId: 'replacement',
    name: 'Replacement title',
    source: 'native',
  });
  done?.();

  expect(h.domain.sessions.get(id)).toMatchObject({
    name: 'Replacement title',
    conversationRef: { conversationId: 'replacement' },
    namingState: { nativeSync: { status: 'synced' } },
  });
});

it('uses the adapter executable override and keeps original launch IDs', async () => {
  const fake = fakeIdentity();
  fake.adapter.fresh = async (launch) => ({
    command: '/bin/identity-wrapper',
    argv: [launch.command, ...launch.argv],
    env: { IDENTITY_WRAPPER: '1' },
  });
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude' });
  await h.call('sessions.start', { sessionId: id });
  const launch = h.runtime.spawns[0];
  expect(launch?.spec).toMatchObject({
    command: '/bin/identity-wrapper',
    env: { IDENTITY_WRAPPER: '1' },
  });
  expect(h.domain.sessions.get(id)?.conversationRef?.capturedAt).toEqual(launch?.ids);
});

it('recouples an adopted PTY only after the adapter verifies its original launch', async () => {
  const fake = fakeIdentity();
  const observed: Parameters<NonNullable<typeof fake.adapter.adopt>>[] = [];
  fake.adapter.adopt = async (...args) => {
    observed.push(args);
  };
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude' });
  const t = h.runtime.live(id, 2, 'c'.repeat(32), { rows: 24, cols: 80 });
  h.domain.adopted([
    {
      ...t,
      labels: {
        'conduit.session': id,
        'conduit.instance': 'test',
        'conduit.generation': String(t.generation),
        'conduit.launch': t.launchId,
      },
    },
  ]);
  await expect.poll(() => observed.length).toBe(1);
  const [launch, ref, observer] = observed[0];
  expect(launch.ids).toMatchObject({ generation: t.generation, launchId: t.launchId });
  expect(ref).toBeUndefined();
  const mode = () => h.domain.snapshot().sessions.find((s) => s.id === id)?.namingState?.naming;
  expect(mode()).toBe('decoupled');
  expect(await h.call('sessions.start', { sessionId: id })).toMatchObject({
    ok: true,
    spawned: false,
  });
  observer.bind('adopted-conversation');
  expect(mode()).toBe('coupled');
  expect(h.domain.sessions.get(id)?.conversationRef?.conversationId).toBe('adopted-conversation');
  expect(h.runtime.spawns).toHaveLength(0);
});

it('starts with the original launcher when fresh identity preparation fails', async () => {
  const fake = fakeIdentity();
  fake.adapter.fresh = async () => {
    throw new Error('unsupported launch flag');
  };
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude', name: 'Fallback' });
  expect(await h.call('sessions.start', { sessionId: id })).toMatchObject({
    ok: true,
    spawned: true,
  });
  expect(h.runtime.spawns).toHaveLength(1);
  expect(h.runtime.spawns[0]?.spec).toMatchObject({ command: 'claude', args: [] });
  expect(h.domain.snapshot().sessions.find((s) => s.id === id)).toMatchObject({
    name: 'Fallback',
    namingState: { naming: 'decoupled' },
    namingUnavailableReason: 'Agent name sync could not start with this launcher.',
  });
});

it('refuses identity preparation failure on exact resume without spawning fresh', async () => {
  const fake = fakeIdentity();
  fake.adapter.resume = async () => {
    throw new Error('could not prepare exact resume');
  };
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude' });
  await h.call('sessions.start', { sessionId: id });
  await h.call('sessions.restart', { sessionId: id });
  expect(await h.call('sessions.start', { sessionId: id })).toMatchObject({
    ok: false,
    refusal: { reason: 'conversation-resume', problem: 'resume-check-unavailable' },
  });
  expect(h.runtime.spawns).toHaveLength(1);
  expect(h.domain.sessions.get(id)?.conversationRef?.conversationId).toBe('conversation-fixture');
});

it('relaunches an unbound adapter-backed session and reports the fresh conversation', async () => {
  const fake = fakeIdentity();
  fake.adapter.observe = async () => {};
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude' });
  const view = () => h.domain.snapshot().sessions.find((session) => session.id === id);

  await h.call('sessions.start', { sessionId: id });
  expect(view()?.startedNewConversation).toBeUndefined();
  expect(await h.call('sessions.restart', { sessionId: id })).toMatchObject({ ok: true });
  expect(await h.call('sessions.start', { sessionId: id })).toMatchObject({
    ok: true,
    spawned: true,
  });
  expect(h.runtime.spawns.at(-1)?.spec.args).toContain('--fake-new-conversation');
  expect(view()).toMatchObject({ startedNewConversation: true });
  expect(view()?.startRefusal).toBeUndefined();
});

it('relaunches with a saved reference when the adapter cannot resume', async () => {
  const fake = fakeIdentity();
  const h = harness({ identityAdapters: [fake.adapter] });
  const id = await h.create({ agentId: 'claude' });
  await h.call('sessions.start', { sessionId: id });
  expect(h.domain.sessions.get(id)?.conversationRef).toBeDefined();
  fake.adapter.capabilities.exactResume = false;

  expect(await h.call('sessions.restart', { sessionId: id })).toMatchObject({ ok: true });
  expect(await h.call('sessions.start', { sessionId: id })).toMatchObject({
    ok: true,
    spawned: true,
  });
  expect(h.runtime.spawns.at(-1)?.spec.args).toContain('--fake-new-conversation');
  expect(h.domain.snapshot().sessions.find((session) => session.id === id)).toMatchObject({
    startedNewConversation: true,
  });
});
