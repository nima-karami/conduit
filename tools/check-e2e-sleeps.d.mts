export function toPosixRel(rel: string): string;
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
export function run(opts: {
  root: string;
  baselinePath: string;
  update?: boolean;
  log?: (message: string) => void;
}): { exitCode: number };
