// Only the surface unit tests import; the harness is untyped JS.
export function ownHc(userDataDir: string, args: string[]): unknown;
export function finishScenario(code: number): Promise<never>;
export function pollUntil<T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
  intervalMs?: number,
): Promise<Exclude<Awaited<T>, false | 0 | '' | null | undefined> | null>;
