import { describe, expect, it } from 'vitest';
import {
  type GrantsFile,
  type PolicyFile,
  parseGrantsFile,
  parsePolicyFile,
  serializeGrantsFile,
  serializePolicyFile,
} from '../../src/conduit-mcp/policy-file';
import type { Decision, ToolRule } from '../../src/conduit-mcp/policy-types';
import { TOOL_NAMES, type ToolName } from '../../src/conduit-mcp/tool-policy';

const rule = (decision: Decision = 'allow'): ToolRule => ({
  decision,
  when: null,
  reach: null,
  move: null,
});

function rulesFor(decision: Decision = 'allow'): Record<ToolName, ToolRule> {
  const out: Partial<Record<ToolName, ToolRule>> = {};
  for (const tool of TOOL_NAMES) out[tool] = rule(decision);
  return out as Record<ToolName, ToolRule>;
}

const validFile = (): PolicyFile => ({
  version: 1,
  profiles: [{ id: 'p-1', name: 'Mine', builtIn: false, rules: rulesFor('ask') }],
  assignments: [
    {
      point: { kind: 'cli', cli: 'claude' },
      assignment: {
        profileId: 'worker',
        exceptions: [
          {
            tool: 'send_message',
            scope: { kind: 'folder', path: '/w' },
            rule: { decision: 'deny' },
          },
          { tool: 'open_file', scope: { kind: 'path', path: '/w/a.ts' }, rule: { when: 'always' } },
          { tool: 'read_inbox', scope: { kind: 'space', projectId: 'p1' }, rule: { move: 'no' } },
          { tool: 'list_agents', scope: { kind: 'session', sessionId: 's1' }, rule: {} },
          { tool: 'focus_session', scope: { kind: 'anywhere' }, rule: { reach: 'any' } },
        ],
        onScreenOnly: true,
      },
    },
    {
      point: { kind: 'peer', machineId: 'm-9' },
      assignment: { profileId: 'lead', exceptions: [], onScreenOnly: false },
    },
    {
      point: { kind: 'session', sessionId: 's1' },
      assignment: { profileId: 'p-1', exceptions: [], onScreenOnly: false },
    },
    {
      point: { kind: 'default' },
      assignment: { profileId: 'observer', exceptions: [], onScreenOnly: false },
    },
  ],
  overrides: [
    {
      id: 'o1',
      sessionId: 's1',
      tool: 'open_file',
      target: { sessionId: null, path: '/w/a.ts', projectId: null },
      createdAt: '2026-11-14T12:00:00.000Z',
    },
  ],
  migratedFrom: 'v0.64',
  notes: { onScreenOnlyOffered: ['s1'] },
});

describe('policy file', () => {
  it('round-trips a policy file', () => {
    const file = validFile();
    const text = serializePolicyFile(file);
    expect(text).toBe(`${JSON.stringify(file, null, 2)}\n`);
    expect(parsePolicyFile(text)).toEqual({ ok: true, file });
  });

  it('corrupt → corrupt, version 2 → newer', () => {
    expect(parsePolicyFile('{not json')).toEqual({ ok: false, reason: 'corrupt' });
    expect(parsePolicyFile('[]')).toEqual({ ok: false, reason: 'corrupt' });
    expect(parsePolicyFile('{"version":"1"}')).toEqual({ ok: false, reason: 'corrupt' });
    expect(parsePolicyFile('{"version":0}')).toEqual({ ok: false, reason: 'corrupt' });
    expect(parsePolicyFile('{"version":2}')).toEqual({ ok: false, reason: 'newer' });
    const newer = serializePolicyFile(validFile()).replace('"version": 1', '"version": 2');
    expect(parsePolicyFile(newer)).toEqual({ ok: false, reason: 'newer' });
  });

  it('an invalid entry makes the whole file corrupt', () => {
    const valid = serializePolicyFile(validFile());
    expect(parsePolicyFile(valid).ok).toBe(true);
    const mutations: Array<[string, string, string]> = [
      ['profile id', '"id": "p-1"', '"id": "custom"'],
      ['decision', '"decision": "ask"', '"decision": "maybe"'],
      ['exception when', '"when": "always"', '"when": "never"'],
      ['scope kind', '"kind": "folder"', '"kind": "galaxy"'],
      ['point cli', '"cli": "claude"', '"cli": "vim"'],
      ['point kind', '"kind": "default"', '"kind": "global"'],
      ['exception tool', '"tool": "send_message"', '"tool": "nope"'],
      ['override tool', '"tool": "open_file"', '"tool": "open_terminal_now"'],
      ['migratedFrom', '"migratedFrom": "v0.64"', '"migratedFrom": "v0.9"'],
      ['onScreenOnly type', '"onScreenOnly": true', '"onScreenOnly": "yes"'],
      ['override path type', '"path": "/w/a.ts"', '"path": 5'],
      ['unknown top-level key', '"version": 1,', '"version": 1,\n  "extra": true,'],
    ];
    for (const [label, from, to] of mutations) {
      const text = valid.replace(from, to);
      expect(text, label).not.toBe(valid);
      expect(parsePolicyFile(text), label).toEqual({ ok: false, reason: 'corrupt' });
    }
  });

  const validGrants = (): GrantsFile => ({
    version: 1,
    grants: [
      {
        id: 'g1',
        who: { kind: 'session', sessionId: 's1' },
        tool: 'send_message',
        on: { kind: 'anywhere' },
        for: 'session-end',
        anchorSessionId: 's1',
        createdAt: '2026-11-14T12:00:00.000Z',
        expiresAt: null,
        lastUsedAt: '2026-11-14T12:05:00.000Z',
        state: 'active',
        endedAt: null,
        requestId: null,
      },
      {
        id: 'g2',
        who: { kind: 'cli', cli: 'codex' },
        tool: 'read_inbox',
        on: { kind: 'folder', path: '/w' },
        for: '1h',
        anchorSessionId: null,
        createdAt: '2026-11-14T12:00:00.000Z',
        expiresAt: '2026-11-14T13:00:00.000Z',
        lastUsedAt: null,
        state: 'expired',
        endedAt: '2026-11-14T13:00:00.000Z',
        requestId: 'r1',
      },
      {
        id: 'g3',
        who: { kind: 'peer', machineId: 'm-9' },
        tool: 'open_file',
        on: { kind: 'path', path: '/w/a.ts' },
        for: 'until-revoked',
        anchorSessionId: null,
        createdAt: '2026-11-14T12:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
        state: 'revoked',
        endedAt: '2026-11-14T12:30:00.000Z',
        requestId: null,
      },
    ],
  });

  it('round-trips a grants file', () => {
    const file = validGrants();
    const text = serializeGrantsFile(file);
    expect(text).toBe(`${JSON.stringify(file, null, 2)}\n`);
    expect(parseGrantsFile(text)).toEqual({ ok: true, file });
  });

  it('grants file: invalid grant → corrupt, version 2 → newer', () => {
    const valid = serializeGrantsFile(validGrants());
    expect(parseGrantsFile(valid).ok).toBe(true);
    const mutations: Array<[string, string, string]> = [
      ['state', '"state": "active"', '"state": "frozen"'],
      ['for', '"for": "1h"', '"for": "2h"'],
      ['createdAt', '"createdAt": "2026-11-14T12:00:00.000Z"', '"createdAt": "yesterday"'],
      ['who kind', '"kind": "cli"', '"kind": "robot"'],
      ['tool', '"tool": "read_inbox"', '"tool": "nope"'],
      ['requestId type', '"requestId": "r1"', '"requestId": 4'],
      ['endedAt', '"endedAt": "2026-11-14T13:00:00.000Z"', '"endedAt": "later"'],
      ['who cli value', '"cli": "codex"', '"cli": "vim"'],
      ['unknown key', '"requestId": "r1"', '"requestId": "r1", "extra": true'],
    ];
    for (const [label, from, to] of mutations) {
      const text = valid.replace(from, to);
      expect(text, label).not.toBe(valid);
      expect(parseGrantsFile(text), label).toEqual({ ok: false, reason: 'corrupt' });
    }
    expect(parseGrantsFile(valid.replace('"version": 1', '"version": 2'))).toEqual({
      ok: false,
      reason: 'newer',
    });
  });
});
