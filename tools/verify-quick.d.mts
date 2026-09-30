export function quickSteps(o: {
  files: string[];
  base: string;
  cwd: string;
}): { name: string; tool: 'biome' | 'tsc' | 'vitest'; args: string[] }[];
