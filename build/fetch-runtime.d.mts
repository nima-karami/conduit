export interface RuntimePin {
  version: string;
  url: string;
  sha256: string;
  /** Path under the vendor dir: the file itself, or the dir an archive is extracted into. */
  dest: string;
  archive?: 'zip' | 'tar.gz';
  stripComponents?: number;
  /** Archive entries renamed after extraction, `{ from: to }`. */
  rename?: Record<string, string>;
}
export interface FetchDeps {
  vendorDir: string;
  download?: (url: string, file: string) => Promise<void>;
  extractZip?: (zip: string, dir: string) => Promise<void>;
  extractTar?: (archive: string, dir: string, stripComponents: number) => Promise<void>;
}
export function ensurePinned(pin: RuntimePin, deps: FetchDeps): Promise<'skipped' | 'fetched'>;
export function fetchRuntime(
  options: FetchDeps & {
    pins: Record<string, Record<string, RuntimePin>>;
    platform?: NodeJS.Platform;
    arch?: string;
    log?: (line: string) => void;
  },
): Promise<void>;
