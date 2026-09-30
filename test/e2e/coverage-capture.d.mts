export function coverageDir(env?: Record<string, string | undefined>): string | null;
export function executedRanges(
  entries: {
    url: string;
    functions: {
      functionName: string;
      ranges: { startOffset: number; endOffset: number; count: number }[];
    }[];
  }[],
): Record<string, [number, number][]>;
export function startCoverage(app: unknown, log?: (...a: unknown[]) => void): void;
export function stopCoverage(app: unknown): Promise<void>;
