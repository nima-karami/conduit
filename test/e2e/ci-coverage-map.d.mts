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
  schema: 2;
  builtFrom: string;
  scenarios: Record<string, { builtFrom: string; files: Record<string, Span[]> }>;
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
export function mergeCoverageMaps(
  prev: { schema?: number; scenarios?: Record<string, unknown> } | null,
  shardMaps: Record<string, Record<string, Span[]>>[],
  sha: string,
  statuses: Record<string, string>,
): CoverageMap;
