export interface DebInstallFailure {
  /** Plain-words explanation for the user. */
  message: string;
  /** Copyable command that installs the same downloaded .deb by hand. */
  command: string;
}

export interface DebInstallFailureInput {
  platform: string;
  /** Path of the downloaded update (`update-downloaded`'s `downloadedFile`), or null if unknown. */
  downloadedFile: string | null;
  error: unknown;
}

// The updater error event carries the exit status alone, which cannot identify the underlying cause.
const PKEXEC_FAILURE = /^Command pkexec exited with code 127$/;

/** POSIX single-quote a path so the copyable command survives spaces and quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Recognises the one install failure a user can fix by hand: a Linux .deb update whose privilege helper failed. Anything else returns null and keeps its plain error.
 */
export function debInstallFailure(input: DebInstallFailureInput): DebInstallFailure | null {
  if (input.platform !== 'linux') return null;
  if (!input.downloadedFile?.toLowerCase().endsWith('.deb')) return null;
  const text = input.error instanceof Error ? input.error.message : String(input.error);
  if (!PKEXEC_FAILURE.test(text)) return null;
  return {
    message:
      "Conduit couldn't install this update. Install it yourself by running this in a terminal:",
    command: `sudo apt install ${shellQuote(input.downloadedFile)}`,
  };
}
