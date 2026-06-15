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

/** Binaries that commonly run inside a session and set the terminal title (OSC) to
 * the command line — npm/yarn/pnpm are the usual offenders. A title led by one of
 * these is the running command, not a session name. */
const COMMAND_NAMES: ReadonlySet<string> = new Set([
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'bun',
  'deno',
  'node',
  'git',
  'python',
  'python3',
  'py',
  'pip',
  'pip3',
  'poetry',
  'pipenv',
  'ruby',
  'gem',
  'bundle',
  'rake',
  'cargo',
  'rustc',
  'go',
  'make',
  'cmake',
  'gradle',
  'gradlew',
  'mvn',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'vite',
  'webpack',
  'rollup',
  'esbuild',
  'tsc',
  'eslint',
  'prettier',
  'biome',
  'jest',
  'vitest',
  'mocha',
  'playwright',
  'cypress',
  'nodemon',
  'dotnet',
  'dart',
  'flutter',
  'java',
  'javac',
  'gcc',
  'clang',
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'cmd',
]);

/** Ubiquitous subcommand verbs whose presence confirms a command invocation (so a
 * name like "Node project" — no verb/flag/path — is NOT mistaken for one). */
const COMMAND_VERBS: ReadonlySet<string> = new Set([
  'run',
  'install',
  'ci',
  'build',
  'test',
  'start',
  'exec',
  'add',
  'remove',
  'rm',
  'commit',
  'push',
  'pull',
  'fetch',
  'clone',
  'up',
  'down',
  'dev',
  'lint',
  'format',
  'check',
  'serve',
  'watch',
  'init',
  'publish',
  'compose',
  'restore',
  'audit',
  'verify',
  'deploy',
]);

/** Normalize the first token to a bare command name: drop any path prefix and a
 * Windows executable suffix, lowercase it. */
function commandHead(t: string): string {
  const first = t.split(/\s+/)[0] ?? '';
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** A trailing token that marks the title as a command line: a flag, a path, a
 * filename-with-extension, or a known subcommand verb. */
function tokenLooksCommandish(tok: string): boolean {
  return (
    /^-{1,2}\w/.test(tok) || // -m, --flag
    /[\\/]/.test(tok) || // a path arg
    /\.[A-Za-z0-9]+$/.test(tok) || // file.ext
    COMMAND_VERBS.has(tok.toLowerCase())
  );
}

/** True if the title is a command a shell/runner emitted (e.g. "npm run security"),
 * not a session name. Requires a known command head AND either no args (bare command)
 * or a command-like tail — so genuine names beginning with a command word
 * ("Node project dashboard") are still adopted. */
function looksLikeCommand(t: string): boolean {
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (!COMMAND_NAMES.has(commandHead(t))) return false;
  if (tokens.length === 1) return true;
  return tokens.slice(1).some(tokenLooksCommandish);
}

/**
 * Decide whether a terminal-emitted title (OSC 0/2, surfaced by xterm's
 * onTitleChange) should become the session's name. Returns the name to adopt, or
 * null to ignore.
 *
 * This is how an app running inside the terminal drives the Conduit session label —
 * e.g. Claude Code setting its title, or a live `/rename`. Policy:
 *  - ignore empty / very long titles,
 *  - ignore titles that are just the working directory or the project folder name
 *    (a plain shell's cwd title), so we keep the nicer default,
 *  - ignore titles that are a running command line (e.g. "npm run security") that a
 *    runner emitted as the terminal title — that is the command, not a session name,
 *  - otherwise adopt the trimmed title.
 *
 * A meaningful title ALWAYS wins — including over a prior manual rename — so a CLI
 * `/rename` reliably overwrites the session name. (The cwd/folder guards above are
 * what protect a manual name from a plain shell's incidental path title; there is
 * no per-title "manual lock", because we cannot distinguish a deliberate `/rename`
 * from any other app title at the OSC layer, and the user wants `/rename` to win.)
 */
export function resolveTitleSync(
  session: { name: string; projectPath: string },
  rawTitle: string,
): string | null {
  const title = (rawTitle ?? '').trim();
  if (!title || title.length > 80) return null;
  if (title === session.name) return null; // already current — no-op
  if (looksLikePath(title)) return null;
  if (looksLikeCommand(title)) return null; // a running command, not a session name
  if (title.toLowerCase() === sessionNameFromPath(session.projectPath).toLowerCase()) return null;
  return title;
}
