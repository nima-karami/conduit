import { describe, expect, it } from 'vitest';
import { cursorEntry } from '../../src/conduit-mcp/cursor-config';
import {
  classifyEntry,
  conduitEntry,
  deepEqualConfig,
  entryTargets,
  isConduitShaped,
  legacyConduitEntry,
  SHIM_LEAF,
} from '../../src/conduit-mcp/install-entries';
import { AGENT_CLIS, type AgentCli } from '../../src/conduit-mcp/install-types';

const EXE = '/app/conduit';
const SHIM = '/app/res/conduit-mcp-shim.cjs';
const OTHER_EXE = '/old/conduit';
const OTHER_SHIM = '/old/res/conduit-mcp-shim.cjs';

/** Literal CLI placeholders, built so no source line holds a template-looking string. */
const dollar = (inner: string) => `$${'{'}${inner}}`;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

describe('install-entries', () => {
  it('claude entry is the §3.4 shape', () => {
    expect(conduitEntry('claude', EXE, SHIM)).toEqual({
      type: 'stdio',
      command: EXE,
      args: [SHIM],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CONDUIT_SESSION_TOKEN: dollar('CONDUIT_SESSION_TOKEN:-'),
        CONDUIT_MCP_ENDPOINT: dollar('CONDUIT_MCP_ENDPOINT:-'),
      },
    });
  });

  it('codex entry forwards both names in env_vars, sets approval auto and a 180 s tool timeout', () => {
    expect(conduitEntry('codex', EXE, SHIM)).toEqual({
      command: EXE,
      args: [SHIM],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      env_vars: ['CONDUIT_SESSION_TOKEN', 'CONDUIT_MCP_ENDPOINT'],
      default_tools_approval_mode: 'auto',
      tool_timeout_sec: 180,
    });
  });

  it('opencode entry command is [exe, shim] with {env:…} placeholders and enabled true (unchanged since v0.50)', () => {
    expect(conduitEntry('opencode', EXE, SHIM)).toEqual({
      type: 'local',
      command: [EXE, SHIM],
      environment: {
        ELECTRON_RUN_AS_NODE: '1',
        CONDUIT_SESSION_TOKEN: '{env:CONDUIT_SESSION_TOKEN}',
        CONDUIT_MCP_ENDPOINT: '{env:CONDUIT_MCP_ENDPOINT}',
      },
      enabled: true,
    });
  });

  it('legacy (v0.50) entries lack only the codex tool timeout; the others are unchanged', () => {
    expect(legacyConduitEntry('codex', EXE, SHIM)).toEqual({
      command: EXE,
      args: [SHIM],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      env_vars: ['CONDUIT_SESSION_TOKEN', 'CONDUIT_MCP_ENDPOINT'],
      default_tools_approval_mode: 'auto',
    });
    for (const cli of ['claude', 'cursor', 'opencode'] as const) {
      expect(legacyConduitEntry(cli, EXE, SHIM)).toEqual(conduitEntry(cli, EXE, SHIM));
    }
  });

  it.each(AGENT_CLIS)('classify: a v0.50 entry is ours, not another Conduit (%s)', (cli) => {
    const expected = conduitEntry(cli, EXE, SHIM);
    const legacy = legacyConduitEntry(cli, EXE, SHIM);
    expect(classifyEntry(cli, clone(legacy), expected, legacy)).toBe('ours');
    // Another build's v0.50 entry is still another Conduit.
    expect(
      classifyEntry(cli, legacyConduitEntry(cli, OTHER_EXE, OTHER_SHIM), expected, legacy),
    ).toBe('other-conduit');
  });

  it('cursor entry equals cursorEntry()', () => {
    expect(conduitEntry('cursor', EXE, SHIM)).toEqual(cursorEntry(EXE, SHIM));
  });

  it.each(AGENT_CLIS)(
    'classify: undefined → absent; equal → ours; other exe same shape → other-conduit; user-authored → conflict (%s)',
    (cli: AgentCli) => {
      const expected = conduitEntry(cli, EXE, SHIM);
      expect(classifyEntry(cli, undefined, expected)).toBe('absent');
      expect(classifyEntry(cli, clone(expected), expected)).toBe('ours');
      expect(classifyEntry(cli, conduitEntry(cli, OTHER_EXE, OTHER_SHIM), expected)).toBe(
        'other-conduit',
      );
      const userAuthored =
        cli === 'opencode'
          ? { type: 'local', command: ['node', '/me/server.js'], enabled: true }
          : { command: 'node', args: ['/me/server.js'] };
      expect(classifyEntry(cli, userAuthored, expected)).toBe('conflict');
      expect(classifyEntry(cli, 'conduit', expected)).toBe('conflict');
      expect(classifyEntry(cli, null, expected)).toBe('conflict');
    },
  );

  // biome-ignore lint/suspicious/noTemplateCurlyInString: names Claude's literal placeholder forms
  it('shape: claude accepts ${VAR} and ${VAR:-}; rejects a missing endpoint placeholder', () => {
    const bare = {
      command: OTHER_EXE,
      args: [OTHER_SHIM],
      env: {
        CONDUIT_SESSION_TOKEN: dollar('CONDUIT_SESSION_TOKEN'),
        CONDUIT_MCP_ENDPOINT: dollar('CONDUIT_MCP_ENDPOINT'),
      },
    };
    expect(isConduitShaped('claude', bare)).toBe(true);
    expect(isConduitShaped('claude', conduitEntry('claude', OTHER_EXE, OTHER_SHIM))).toBe(true);
    expect(
      isConduitShaped('claude', {
        ...bare,
        env: { CONDUIT_SESSION_TOKEN: dollar('CONDUIT_SESSION_TOKEN') },
      }),
    ).toBe(false);
    expect(
      isConduitShaped('claude', {
        ...bare,
        env: { ...bare.env, CONDUIT_MCP_ENDPOINT: 'tcp://x' },
      }),
    ).toBe(false);
    // Claude's syntax is not Cursor's, and vice versa.
    expect(isConduitShaped('claude', cursorEntry(OTHER_EXE, OTHER_SHIM))).toBe(false);
    expect(isConduitShaped('cursor', bare)).toBe(false);
  });

  it('shape: identity forwarding per CLI', () => {
    const codex = conduitEntry('codex', OTHER_EXE, OTHER_SHIM);
    expect(isConduitShaped('codex', { ...codex, env_vars: ['CONDUIT_SESSION_TOKEN'] })).toBe(false);
    expect(isConduitShaped('codex', { ...codex, env_vars: ['CONDUIT_MCP_ENDPOINT'] })).toBe(false);
    expect(
      isConduitShaped('codex', {
        command: OTHER_EXE,
        args: [OTHER_SHIM],
        env_vars: ['X', 'CONDUIT_MCP_ENDPOINT', 'CONDUIT_SESSION_TOKEN'],
      }),
    ).toBe(true);
    const oc = conduitEntry('opencode', OTHER_EXE, OTHER_SHIM);
    expect(isConduitShaped('opencode', { ...oc, environment: {} })).toBe(false);
    expect(isConduitShaped('opencode', { ...oc, command: [OTHER_EXE, '/x/other.cjs'] })).toBe(
      false,
    );
  });

  it('shape: shim leaf compared on the last segment for both separators', () => {
    const win = conduitEntry('claude', 'C:\\x\\Conduit.exe', 'C:\\x\\conduit-mcp-shim.cjs');
    expect(isConduitShaped('claude', win)).toBe(true);
    const lookalike = conduitEntry('claude', EXE, '/x/conduit-mcp-shim.cjs.bak');
    expect(isConduitShaped('claude', lookalike)).toBe(false);
    const dirNamed = conduitEntry('claude', EXE, '/conduit-mcp-shim.cjs/x.cjs');
    expect(isConduitShaped('claude', dirNamed)).toBe(false);
    expect(SHIM_LEAF).toBe('conduit-mcp-shim.cjs');
  });

  it('entryTargets returns command and shim per CLI, null for non-strings', () => {
    for (const cli of AGENT_CLIS) {
      expect(entryTargets(cli, conduitEntry(cli, EXE, SHIM))).toEqual({
        command: EXE,
        shim: SHIM,
      });
    }
    expect(entryTargets('claude', { command: 3, args: [null] })).toEqual({
      command: null,
      shim: null,
    });
    expect(entryTargets('opencode', { command: 'x' })).toEqual({ command: null, shim: null });
    expect(entryTargets('codex', undefined)).toEqual({ command: null, shim: null });
  });

  it('deepEqualConfig ignores key order and compares Dates by time', () => {
    expect(deepEqualConfig({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqualConfig([1, 2], [2, 1])).toBe(false);
    expect(deepEqualConfig({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqualConfig(new Date(5), new Date(5))).toBe(true);
    expect(deepEqualConfig(new Date(5), new Date(6))).toBe(false);
    expect(deepEqualConfig(new Date(5), {})).toBe(false);
    expect(deepEqualConfig({}, [])).toBe(false);
    expect(deepEqualConfig(null, {})).toBe(false);
    expect(deepEqualConfig(Number.NaN, Number.NaN)).toBe(true);
  });
});
