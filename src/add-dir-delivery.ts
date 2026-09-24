// Pasting `/add-dir <path>` into a running claude, without Enter (mf-live-edits spec §2.3,
// revised per conductor after real-claude QA). Renderer-safe.

export type AgentScopeReason =
  | 'noSession'
  | 'notRunning'
  | 'notClaude'
  | 'nothingPending'
  | 'busy'
  | 'writeFailed'
  | 'homeMissing';

export type AddDirResult = { ok: true; pasted: string } | { ok: false; reason: AgentScopeReason };

/**
 * The path as typed. claude reads a `\` right before Enter as "insert a newline" (measured,
 * 2.1.282), so a trailing separator is dropped, and a drive root goes in as `D:/`, which claude
 * accepts and prints back as `D:\`.
 */
export function addDirArg(p: string): string {
  if (/^[A-Za-z]:[\\/]+$/.test(p)) return `${p.slice(0, 2)}/`;
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed === '' ? p : trimmed;
}

/**
 * Verbatim and unquoted: claude takes the whole trimmed remainder as the path (spec §0). A
 * bracketed paste is inert at claude's dialogs (measured: its trust and add-directory prompts
 * ignore it), so it is used whenever the child has paste mode on.
 */
export function addDirInput(p: string, bracketedPaste: boolean): string {
  const line = `/add-dir ${addDirArg(p)}`;
  return bracketedPaste ? `\x1b[200~${line}\x1b[201~` : line;
}

export interface AddDirDeps {
  sessionExists: () => boolean;
  isAlive: () => boolean;
  isBusy: () => boolean;
  /** undefined = no scope (not a claude process, or not captured). */
  typeable: () => readonly string[] | undefined;
  bracketedPaste: () => boolean;
  write: (data: string) => boolean;
  onPasted: (path: string) => void;
}

/** One folder per click: the first typeable one claude has not confirmed yet. */
export function runAddDir(deps: AddDirDeps): AddDirResult {
  const fail = (reason: AgentScopeReason): AddDirResult => ({ ok: false, reason });
  if (!deps.sessionExists()) return fail('noSession');
  if (!deps.isAlive()) return fail('notRunning');
  const pending = deps.typeable();
  if (pending === undefined) return fail('notClaude');
  if (pending.length === 0) return fail('nothingPending');
  if (deps.isBusy()) return fail('busy');
  const path = pending[0];
  if (!deps.write(addDirInput(path, deps.bracketedPaste()))) return fail('writeFailed');
  deps.onPasted(path);
  return { ok: true, pasted: path };
}
