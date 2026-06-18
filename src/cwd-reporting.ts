/**
 * Cwd-reporting augmentation for recognized shells (E2b).
 *
 * Host-only module — pure, no I/O. Returns the additive spawn augmentation
 * (extra args and/or env vars) that causes a shell to emit an OSC 9;9 cwd
 * report on each prompt, so `cd` re-roots the Files + Changes views even for
 * shells that do NOT natively emit a cwd sequence.
 *
 * Only shells whose ids start with `shell:` are eligible. The augmentation is
 * guard-gated so it is NEVER applied when:
 *   - the agentId is undefined (fallback shell) or does not start with `shell:`
 *   - trackCwd is false (the caller is responsible for the gate)
 *   - PowerShell already has a -Command/-File/-EncodedCommand in baseArgs
 *     (don't clobber a user-configured command)
 *
 * PowerShell's hook is delivered as a launch arg (`-NoExit -Command <hook>`), which
 * runs silently after the profile loads. It is deliberately NOT typed into the
 * shell's stdin: PSReadLine echoes injected input, so the whole hook would appear as
 * a visible "command" at the first prompt. (The STATUS_CONTROL_C_EXIT crash once
 * blamed on this launch arg was actually a pseudoconsole resize during startup, fixed
 * in pty-host.ts — see SETTLE_FALLBACK_MS.)
 */

const PS_INIT =
  `$o=$function:prompt; function global:prompt { ` +
  `$p=$ExecutionContext.SessionState.Path.CurrentLocation.ProviderPath; ` +
  `[Console]::Write([char]27 + ']9;9;' + $p + [char]7); ` +
  `if($o){& $o}else{'PS ' + $p + '> '} }`;

/** Flags that indicate PowerShell is being used with a one-shot command — don't inject. */
const PS_COMMAND_FLAGS = ['-command', '-c', '-file', '-encodedcommand'];

function hasPsCommandFlag(args: string[]): boolean {
  return args.some((a) => PS_COMMAND_FLAGS.includes(a.toLowerCase()));
}

/**
 * Return the additive spawn augmentation for a recognized shell, or `null`
 * when no injection applies.
 *
 * @param agentId  The agent id (e.g. `shell:pwsh`), or undefined for fallback shells.
 * @param baseArgs The shell's base argument list (as returned by detectShells / registry).
 */
export function cwdReportingAugmentation(
  agentId: string | undefined,
  baseArgs: string[],
): { args?: string[]; env?: Record<string, string> } | null {
  if (!agentId?.startsWith('shell:')) return null;

  switch (agentId) {
    case 'shell:pwsh':
    case 'shell:powershell': {
      // Guard: if baseArgs already carries -Command/-File/-EncodedCommand, skip.
      if (hasPsCommandFlag(baseArgs)) return null;
      return { args: ['-NoExit', '-Command', PS_INIT] };
    }

    case 'shell:bash':
    case 'shell:gitbash': {
      // Prepend to any inherited PROMPT_COMMAND.
      const emit = `printf '\\033]9;9;%s\\007' "$PWD"`;
      return { env: { PROMPT_COMMAND: `${emit}; \${PROMPT_COMMAND:-}` } };
    }

    default:
      // zsh, fish, sh, cmd, wsl — not injected in v1.
      return null;
  }
}
