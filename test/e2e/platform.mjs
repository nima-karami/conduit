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

/**
 * A POSIX path as a Monaco `uri.path` would compare it: separators normalised to `/`, a leading
 * `/` ensured, and lowercased only on win32, the one platform whose paths are case-insensitive.
 * @param {string} p
 * @param {string} [platform]
 */
export function uriPathKey(p, platform = process.platform) {
  let s = String(p).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  return platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * The prompt a shell ends its line with: cmd.exe's `>` on win32, `$`/`#` everywhere else. Exposed
 * as a RegExp so a page-side waitForFunction can receive its source.
 * @param {string} [platform]
 * @returns {RegExp}
 */
export function shellPromptPattern(platform = process.platform) {
  return platform === 'win32' ? />\s*$/ : /[$#]\s*$/;
}

/**
 * @param {string} line
 * @param {string} [platform]
 */
export function isShellPromptLine(line, platform = process.platform) {
  return shellPromptPattern(platform).test(line);
}

/** The file-manager menu label; mirrors src/platform-words.ts (e2e cannot import TS). */
export function revealLabel(platform = process.platform) {
  if (platform === 'win32') return 'Reveal in Explorer';
  if (platform === 'darwin') return 'Reveal in Finder';
  return 'Show in Files';
}
