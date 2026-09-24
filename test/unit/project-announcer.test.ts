import { beforeEach, describe, expect, it, vi } from 'vitest';

type Announcer = typeof import('../../webview/project-announcer').projectAnnouncer;
let announcer: Announcer;

beforeEach(async () => {
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
    expect(second.replace(/​/g, '')).toBe('Deleted Alpha');
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
