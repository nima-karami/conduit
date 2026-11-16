import type { AgentCli } from '../conduit-mcp/install-types';
import type { AgentSetupStep } from '../contracts/machines';

// The one table of remote commands an owner's setup pane runs (spec F2, RS-D12). Each string is a
// constant the remote shell gets as one argument: no user text is spliced in, so there is nothing
// to quote. Linux rows follow plan decision 3; a Task 0 measurement may change any of them here.

// Holds the pane open after the command so its result is read before the pane closes.
const DONE_SUFFIX = '; echo; echo "[done — press Enter to close]"; read _';

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
const WINDOWS_NOT_AVAILABLE = 'echo Not available on Windows yet & pause';
const WINDOWS: Partial<Record<AgentCli, Partial<Record<AgentSetupStep, string>>>> = {
  claude: { install: 'irm https://claude.ai/install.ps1 | iex', login: 'claude' },
};

/** The one remote command a setup pane runs for a CLI on an OS at a step. */
export function setupCommand(cli: AgentCli, os: 'linux' | 'windows', step: AgentSetupStep): string {
  if (os === 'windows') return WINDOWS[cli]?.[step] ?? WINDOWS_NOT_AVAILABLE;
  return `${LINUX[cli][step]}${DONE_SUFFIX}`;
}
