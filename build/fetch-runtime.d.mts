export interface RuntimePin {
  version: string;
  url: string;
  sha256: string;
  /** Path under the vendor dir: the file itself, or the dir an archive is extracted into. */
  dest: string;
  archive?: 'zip';
  /** Archive entries renamed after extraction, `{ from: to }`. */
  rename?: Record<string, string>;
}
export interface FetchDeps {
  vendorDir: string;
  download?: (url: string, file: string) => Promise<void>;
  extractZip?: (zip: string, dir: string) => Promise<void>;
}
export function ensurePinned(pin: RuntimePin, deps: FetchDeps): Promise<'skipped' | 'fetched'>;
export function fetchRuntime(
  options: FetchDeps & { pins: Record<string, RuntimePin>; log?: (line: string) => void },
): Promise<void>;
