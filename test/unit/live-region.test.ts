// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import { createLiveAnnouncer } from '../../webview/live-region';

describe('createLiveAnnouncer (final M2)', () => {
  let region: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    region = document.createElement('div');
    document.body.appendChild(region);
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('a repeat of the text already there is cleared first and written a frame later', () => {
    const announce = createLiveAnnouncer(() => region);
    region.textContent = 'claude-1 opened file';
    announce('claude-1 opened file');
    expect(region.textContent).toBe('');
    vi.advanceTimersToNextFrame();
    expect(region.textContent).toBe('claude-1 opened file');
  });

  it('two announcements inside one frame speak only the later', () => {
    const announce = createLiveAnnouncer(() => region);
    announce('claude-1 opened file');
    announce('claude-1 opened Review');
    vi.advanceTimersToNextFrame();
    expect(region.textContent).toBe('claude-1 opened Review');
  });

  it('no region on screen is a no-op', () => {
    const announce = createLiveAnnouncer(() => null);
    expect(() => {
      announce('x');
      vi.advanceTimersToNextFrame();
    }).not.toThrow();
  });
});

describe('MCP_STR.opened (final M4)', () => {
  it('names the agent by its handle', () => {
    expect(MCP_STR.opened('claude-1', 'file')).toBe('claude-1 opened file');
  });

  it('a caller with no handle or name reads as an agent, with no leading space', () => {
    expect(MCP_STR.opened(undefined, 'file')).toBe('An agent opened file');
    expect(MCP_STR.opened('', 'Review')).toBe('An agent opened Review');
  });
});
