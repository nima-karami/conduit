import type { McpAdapter } from './adapters';
import { type ScreenSnapshot, screenVerdict } from './screen-verdict';

export async function waitForStartup(
  options: { signal: AbortSignal; deadlineMs?: number },
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const remaining = (options.deadlineMs ?? Infinity) - now();
  if (options.signal.aborted || remaining <= 1000) return false;
  const wait = Math.min(3000, remaining - 1000);
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      options.signal.removeEventListener('abort', done);
      resolve();
    };
    options.signal.addEventListener('abort', done, { once: true });
    void sleep(wait).then(done, (err: unknown) => {
      options.signal.removeEventListener('abort', done);
      reject(err);
    });
  });
  return !options.signal.aborted && now() < (options.deadlineMs ?? Infinity);
}

export function isStartupPrompt(
  adapter: McpAdapter | null,
  snap: ScreenSnapshot,
  stuck: boolean,
  busy = false,
): boolean {
  if (busy) return false;
  if (adapter?.screen && screenVerdict({ ...adapter.screen, blocking: [] }, snap) === 'empty-input')
    return false;
  return (
    stuck ||
    (adapter?.startupPrompts?.some((pattern) => snap.lines.some((line) => pattern.test(line))) ??
      false)
  );
}
