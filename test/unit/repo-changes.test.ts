import { describe, expect, it, vi } from 'vitest';
import type { ChangeDTO } from '../../src/protocol';
import { buildRepoChanges } from '../../src/repo-changes';
import type { RepoInfo, RepoTag } from '../../src/repo-scan';

const repo = (root: string, tag: RepoTag = 'attached', folder = root): RepoInfo => ({
  root,
  name: root.split('/').pop() ?? root,
  folder,
  tag,
});

const change = (path: string): ChangeDTO => ({
  path,
  added: 1,
  removed: 0,
  kind: 'M',
  staged: false,
});

describe('buildRepoChanges', () => {
  it('active repo reuses activeChanges, changesFor not called for it', async () => {
    const active = [change('home.ts')];
    const changesFor = vi.fn(async (root: string) => [change(`${root}.ts`)]);
    const out = await buildRepoChanges({
      repos: [repo('C:/W/Home', 'home'), repo('/other')],
      activeRoot: 'c:/w/home/',
      activeChanges: active,
      repoGit: undefined,
      changesFor,
    });
    expect(changesFor.mock.calls).toEqual([['/other']]);
    expect(out[0].changes).toBe(active);
    expect(out[1].changes).toEqual([change('/other.ts')]);
  });

  it('order = input order', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = buildRepoChanges({
      repos: [repo('/a'), repo('/b'), repo('/c')],
      activeRoot: undefined,
      activeChanges: [],
      repoGit: undefined,
      changesFor: async (root) => {
        if (root === '/a') await gate;
        return [change(root)];
      },
    });
    release();
    const out = await run;
    expect(out.map((r) => [r.root, r.changes[0].path])).toEqual([
      ['/a', '/a'],
      ['/b', '/b'],
      ['/c', '/c'],
    ]);
  });

  it('changesFor reject → changes []', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await buildRepoChanges({
      repos: [repo('/bad'), repo('/ok')],
      activeRoot: undefined,
      activeChanges: [],
      repoGit: undefined,
      changesFor: async (root) => {
        if (root === '/bad') throw new Error('boom');
        return [change('x.ts')];
      },
    });
    expect(out.map((r) => r.changes)).toEqual([[], [change('x.ts')]]);
    log.mockRestore();
  });

  it('carries name, tag and sub from the repo', async () => {
    const out = await buildRepoChanges({
      repos: [
        repo('/w/room-message-bus/vendor/proto-schemas', 'attached', '/w/room-message-bus'),
        repo('/h', 'home'),
      ],
      activeRoot: undefined,
      activeChanges: [],
      repoGit: undefined,
      changesFor: async () => [],
    });
    expect(out).toEqual([
      {
        root: '/w/room-message-bus/vendor/proto-schemas',
        name: 'proto-schemas',
        tag: 'attached',
        sub: 'room-message-bus/vendor/proto-schemas',
        changes: [],
      },
      { root: '/h', name: 'h', tag: 'home', changes: [] },
    ]);
  });

  it('branch only when kind branch', async () => {
    const out = await buildRepoChanges({
      repos: [repo('/a'), repo('/b'), repo('/c')],
      activeRoot: undefined,
      activeChanges: [],
      repoGit: {
        '/a': { kind: 'branch', branch: 'main' },
        '/b': { kind: 'detached', sha: 'abcdef0' },
      },
      changesFor: async () => [],
    });
    expect(out.map((r) => r.branch)).toEqual(['main', undefined, undefined]);
    expect('branch' in out[1]).toBe(false);
  });

  it('at most 4 changesFor in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const repos = Array.from({ length: 10 }, (_, i) => repo(`/r${i}`));
    await buildRepoChanges({
      repos,
      activeRoot: undefined,
      activeChanges: [],
      repoGit: undefined,
      changesFor: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return [];
      },
    });
    expect(peak).toBe(4);
  });
});
