export function coverageDir(env?: Record<string, string | undefined>): string | null;
export function withCoverageEnv<T extends { env?: Record<string, string | undefined> }>(
  launchOpts: T,
): T;
export function executedStarts(
  entries: {
    url: string;
    functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[];
  }[],
): Record<string, number[]>;
export function startCoverage(app: unknown, log?: (...a: unknown[]) => void): void;
export function stopCoverage(app: unknown): Promise<void>;
export function compactHostCoverage(): void;
