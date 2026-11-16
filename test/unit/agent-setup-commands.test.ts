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

  it('uses the plan decision 3 linux commands', () => {
    expect(setupCommand('claude', 'linux', 'install')).toBe(
      `curl -fsSL https://claude.ai/install.sh | bash${DONE}`,
    );
    expect(setupCommand('codex', 'linux', 'install')).toBe(
      `npm install -g --prefix "$HOME/.local" @openai/codex${DONE}`,
    );
    expect(setupCommand('cursor', 'linux', 'install')).toBe(
      `curl https://cursor.com/install -fsS | bash${DONE}`,
    );
    expect(setupCommand('opencode', 'linux', 'install')).toBe(
      `curl -fsSL https://opencode.ai/install | bash${DONE}`,
    );
    expect(setupCommand('claude', 'linux', 'login')).toBe(`claude${DONE}`);
    expect(setupCommand('codex', 'linux', 'login')).toBe(`codex login --device-auth${DONE}`);
    expect(setupCommand('cursor', 'linux', 'login')).toBe(`cursor-agent login${DONE}`);
    expect(setupCommand('opencode', 'linux', 'login')).toBe(`opencode auth login${DONE}`);
  });

  it('gives claude its documented Windows installer, and a not-available pause for the rest', () => {
    expect(setupCommand('claude', 'windows', 'install')).toBe(
      'irm https://claude.ai/install.ps1 | iex',
    );
    for (const cli of ['codex', 'cursor', 'opencode'] as const) {
      for (const step of STEPS) {
        expect(setupCommand(cli, 'windows', step)).toBe(
          'echo Not available on Windows yet & pause',
        );
      }
    }
  });
});
