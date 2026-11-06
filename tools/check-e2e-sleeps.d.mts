export function countSleeps(source: string): number;
export function compareToBaseline(
  counts: Record<string, number>,
  baseline: Record<string, number>,
): {
  ok: boolean;
  over: { file: string; count: number; allowed: number }[];
  under: { file: string; count: number; allowed: number }[];
};
export function currentSleepCounts(projectRoot?: string): Record<string, number>;
