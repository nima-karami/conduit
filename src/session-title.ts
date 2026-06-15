import { sessionNameFromPath } from './session-name';

/** A title that is really just a filesystem path (a plain shell sets its window
 * title to the cwd). We keep the nicer folder-derived name instead of these. */
function looksLikePath(t: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(t) || // C:\ or C:/
    /^[\\/]/.test(t) || // /unix or \\unc root
    /[\\/].*[\\/]/.test(t) // two or more separators → a nested path
  );
}

/**
 * Decide whether a terminal-emitted title (OSC 0/2, surfaced by xterm's
 * onTitleChange) should become the session's name. Returns the name to adopt, or
 * null to ignore.
 *
 * This is how an app running inside the terminal drives the Conduit session label —
 * e.g. Claude Code setting its title, or a live `/rename`. Policy:
 *  - ignore empty / very long titles,
 *  - ignore once the user has manually renamed (autoTitle === false) — their choice wins,
 *  - ignore titles that are just the working directory or the project folder name
 *    (a plain shell's cwd title), so we keep the nicer default,
 *  - otherwise adopt the trimmed title.
 */
export function resolveTitleSync(
  session: { name: string; projectPath: string; autoTitle?: boolean },
  rawTitle: string,
): string | null {
  if (session.autoTitle === false) return null;
  const title = (rawTitle ?? '').trim();
  if (!title || title.length > 80) return null;
  if (title === session.name) return null; // already current — no-op
  if (looksLikePath(title)) return null;
  if (title.toLowerCase() === sessionNameFromPath(session.projectPath).toLowerCase()) return null;
  return title;
}
