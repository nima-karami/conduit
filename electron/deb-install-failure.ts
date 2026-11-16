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

// electron-updater's spawnSyncLog throws `Command <sudo> exited with code <status>`. pkexec
// exits 127 when no polkit authentication agent is available to ask for the password.
const PKEXEC_NO_AGENT = /^Command pkexec exited with code 127$/;

/** POSIX single-quote a path so the copyable command survives spaces and quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Recognises the one install failure a user can fix by hand: a Linux .deb update whose sudo
 * helper could not prompt for a password. Anything else returns null and keeps its plain error.
 */
export function debInstallFailure(input: DebInstallFailureInput): DebInstallFailure | null {
  if (input.platform !== 'linux') return null;
  if (!input.downloadedFile?.toLowerCase().endsWith('.deb')) return null;
  const text = input.error instanceof Error ? input.error.message : String(input.error);
  if (!PKEXEC_NO_AGENT.test(text)) return null;
  return {
    message:
      "Conduit couldn't install this update because your desktop has no password prompt " +
      '(no polkit authentication agent is running). Install it yourself by running this in a terminal:',
    command: `sudo apt install ${shellQuote(input.downloadedFile)}`,
  };
}
