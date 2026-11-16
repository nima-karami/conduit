import { describe, expect, it } from 'vitest';
import { AGENT_CLIS } from '../../src/conduit-mcp/install-types';
import type { AgentSetupStep } from '../../src/contracts/machines';
import { setupCommand } from '../../src/network/agent-setup-commands';

const STEPS: AgentSetupStep[] = ['install', 'login'];
const DONE = '; echo; echo "[done — press Enter to close]"; read _';

describe('setupCommand', () => {
  it('returns a non-empty command with no template placeholder for every CLI, linux and step', () => {
    for (const cli of AGENT_CLIS) {
      for (const step of STEPS) {
        const command = setupCommand(cli, 'linux', step);
        expect(command, `${cli} ${step}`).not.toBe('');
        expect(command, `${cli} ${step}`).not.toContain('${');
      }
    }
  });

  it('suffixes every linux command with the done line, so the owner sees the result before the pane closes', () => {
    for (const cli of AGENT_CLIS) {
      for (const step of STEPS) {
        expect(setupCommand(cli, 'linux', step).endsWith(DONE), `${cli} ${step}`).toBe(true);
      }
    }
  });

  it('uses the plan decision 3 linux commands, with ~/.local/bin on PATH', () => {
    const P = 'PATH="$HOME/.local/bin:$PATH"; ';
    expect(setupCommand('claude', 'linux', 'install')).toBe(
      `${P}curl -fsSL https://claude.ai/install.sh | bash${DONE}`,
    );
    expect(setupCommand('codex', 'linux', 'install')).toBe(
      `${P}npm install -g --prefix "$HOME/.local" @openai/codex${DONE}`,
    );
    expect(setupCommand('cursor', 'linux', 'install')).toBe(
      `${P}curl https://cursor.com/install -fsS | bash${DONE}`,
    );
    expect(setupCommand('opencode', 'linux', 'install')).toBe(
      `${P}curl -fsSL https://opencode.ai/install | bash${DONE}`,
    );
    expect(setupCommand('claude', 'linux', 'login')).toBe(`${P}claude${DONE}`);
    expect(setupCommand('codex', 'linux', 'login')).toBe(`${P}codex login --device-auth${DONE}`);
    expect(setupCommand('cursor', 'linux', 'login')).toBe(`${P}cursor-agent login${DONE}`);
    expect(setupCommand('opencode', 'linux', 'login')).toBe(`${P}opencode auth login${DONE}`);
  });

  it('runs every Windows row through PowerShell itself and waits before closing', () => {
    const wrap = (script: string) =>
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script}; Read-Host '[done - press Enter to close]'"`;
    expect(setupCommand('claude', 'windows', 'install')).toBe(
      wrap('irm https://claude.ai/install.ps1 | iex'),
    );
    expect(setupCommand('claude', 'windows', 'login')).toBe(wrap('claude'));
    for (const cli of ['codex', 'cursor', 'opencode'] as const) {
      for (const step of STEPS) {
        expect(setupCommand(cli, 'windows', step)).toBe(
          wrap("Write-Host 'Not available on Windows yet'"),
        );
      }
    }
  });
});
