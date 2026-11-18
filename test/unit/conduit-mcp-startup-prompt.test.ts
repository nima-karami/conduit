import { describe, expect, it, vi } from 'vitest';
import { MCP_ADAPTERS } from '../../src/conduit-mcp/adapters';
import { isStartupPrompt, waitForStartup } from '../../src/conduit-mcp/startup-prompt';
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

describe('bounded startup wait', () => {
  it('skips or trims the wait to leave time for the screen read', async () => {
    const signal = new AbortController().signal;
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await waitForStartup({ signal, deadlineMs: 1000 }, () => 0, sleep)).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
    expect(await waitForStartup({ signal, deadlineMs: 2500 }, () => 0, sleep)).toBe(true);
    expect(sleep).toHaveBeenCalledWith(1500, signal);
  });
  it('ends promptly when cancelled even if the delay has not finished', async () => {
    const controller = new AbortController();
    const waiting = waitForStartup(
      { signal: controller.signal },
      () => 0,
      () => new Promise(() => {}),
    );
    controller.abort();
    await expect(waiting).resolves.toBe(false);
  });
});
