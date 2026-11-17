import { describe, expect, it } from 'vitest';
import {
  type GrantsFile,
  type PolicyFile,
  parseGrantsFile,
  parsePolicyFile,
  serializeGrantsFile,
  serializePolicyFile,
  validatePolicyAssignment,
  validatePolicyProfile,
  validateRemotePolicyDoc,
} from '../../src/conduit-mcp/policy-file';
import { OBSERVER } from '../../src/conduit-mcp/policy-profiles';
import type { Decision, ToolRule } from '../../src/conduit-mcp/policy-types';
import { TOOL_NAMES, type ToolName } from '../../src/conduit-mcp/tool-policy';
import {
  REMOTE_POLICY_ASSIGNMENTS_MAX,
  REMOTE_POLICY_DOC_MAX_BYTES,
  REMOTE_POLICY_EXCEPTIONS_MAX,
  REMOTE_POLICY_NAME_MAX,
  REMOTE_POLICY_PATH_MAX,
  REMOTE_POLICY_PROFILES_MAX,
} from '../../src/contracts/remote-policy';

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
      target: { sessionId: null, path: '/w/override.ts', folder: '/w', projectId: null },
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

  it('round-trips pinned on a session assignment, and rejects a non-string pin', () => {
    const file = validFile();
    file.assignments.push({
      point: { kind: 'session', sessionId: 's1' },
      assignment: {
        profileId: 'worker',
        exceptions: [],
        onScreenOnly: false,
        pinned: ['send_input.access'],
      },
    });
    const text = serializePolicyFile(file);
    expect(parsePolicyFile(text)).toEqual({ ok: true, file });
    const raw: { assignments: Array<{ assignment: { pinned?: unknown } }> } = JSON.parse(text);
    raw.assignments[raw.assignments.length - 1].assignment.pinned = [1];
    expect(parsePolicyFile(JSON.stringify(raw))).toEqual({ ok: false, reason: 'corrupt' });
  });

  it('normalises pins on read: the default point carries none, cli and session keep theirs, sorted and unique', () => {
    const file = validFile();
    file.assignments = [
      {
        point: { kind: 'default' },
        assignment: {
          profileId: 'worker',
          exceptions: [],
          onScreenOnly: false,
          pinned: ['send_input.access'],
        },
      },
      {
        point: { kind: 'cli', cli: 'claude' },
        assignment: {
          profileId: 'worker',
          exceptions: [],
          onScreenOnly: false,
          pinned: ['send_input.access', 'open_file.access', 'send_input.access'],
        },
      },
      {
        point: { kind: 'session', sessionId: 's1' },
        assignment: {
          profileId: 'worker',
          exceptions: [],
          onScreenOnly: false,
          pinned: ['send_input.access', 'open_file.access', 'send_input.access'],
        },
      },
    ];
    const parsed = parsePolicyFile(serializePolicyFile(file));
    if (!parsed.ok) throw new Error('unreadable');
    expect(parsed.file.assignments[0]?.assignment).not.toHaveProperty('pinned');
    const pinsExpected = ['open_file.access', 'send_input.access'];
    expect(parsed.file.assignments[1]?.assignment.pinned).toEqual(pinsExpected);
    expect(parsed.file.assignments[2]?.assignment.pinned).toEqual(pinsExpected);
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
      ['override path type', '"path": "/w/override.ts"', '"path": 5'],
      ['override folder type', '"folder": "/w"', '"folder": 5'],
      ['override createdAt', '"createdAt": "2026-11-14T12:00:00.000Z"', '"createdAt": "yesterday"'],
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
      ['ended grant with null endedAt', '"endedAt": "2026-11-14T13:00:00.000Z"', '"endedAt": null'],
      ['active grant with endedAt', '"endedAt": null', '"endedAt": "2026-11-14T12:10:00.000Z"'],
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

  it('an unknown field is kept', () => {
    const policy = serializePolicyFile(validFile());
    const policyExtras: Array<[string, string, string]> = [
      ['"version": 1,', '"version": 1,\n  "extra": true,', '"extra": true'],
      ['"id": "p-1"', '"id": "p-1", "futureField": 1', '"futureField": 1'],
      ['"onScreenOnly": true', '"onScreenOnly": true, "futureField": "x"', '"futureField": "x"'],
    ];
    for (const [from, to, kept] of policyExtras) {
      const first = parsePolicyFile(policy.replace(from, to));
      expect(first.ok, from).toBe(true);
      if (!first.ok) continue;
      const text = serializePolicyFile(first.file);
      expect(text, from).toContain(kept);
      expect(parsePolicyFile(text), from).toEqual(first);
    }
    const grants = serializeGrantsFile(validGrants());
    const first = parseGrantsFile(
      grants.replace('"requestId": "r1"', '"requestId": "r1", "extra": 1'),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const text = serializeGrantsFile(first.file);
    expect(text).toContain('"extra": 1');
    expect(parseGrantsFile(text)).toEqual(first);
  });

  it('a profile missing a newer tool parses with that tool at Observer', () => {
    const raw = JSON.parse(serializePolicyFile(validFile()));
    delete raw.profiles[0].rules.open_file;
    raw.profiles[0].rules.future_tool = { decision: 'deny', when: null, reach: null, move: null };
    const parsed = parsePolicyFile(JSON.stringify(raw));
    const rules = parsed.ok ? parsed.file.profiles[0].rules : null;
    expect(rules?.open_file).toEqual(OBSERVER.rules.open_file);
    expect(rules?.open_file.decision).toBe('deny');
    expect(rules?.list_sessions).toEqual(rulesFor('ask').list_sessions);
    expect(rules && 'future_tool' in rules).toBe(false);
  });

  it('mutating a parsed filled rule leaves OBSERVER unchanged', () => {
    const raw = JSON.parse(serializePolicyFile(validFile()));
    delete raw.profiles[0].rules.open_file;
    const parsed = parsePolicyFile(JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    const before = { ...OBSERVER.rules.open_file };
    if (parsed.ok) parsed.file.profiles[0].rules.open_file.decision = 'allow';
    expect(OBSERVER.rules.open_file).toEqual(before);
  });
});

describe('policy file rev', () => {
  it('a file without rev parses with no rev, which the service reads as 0', () => {
    const parsed = parsePolicyFile(serializePolicyFile(validFile()));
    expect(parsed.ok && parsed.file.rev).toBeUndefined();
  });

  it('keeps rev through parse and serialize', () => {
    const parsed = parsePolicyFile(serializePolicyFile({ ...validFile(), rev: 7 }));
    if (!parsed.ok) throw new Error('expected a readable file');
    expect(parsed.file.rev).toBe(7);
    expect(JSON.parse(serializePolicyFile(parsed.file)).rev).toBe(7);
  });

  it.each([-1, 1.5, '3', null])('a rev of %j is corrupt, not read as 0', (rev) => {
    const raw = JSON.parse(serializePolicyFile(validFile()));
    raw.rev = rev;
    expect(parsePolicyFile(JSON.stringify(raw))).toEqual({ ok: false, reason: 'corrupt' });
  });
});

const remoteRule = (decision: Decision = 'ask') => rulesFor(decision);
const remoteProfile = (i: number, over: Record<string, unknown> = {}) => ({
  id: `p-${i}`,
  name: 'Mine',
  builtIn: false,
  rules: remoteRule(),
  ...over,
});
const remoteEntry = (over: Record<string, unknown> = {}) => ({
  point: { kind: 'default' },
  assignment: { profileId: 'worker', exceptions: [], onScreenOnly: false },
  ...over,
});
const remoteDoc = (over: Record<string, unknown> = {}) => ({
  profiles: [],
  assignments: [],
  ...over,
});

function refusal(doc: unknown): string {
  const r = validateRemotePolicyDoc(doc);
  if (r.ok) throw new Error('expected the doc to be refused');
  return r.message;
}

describe('validateRemotePolicyDoc', () => {
  it('accepts a doc at every cap boundary and returns it', () => {
    const profiles = Array.from({ length: REMOTE_POLICY_PROFILES_MAX }, (_, i) =>
      remoteProfile(i, { name: 'n'.repeat(REMOTE_POLICY_NAME_MAX) }),
    );
    const exceptions = Array.from({ length: REMOTE_POLICY_EXCEPTIONS_MAX }, () => ({
      tool: 'open_file',
      scope: { kind: 'path', path: '/'.padEnd(REMOTE_POLICY_PATH_MAX, 'a') },
      rule: { decision: 'deny' },
    }));
    const assignments = [
      remoteEntry({ assignment: { profileId: 'p-0', exceptions, onScreenOnly: false } }),
      ...Array.from({ length: REMOTE_POLICY_ASSIGNMENTS_MAX - 1 }, (_, i) =>
        remoteEntry({ point: { kind: 'peer', machineId: `m-${i}` } }),
      ),
    ];
    const r = validateRemotePolicyDoc(remoteDoc({ profiles, assignments }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.profiles).toHaveLength(REMOTE_POLICY_PROFILES_MAX);
  });

  it('refuses a session point and names its path', () => {
    expect(
      refusal(
        remoteDoc({
          assignments: [remoteEntry({ point: { kind: 'session', sessionId: 's1' } })],
        }),
      ),
    ).toMatch(/^assignments\[0\]\.point/);
  });

  it('refuses a non-object doc', () => {
    expect(refusal(['nope'])).toMatch(/^doc/);
    expect(refusal(null)).toMatch(/^doc/);
  });

  it('refuses a doc over the serialized byte cap', () => {
    const big = remoteDoc({
      assignments: [
        remoteEntry({
          point: { kind: 'cli', cli: 'claude' },
          assignment: {
            profileId: 'worker',
            exceptions: [],
            onScreenOnly: false,
            pinned: ['x'.repeat(REMOTE_POLICY_DOC_MAX_BYTES)],
          },
        }),
      ],
    });
    expect(refusal(big)).toMatch(/^doc too large/);
  });

  it('refuses too many profiles and names profiles', () => {
    const profiles = Array.from({ length: REMOTE_POLICY_PROFILES_MAX + 1 }, (_, i) =>
      remoteProfile(i),
    );
    expect(refusal(remoteDoc({ profiles }))).toMatch(/^profiles /);
  });

  it('refuses too many assignments and names assignments', () => {
    const assignments = Array.from({ length: REMOTE_POLICY_ASSIGNMENTS_MAX + 1 }, (_, i) =>
      remoteEntry({ point: { kind: 'peer', machineId: `m-${i}` } }),
    );
    expect(refusal(remoteDoc({ assignments }))).toMatch(/^assignments /);
  });

  it('refuses too many exceptions on one assignment and names that path', () => {
    const exceptions = Array.from({ length: REMOTE_POLICY_EXCEPTIONS_MAX + 1 }, () => ({
      tool: 'open_file',
      scope: { kind: 'anywhere' },
      rule: { decision: 'deny' },
    }));
    expect(
      refusal(
        remoteDoc({
          assignments: [
            remoteEntry({ assignment: { profileId: 'worker', exceptions, onScreenOnly: false } }),
          ],
        }),
      ),
    ).toMatch(/^assignments\[0\]\.assignment\.exceptions /);
  });

  it('refuses an over-long profile name and names the index', () => {
    const profiles = [
      remoteProfile(0),
      remoteProfile(1),
      remoteProfile(2),
      remoteProfile(3, { name: 'n'.repeat(REMOTE_POLICY_NAME_MAX + 1) }),
    ];
    expect(refusal(remoteDoc({ profiles }))).toBe('profiles[3].name too long');
  });

  it('accepts a name at the length cap and refuses a control character', () => {
    expect(
      validateRemotePolicyDoc(
        remoteDoc({ profiles: [remoteProfile(0, { name: 'n'.repeat(REMOTE_POLICY_NAME_MAX) })] }),
      ).ok,
    ).toBe(true);
    expect(refusal(remoteDoc({ profiles: [remoteProfile(0, { name: 'a\u0007b' })] }))).toBe(
      'profiles[0].name not printable',
    );
    expect(refusal(remoteDoc({ profiles: [remoteProfile(0, { name: '' })] }))).toBe(
      'profiles[0].name empty',
    );
  });

  it('refuses a scope path over the cap and names the exception path', () => {
    const scoped = (path: string) =>
      remoteDoc({
        assignments: [
          remoteEntry({
            assignment: {
              profileId: 'worker',
              onScreenOnly: false,
              exceptions: [
                { tool: 'open_file', scope: { kind: 'folder', path }, rule: { decision: 'deny' } },
              ],
            },
          }),
        ],
      });
    expect(validateRemotePolicyDoc(scoped('/'.padEnd(REMOTE_POLICY_PATH_MAX, 'a'))).ok).toBe(true);
    expect(refusal(scoped('/'.padEnd(REMOTE_POLICY_PATH_MAX + 1, 'a')))).toBe(
      'assignments[0].assignment.exceptions[0].scope.path too long',
    );
  });

  it('refuses a profile that is malformed, naming its path', () => {
    expect(refusal(remoteDoc({ profiles: [remoteProfile(0, { rules: 'x' })] }))).toBe(
      'profiles[0] is malformed',
    );
  });

  it.each(['observer', 'worker', 'lead'])(
    'refuses the built-in profile id %s: a pushed profile is a custom p-* copy',
    (id) => {
      expect(refusal(remoteDoc({ profiles: [remoteProfile(0, { id })] }))).toBe(
        'profiles[0].id is not a custom profile id',
      );
    },
  );

  it('refuses an exception scoped to a session, since session ids never travel', () => {
    expect(
      refusal(
        remoteDoc({
          assignments: [
            remoteEntry({
              assignment: {
                profileId: 'worker',
                onScreenOnly: false,
                exceptions: [
                  {
                    tool: 'open_file',
                    scope: { kind: 'session', sessionId: 's1' },
                    rule: { decision: 'deny' },
                  },
                ],
              },
            }),
          ],
        }),
      ),
    ).toBe('assignments[0].assignment.exceptions[0].scope is session-kind');
  });

  it('refuses an assignment that names an unknown profile', () => {
    expect(
      refusal(
        remoteDoc({
          assignments: [
            remoteEntry({ assignment: { profileId: 'p-9', exceptions: [], onScreenOnly: false } }),
          ],
        }),
      ),
    ).toBe('assignments[0].assignment.profileId unknown');
  });

  it('refuses two assignments on the same point', () => {
    expect(
      refusal(
        remoteDoc({
          assignments: [
            remoteEntry({ point: { kind: 'peer', machineId: 'm-1' } }),
            remoteEntry({ point: { kind: 'peer', machineId: 'm-1' } }),
          ],
        }),
      ),
    ).toBe('assignments[1].point duplicates assignments[0].point');
  });

  it('returns the profiles with complete rules, and drops pins on the default point', () => {
    const r = validateRemotePolicyDoc(
      remoteDoc({
        profiles: [remoteProfile(0)],
        assignments: [
          remoteEntry({
            assignment: {
              profileId: 'p-0',
              exceptions: [],
              onScreenOnly: false,
              pinned: ['send_message.when'],
            },
          }),
        ],
      }),
    );
    if (!r.ok) throw new Error(r.message);
    expect(Object.keys(r.doc.profiles[0]?.rules ?? {}).sort()).toEqual([...TOOL_NAMES].sort());
    expect(r.doc.assignments[0]?.assignment.pinned).toBeUndefined();
  });
});

describe('local owner edit validators', () => {
  it('rejects builtin edits, incomplete rules, invalid values and unprintable names', () => {
    const profile = { ...structuredClone(OBSERVER), id: 'p-copy', name: 'Copy', builtIn: false };
    expect(validatePolicyProfile(profile)).toEqual(profile);
    const circular: Record<string, unknown> = { ...profile };
    circular.extra = circular;
    expect(validatePolicyProfile(circular)).toBeNull();
    expect(validatePolicyProfile(OBSERVER)).toBeNull();
    expect(validatePolicyProfile({ ...profile, builtIn: true })).toBeNull();
    expect(validatePolicyProfile({ ...profile, name: '' })).toBeNull();
    expect(validatePolicyProfile({ ...profile, name: 'x'.repeat(81) })).toBeNull();
    expect(validatePolicyProfile({ ...profile, rules: {} })).toBeNull();
    expect(
      validatePolicyProfile({
        ...profile,
        rules: { ...profile.rules, open_file: { ...profile.rules.open_file, when: 'sometimes' } },
      }),
    ).toBeNull();
  });

  it('validates local scopes and limits and normalizes pins defensively', () => {
    const assignment = {
      profileId: 'worker',
      exceptions: [
        {
          tool: 'open_file',
          scope: { kind: 'session', sessionId: 's1' },
          rule: { decision: 'deny' },
        },
      ],
      onScreenOnly: false,
      pinned: ['open_file.access', 'open_file.access'],
    };
    const entry = validatePolicyAssignment({ kind: 'session', sessionId: 's1' }, assignment);
    expect(entry?.assignment.pinned).toEqual(['open_file.access']);
    expect(entry?.assignment).not.toBe(assignment);
    expect(validatePolicyAssignment({ kind: 'cli', cli: 'fake' }, assignment)).toBeNull();
    expect(
      validatePolicyAssignment(
        { kind: 'default' },
        {
          ...assignment,
          exceptions: [
            {
              tool: 'open_file',
              scope: { kind: 'path', path: 'x'.repeat(1025) },
              rule: { decision: 'deny' },
            },
          ],
        },
      ),
    ).toBeNull();
    expect(
      validatePolicyAssignment({ kind: 'default' }, { ...assignment, onScreenOnly: 'yes' }),
    ).toBeNull();
    expect(
      validatePolicyAssignment({ kind: 'default' }, assignment)?.assignment.pinned,
    ).toBeUndefined();
  });
});
