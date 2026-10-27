import { describe, expect, it } from 'vitest';
import {
  CONTROL_TOOL_NAMES,
  coerceMcpTools,
  coerceToolOverrides,
  DEFAULT_MCP_TOOLS,
  effectiveTool,
  effectiveTools,
  gateToolCall,
  isMessagingTool,
  isToolName,
  type McpToolOverrides,
  MESSAGING_TOOL_NAMES,
  TOOL_NAMES,
  withOverride,
} from '../../src/conduit-mcp/tool-switches';

describe('tool-switches', () => {
  it('defaults: messaging on, control off', () => {
    expect(DEFAULT_MCP_TOOLS.open_terminal).toBe(false);
    expect(DEFAULT_MCP_TOOLS.send_message).toBe(true);
    for (const t of MESSAGING_TOOL_NAMES) expect(DEFAULT_MCP_TOOLS[t]).toBe(true);
    for (const t of CONTROL_TOOL_NAMES) expect(DEFAULT_MCP_TOOLS[t]).toBe(false);
  });

  it('catalog is messaging then control; predicates agree', () => {
    expect(TOOL_NAMES).toEqual([...MESSAGING_TOOL_NAMES, ...CONTROL_TOOL_NAMES]);
    expect(isToolName('open_file')).toBe(true);
    expect(isToolName('bogus')).toBe(false);
    expect(isToolName(1)).toBe(false);
    expect(isMessagingTool('read_inbox')).toBe(true);
    expect(isMessagingTool('open_session')).toBe(false);
  });

  it('coerceMcpTools keeps valid keys, defaults the rest, drops unknown', () => {
    expect(coerceMcpTools({ open_file: true, bogus: true, read_inbox: 'yes' })).toEqual({
      ...DEFAULT_MCP_TOOLS,
      open_file: true,
    });
  });

  it('coerceMcpTools of a non-object is the defaults', () => {
    for (const v of [null, [], 'x', undefined, 3])
      expect(coerceMcpTools(v)).toEqual(DEFAULT_MCP_TOOLS);
  });

  it('coerceMcpTools returns a fresh object', () => {
    const a = coerceMcpTools(undefined);
    a.open_file = true;
    expect(DEFAULT_MCP_TOOLS.open_file).toBe(false);
  });

  it('coerceToolOverrides drops non-boolean and unknown, undefined when empty', () => {
    expect(
      coerceToolOverrides({
        open_session: true,
        send_message: false,
        bogus: true,
        open_file: 'yes',
      }),
    ).toEqual({
      open_session: true,
      send_message: false,
    });
    expect(coerceToolOverrides({ bogus: true, open_file: 1 })).toBeUndefined();
    expect(coerceToolOverrides({})).toBeUndefined();
    expect(coerceToolOverrides(null)).toBeUndefined();
    expect(coerceToolOverrides([true])).toBeUndefined();
    expect(coerceToolOverrides('x')).toBeUndefined();
  });

  it('override wins over global; absent inherits', () => {
    expect(effectiveTool({ open_session: true }, DEFAULT_MCP_TOOLS, 'open_session')).toBe(true);
    expect(effectiveTool({ send_message: false }, DEFAULT_MCP_TOOLS, 'send_message')).toBe(false);
    expect(effectiveTool({ send_message: false }, DEFAULT_MCP_TOOLS, 'read_inbox')).toBe(true);
    expect(effectiveTool(undefined, { ...DEFAULT_MCP_TOOLS, open_file: true }, 'open_file')).toBe(
      true,
    );
  });

  it('effectiveTools is in catalog order', () => {
    expect(
      effectiveTools(
        { open_file: true, open_session: true, list_sessions: false },
        DEFAULT_MCP_TOOLS,
      ),
    ).toEqual(['send_message', 'read_inbox', 'read_attachment', 'open_session', 'open_file']);
    expect(effectiveTools(undefined, DEFAULT_MCP_TOOLS)).toEqual([...MESSAGING_TOOL_NAMES]);
  });

  it('withOverride inherit deletes the key and returns undefined when empty; does not mutate', () => {
    const base: McpToolOverrides = { open_session: true };
    const set = withOverride(base, 'open_file', false);
    expect(set).toEqual({ open_session: true, open_file: false });
    expect(base).toEqual({ open_session: true });
    const removed = withOverride(set, 'open_file', 'inherit');
    expect(removed).toEqual({ open_session: true });
    expect(set).toEqual({ open_session: true, open_file: false });
    expect(withOverride(base, 'open_session', 'inherit')).toBeUndefined();
    expect(withOverride(undefined, 'open_session', 'inherit')).toBeUndefined();
    expect(withOverride(undefined, 'open_terminal', true)).toEqual({ open_terminal: true });
  });

  it('gate order', () => {
    expect(
      gateToolCall({ sessionId: null, messagingOn: false, enabled: false, tool: 'open_session' })
        ?.code,
    ).toBe('not_in_session');
    expect(
      gateToolCall({ sessionId: 's1', messagingOn: false, enabled: false, tool: 'open_session' })
        ?.code,
    ).toBe('messaging_off');
    const disabled = gateToolCall({
      sessionId: 's1',
      messagingOn: true,
      enabled: false,
      tool: 'open_terminal',
    });
    expect(disabled?.code).toBe('tool_disabled');
    expect(disabled?.message).toContain('open_terminal');
    expect(disabled?.message).not.toMatch(/settings/i);
    expect(disabled?.retryable).toBe(false);
    expect(
      gateToolCall({ sessionId: 's1', messagingOn: true, enabled: true, tool: 'open_terminal' }),
    ).toBeNull();
  });
});
