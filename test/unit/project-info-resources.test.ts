import { afterEach, expect, it, vi } from 'vitest';
import { runGit } from '../../src/git-exec';
import { readRepoChanges } from '../../src/project-info';
import type { ChangeDTO } from '../../src/protocol';

async function readOk(root: string): Promise<ChangeDTO[]> {
  const r = await readRepoChanges(root, { lines: true });
  expect(r.ok).toBe(true);
  return r.ok ? r.changes : [];
}

const mock = vi.hoisted(() => ({ active: 0, peak: 0, summarize: false }));
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
  const changes = await readOk('/repo');
  expect(changes).toHaveLength(30);
  expect(changes.every((change) => change.removed === 2)).toBe(true);
  expect(vi.mocked(runGit).mock.calls.filter(([args]) => args[0] === 'show')).toHaveLength(0);
  expect(vi.mocked(runGit).mock.calls).toHaveLength(4);
});

it('bounds deleted-file subprocesses across simultaneous project refreshes', async () => {
  mock.peak = mock.active = 0;
  const results = await Promise.all([readOk('/one'), readOk('/two')]);
  expect(results.map((r) => r.length)).toEqual([30, 30]);
  expect(results.flat().every((r) => r.removed === 2)).toBe(true);
  expect(mock.peak).toBeLessThanOrEqual(4);
});
