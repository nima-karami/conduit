import * as fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { runGit } from '../../src/git-exec';
import { getProjectInfo, gitChanges } from '../../src/project-info';

const mock = vi.hoisted(() => ({ active: 0, peak: 0, summarize: false }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn(original.existsSync),
    readdirSync: vi.fn(original.readdirSync),
    promises: { ...original.promises, readdir: vi.fn(original.promises.readdir) },
  };
});
vi.mock('../../src/git-exec', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/git-exec')>();
  return {
    ...original,
    runGit: vi.fn(async (args: string[]) => {
      let stdout = '';
      if (args[0] === 'status')
        stdout = Array.from({ length: 30 }, (_, i) => ` D file${i}.txt\0`).join('');
      if (mock.summarize && args.includes('--diff-filter=D'))
        stdout = Array.from({ length: 30 }, (_, i) => `0\t2\tfile${i}.txt\0`).join('');
      if (args[0] === 'show') {
        mock.peak = Math.max(mock.peak, ++mock.active);
        await new Promise((r) => setTimeout(r, 0));
        mock.active--;
        stdout = 'one\ntwo\n';
      }
      return { ok: true, stdout };
    }),
  };
});
afterEach(() => {
  mock.summarize = false;
  vi.restoreAllMocks();
  vi.mocked(runGit).mockClear();
});

it('counts large deletion sets from one HEAD diff rather than one process per file', async () => {
  mock.summarize = true;
  const changes = await gitChanges('/repo');
  expect(changes).toHaveLength(30);
  expect(changes.every((change) => change.removed === 2)).toBe(true);
  expect(vi.mocked(runGit).mock.calls.filter(([args]) => args[0] === 'show')).toHaveLength(0);
  expect(vi.mocked(runGit).mock.calls).toHaveLength(4);
});

it('bounds deleted-file subprocesses across simultaneous project refreshes', async () => {
  mock.peak = mock.active = 0;
  const results = await Promise.all([gitChanges('/one'), gitChanges('/two')]);
  expect(results.map((r) => r.length)).toEqual([30, 30]);
  expect(results.flat().every((r) => r.removed === 2)).toBe(true);
  expect(mock.peak).toBeLessThanOrEqual(4);
});

it('does not synchronously traverse a project tree and stops at the output budget', async () => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  const sync = vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
  const read = vi.spyOn(fs.promises, 'readdir').mockImplementation(
    async () =>
      Array.from({ length: 600 }, (_, i) => ({
        name: `file${i}`,
        isDirectory: () => false,
        isFile: () => true,
      })) as never,
  );
  const result = await getProjectInfo('/tree', '');
  expect(result.files).toHaveLength(400);
  expect(read).toHaveBeenCalledTimes(1);
  expect(sync.mock.calls.some(([p]) => p === '/tree')).toBe(false);
});
