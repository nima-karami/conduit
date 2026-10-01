import { afterEach, expect, it, vi } from 'vitest';
import { createSessionResourceDemand } from '../../src/session-resource-demand';

afterEach(() => vi.useRealTimers());

it('a noisy session cannot starve another visible refresh', async () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const demand = createSessionResourceDemand(run);
  demand.setVisible(1, ['quiet', 'noisy']);
  await vi.advanceTimersByTimeAsync(100);
  demand.schedule('noisy');
  await vi.advanceTimersByTimeAsync(50);
  expect(run).toHaveBeenCalledExactlyOnceWith(['quiet', 'noisy']);
  demand.stop();
});

it('keeps foreground ownership across terminal exit and relaunch', async () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const demand = createSessionResourceDemand(run);
  demand.setVisible(1, ['a']);
  demand.clearPending('a');
  demand.schedule('a');
  await vi.advanceTimersByTimeAsync(150);
  expect(run).toHaveBeenCalledExactlyOnceWith(['a']);
  demand.stop();
});

it('invalidates only the last visible consumer and wakes deferred work on restore', async () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const hidden = vi.fn();
  const demand = createSessionResourceDemand(run, hidden);
  demand.setVisible(1, ['a']);
  demand.setVisible(2, ['a']);
  hidden.mockClear();
  demand.setSuspended(1, true);
  expect(hidden).toHaveBeenLastCalledWith([]);
  demand.setSuspended(2, true);
  expect(hidden).toHaveBeenLastCalledWith(['a']);
  await vi.advanceTimersByTimeAsync(150);
  expect(run).not.toHaveBeenCalled();
  demand.setSuspended(2, false);
  await vi.advanceTimersByTimeAsync(150);
  expect(run).toHaveBeenCalledExactlyOnceWith(['a']);
  demand.stop();
});

it('batches shared demand, defers hidden work, and refreshes on return', async () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const demand = createSessionResourceDemand(run);
  demand.setVisible(1, ['a', 'split']);
  demand.schedule('hidden');
  demand.schedule('a');
  await vi.advanceTimersByTimeAsync(150);
  expect(run).toHaveBeenCalledExactlyOnceWith(['a', 'split']);
  demand.setVisible(1, ['hidden']);
  await vi.advanceTimersByTimeAsync(150);
  expect(run).toHaveBeenLastCalledWith(['hidden']);
  demand.stop();
});

it('unions visible windows and drops closed or forgotten consumers', async () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const demand = createSessionResourceDemand(run);
  demand.setVisible(1, ['a']);
  demand.setVisible(2, ['b']);
  demand.dropWindow(1);
  demand.forget('b');
  await vi.advanceTimersByTimeAsync(150);
  expect(run).not.toHaveBeenCalled();
  demand.setVisible(2, ['c']);
  await vi.advanceTimersByTimeAsync(150);
  expect(run).toHaveBeenCalledExactlyOnceWith(['c']);
  demand.stop();
});
