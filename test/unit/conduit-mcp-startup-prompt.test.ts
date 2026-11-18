import { describe, expect, it } from 'vitest';
import { MCP_ADAPTERS } from '../../src/conduit-mcp/adapters';
import { isStartupPrompt } from '../../src/conduit-mcp/startup-prompt';
import idle from './fixtures/conduit-mcp/screens/claude-idle.json';
import permission from './fixtures/conduit-mcp/screens/claude-permission.json';
import trust from './fixtures/conduit-mcp/screens/claude-trust.json';

const claude = MCP_ADAPTERS.find((a) => a.id === 'claude') ?? null;
describe('startup prompt detection', () => {
  it('detects captured Claude trust and permission screens', () => {
    expect(isStartupPrompt(claude, permission, false)).toBe(true);
    expect(isStartupPrompt(claude, trust, false)).toBe(true);
  });
  it('ignores historical prompt text once the composer is idle', () => {
    expect(
      isStartupPrompt(
        claude,
        { ...idle, lines: [...idle.lines.slice(0, 2), '❯ 1. Yes', ...idle.lines.slice(3)] },
        false,
      ),
    ).toBe(false);
  });
  it('ignores historical approval text while the agent is producing output', () => {
    expect(isStartupPrompt(claude, permission, false, true)).toBe(false);
  });

  it('recognizes the same visible prompt after activity becomes quiet', () => {
    expect(isStartupPrompt(claude, permission, false)).toBe(true);
    expect(isStartupPrompt(claude, permission, false, true)).toBe(false);
    expect(isStartupPrompt(claude, permission, false)).toBe(true);
  });
});
