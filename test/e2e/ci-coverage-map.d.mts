export interface SegmentIndex {
  generated: string;
  offsets: number[];
  sources: number[];
  lines: number[];
  columns: number[];
  lineCols: Map<number, { min: number; max: number }>;
}
export type Span = [number, number];
export interface CoverageMap {
  schema: 3;
  builtFrom: string;
  scenarios: Record<
    string,
    { builtFrom: string; files: Record<string, Span[]>; alwaysRun?: string }
  >;
}
export interface CoverageMeta {
  launches: number;
  windows: number;
  stopped: number;
  incomplete: string[];
}
export interface ShardEntry {
  files: Record<string, Span[]>;
  complete: boolean;
  alwaysRun?: string | null;
}
export function segmentOffsets(mappings: string, generated: string): SegmentIndex;
export function projectSource(source: string): string | null;
export function mergeSpans(spans: Span[]): Span[];
export function spansForRanges(
  ranges: Span[],
  index: SegmentIndex,
  mapSources: string[],
  cache?: Map<string, unknown>,
): Record<string, Span[]>;
export function scenarioCompleteness(metas: CoverageMeta[]): {
  complete: boolean;
  alwaysRun: string | null;
};
export function mergeCoverageMaps(
  prev: { schema?: number; scenarios?: Record<string, unknown> } | null,
  shardMaps: Record<string, ShardEntry>[],
  sha: string,
  statuses: Record<string, string>,
): CoverageMap;
