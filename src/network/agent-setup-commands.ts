import type { AgentCli } from '../conduit-mcp/install-types';
import type { AgentSetupStep } from '../contracts/machines';

// The one table of remote commands an owner's setup pane runs (spec F2, RS-D12). Each string is a
// constant the remote shell gets as one argument: no user text is spliced in, so there is nothing
// to quote. Linux rows follow plan decision 3; a Task 0 measurement may change any of them here.

// Holds the pane open after the command so its result is read before the pane closes.
const DONE_SUFFIX = '; echo; echo "[done — press Enter to close]"; read _';
// User-level installers put CLIs in ~/.local/bin, which a non-interactive ssh shell's PATH lacks,
// so a login right after an install would otherwise say "command not found" (CON-47 S review).
const LOCAL_BIN_PATH = 'PATH="$HOME/.local/bin:$PATH"; ';

const LINUX: Record<AgentCli, Record<AgentSetupStep, string>> = {
  claude: {
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    login: 'claude',
  },
  codex: {
    // The Linux installer for Codex is npm; a box without npm shows npm's own error (plan Decisions).
    install: 'npm install -g --prefix "$HOME/.local" @openai/codex',
    login: 'codex login --device-auth',
  },
  cursor: {
    install: 'curl https://cursor.com/install -fsS | bash',
    login: 'cursor-agent login',
  },
  opencode: {
    install: 'curl -fsSL https://opencode.ai/install | bash',
    login: 'opencode auth login',
  },
};

// WHY: the Windows rows are vendor docs that were never measured on a Windows box (plan Spec
// staleness), so only claude's documented installer is written out. The rest say so and wait, so a
// pane never runs a guessed install.
// Win32-OpenSSH may start cmd.exe or PowerShell, so every row names PowerShell itself rather than
// relying on the default shell's syntax, and ends by waiting so the output is read (S review).
const pwsh = (script: string): string =>
  `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script}; Read-Host '[done - press Enter to close]'"`;
const WINDOWS_NOT_AVAILABLE = pwsh("Write-Host 'Not available on Windows yet'");
const WINDOWS: Partial<Record<AgentCli, Partial<Record<AgentSetupStep, string>>>> = {
  claude: { install: pwsh('irm https://claude.ai/install.ps1 | iex'), login: pwsh('claude') },
};

/** The one remote command a setup pane runs for a CLI on an OS at a step. */
export function setupCommand(cli: AgentCli, os: 'linux' | 'windows', step: AgentSetupStep): string {
  if (os === 'windows') return WINDOWS[cli]?.[step] ?? WINDOWS_NOT_AVAILABLE;
  return `${LOCAL_BIN_PATH}${LINUX[cli][step]}${DONE_SUFFIX}`;
}
