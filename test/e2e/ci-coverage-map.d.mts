export interface SegmentIndex {
  offsets: number[];
  sources: number[];
}
export interface CoverageMap {
  builtFrom: string;
  scenarios: Record<string, string[]>;
}
export function segmentOffsets(mappings: string, generated: string): SegmentIndex;
export function projectSource(source: string): string | null;
export function sourcesForOffsets(
  starts: number[],
  index: SegmentIndex,
  mapSources: string[],
): Set<string>;
export function mergeCoverageMaps(
  prev: { scenarios?: Record<string, string[]> } | null,
  shardMaps: Record<string, string[]>[],
  sha: string,
): CoverageMap;
