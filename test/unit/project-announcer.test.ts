import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

type Reply = Extract<HostToWebview, { type: 'session:opResult' }> | null;
const pending: {
  send: (id: number) => WebviewToHost;
  types: readonly string[];
  timeoutMs: number;
  resolve: (r: Reply) => void;
}[] = [];

vi.mock('../../webview/host-request', () => ({
  requestHost: (send: (id: number) => WebviewToHost, types: readonly string[], timeoutMs: number) =>
    new Promise<Reply>((resolve) => pending.push({ send, types, timeoutMs, resolve })),
}));

type Announcer = typeof import('../../webview/project-announcer').projectAnnouncer;
let announcer: Announcer;

beforeEach(async () => {
  pending.length = 0;
  vi.resetModules();
  announcer = (await import('../../webview/project-announcer')).projectAnnouncer;
});

const P = (id: string, name: string) => ({ id, name, order: 0 });

describe('projectAnnouncer — deletes', () => {
  it('noteDelete then observeProjects without the id → "Deleted <name>", subscribers notified', () => {
    const cb = vi.fn();
    announcer.subscribe(cb);
    expect(announcer.getSnapshot()).toBe('');
    announcer.noteDelete('p1', 'Alpha');
    expect(cb).not.toHaveBeenCalled();
    announcer.observeProjects([P('p2', 'Beta')]);
    expect(announcer.getSnapshot()).toBe('Deleted Alpha');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('still present → nothing', () => {
    const cb = vi.fn();
    announcer.subscribe(cb);
    announcer.noteDelete('p1', 'Alpha');
    announcer.observeProjects([P('p1', 'Alpha')]);
    expect(announcer.getSnapshot()).toBe('');
    expect(cb).not.toHaveBeenCalled();
  });

  // The announcer's pending window for a delete the host may silently refuse.
  const PENDING_MS = 10_000;

  it('a refused delete (the id outlives the pending window) is forgotten, not announced later', () => {
    vi.useFakeTimers();
    try {
      const cb = vi.fn();
      announcer.subscribe(cb);
      announcer.noteDelete('p1', 'Alpha');
      vi.advanceTimersByTime(PENDING_MS + 1);
      announcer.observeProjects([P('p1', 'Alpha')]);
      // Deleted later from another window: that window announces it, this one must not.
      announcer.observeProjects([]);
      expect(announcer.getSnapshot()).toBe('');
      expect(cb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('within the pending window a state still holding the id keeps the delete pending', () => {
    vi.useFakeTimers();
    try {
      announcer.noteDelete('p1', 'Alpha');
      vi.advanceTimersByTime(PENDING_MS - 1);
      announcer.observeProjects([P('p1', 'Alpha')]);
      announcer.observeProjects([]);
      expect(announcer.getSnapshot()).toBe('Deleted Alpha');
    } finally {
      vi.useRealTimers();
    }
  });

  it('announced once', () => {
    const cb = vi.fn();
    announcer.subscribe(cb);
    announcer.noteDelete('p1', 'Alpha');
    announcer.observeProjects([]);
    announcer.observeProjects([]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('same text twice re-announces (differs by a zero-width space)', () => {
    announcer.noteDelete('p1', 'Alpha');
    announcer.observeProjects([]);
    const first = announcer.getSnapshot();
    announcer.noteDelete('p9', 'Alpha');
    announcer.observeProjects([]);
    const second = announcer.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.replace(/\u200b/g, '')).toBe('Deleted Alpha');
  });

  it('unsubscribe stops notifications', () => {
    const cb = vi.fn();
    const off = announcer.subscribe(cb);
    off();
    announcer.noteDelete('p1', 'Alpha');
    announcer.observeProjects([]);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('projectAnnouncer — moves', () => {
  const settle = async (r: Reply) => {
    pending[0].resolve(r);
    await Promise.resolve();
    await Promise.resolve();
  };
  const TEXT = { session: 'api fix', target: 'RMB pipeline' };

  it('moveSession sends session:setProject {sessionId, projectId, requestId} awaiting session:opResult', () => {
    announcer.moveSession('s1', 'p-1', TEXT);
    expect(pending).toHaveLength(1);
    expect(pending[0].send(7)).toEqual({
      type: 'session:setProject',
      sessionId: 's1',
      projectId: 'p-1',
      requestId: 7,
    });
    expect(pending[0].types).toEqual(['session:opResult']);
    expect(pending[0].timeoutMs).toBe(10_000);
    announcer.moveSession('s1', null, TEXT);
    expect(pending[1].send(8)).toMatchObject({ projectId: null });
  });

  it('ok reply → "Moved api fix to RMB pipeline"', async () => {
    const cb = vi.fn();
    announcer.subscribe(cb);
    announcer.moveSession('s1', 'p-1', TEXT);
    expect(announcer.getSnapshot()).toBe('');
    await settle({ type: 'session:opResult', requestId: 1, ok: true });
    expect(announcer.getSnapshot()).toBe('Moved api fix to RMB pipeline');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('!ok → "Couldn\'t move api fix"', async () => {
    announcer.moveSession('s1', 'p-1', TEXT);
    await settle({ type: 'session:opResult', requestId: 1, ok: false, reason: 'unknown-session' });
    expect(announcer.getSnapshot()).toBe("Couldn't move api fix");
  });

  it('null (timeout) → no announcement', async () => {
    const cb = vi.fn();
    announcer.subscribe(cb);
    announcer.moveSession('s1', 'p-1', TEXT);
    await settle(null);
    expect(announcer.getSnapshot()).toBe('');
    expect(cb).not.toHaveBeenCalled();
  });
});
