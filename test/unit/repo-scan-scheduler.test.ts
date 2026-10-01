import { afterEach, expect, it, vi } from 'vitest';
import { createRepoScanScheduler } from '../../src/repo-scan-scheduler';

afterEach(() => vi.useRealTimers());

it('coalesces changes during a scan and only applies the newest folder set', async () => {
  vi.useFakeTimers();
  const gates: ((value: string[]) => void)[] = [];
  const applied: string[][] = [];
  const scanner = createRepoScanScheduler({
    scan: () => new Promise<string[]>((resolve) => gates.push(resolve)),
    apply: (_id, repos) => applied.push(repos),
    onError: () => {},
  });
  scanner.schedule('session');
  await vi.advanceTimersByTimeAsync(150);
  for (let i = 0; i < 20; i++) scanner.schedule('session');
  await vi.advanceTimersByTimeAsync(150);
  expect(gates).toHaveLength(1);
  gates[0](['removed-folder/repo']);
  await vi.advanceTimersByTimeAsync(0);
  expect(applied).toEqual([]);
  expect(gates).toHaveLength(2);
  gates[1](['remaining-folder/repo']);
  await vi.advanceTimersByTimeAsync(0);
  expect(applied).toEqual([['remaining-folder/repo']]);
});

it('forget drops in-flight results and queued rescans', async () => {
  vi.useFakeTimers();
  let resolve!: (value: string[]) => void;
  const applied: string[][] = [];
  const scanner = createRepoScanScheduler({
    scan: () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
    apply: (_id, repos) => applied.push(repos),
    onError: () => {},
  });
  scanner.schedule('session');
  await vi.advanceTimersByTimeAsync(150);
  scanner.schedule('session');
  scanner.forget('session');
  resolve(['repo']);
  await vi.advanceTimersByTimeAsync(300);
  expect(applied).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
