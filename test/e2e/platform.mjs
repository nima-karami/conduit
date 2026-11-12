/**
 * Platform rules shared by the e2e harness, the runner and their unit tests. Side-effect-free on
 * purpose: harness.mjs resolves hc and mutates env at import, so unit tests cannot import it.
 * harness.mjs re-exports these.
 */

/** The suite runs on Windows and Linux; macOS SKIPs (CLAUDE.md, e2e rules). */
export function e2ePlatformSupported(platform = process.platform) {
  return platform === 'win32' || platform === 'linux';
}

/** The shell agent a scenario opens when it does not name one. */
export function defaultShellAgent(platform = process.platform) {
  return platform === 'win32' ? 'shell:cmd' : 'shell:bash';
}

/**
 * The SKIP line for a scenario that only makes sense on Windows (cmd.exe, PowerShell, ConPTY,
 * .cmd stubs). Null on win32, where the scenario runs.
 * @param {string} name
 * @param {string} reason what is Windows-specific in this scenario
 * @param {string} [platform]
 * @returns {string | null}
 */
export function windowsOnlySkipMessage(name, reason, platform = process.platform) {
  return platform === 'win32' ? null : `[${name}] SKIP — Windows-only: ${reason}`;
}

/**
 * `stty size` output: "<rows> <cols>" on its own line.
 * @param {string} text
 * @returns {{ rows: number, cols: number } | null}
 */
export function parseSttySize(text) {
  const m = /^\s*(\d+) (\d+)\s*$/m.exec(text);
  return m ? { rows: Number(m[1]), cols: Number(m[2]) } : null;
}
