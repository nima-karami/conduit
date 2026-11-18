import { describe, expect, it } from 'vitest';
import { type NativeSelection, parseNativeLaunchEvidence } from '../../src/contracts/native-launch';
import { prepareNativeLaunch } from '../../src/native-launch';

const claude: NativeSelection = {
  status: 'available',
  intent: { family: 'claude', optedIn: true, requested: { mode: 'plan' } },
};
const codex: NativeSelection = {
  status: 'available',
  intent: {
    family: 'codex',
    optedIn: true,
    requested: { sandbox: 'workspace-write', approval: 'on-request' },
  },
};
const spec = {
  command: '/usr/bin/claude',
  args: ['--add-dir', '/work', '--mcp-config', 'generated'],
  cwd: '/work',
  env: { A: 'b' },
};

describe('native launch argv preparation', () => {
  it('prefixes native args before the accepted model pair and application wiring', () => {
    const model = ['--model', 'opus-4.7'];
    const resolved = { ...spec, args: [...model, ...spec.args] };
    expect(
      prepareNativeLaunch(claude, { command: 'claude', args: model }, resolved, 'linux'),
    ).toEqual({
      ok: true,
      intent: claude.intent,
      spec: { ...resolved, args: ['--permission-mode', 'plan', ...resolved.args] },
    });
    const args = ['-m', 'gpt-6'];
    const command = 'C:\\Tools\\CoDeX.cmd';
    expect(
      prepareNativeLaunch(
        codex,
        { command: 'codex.exe', args },
        { ...spec, command, args },
        'win32',
      ),
    ).toEqual({
      ok: true,
      intent: codex.intent,
      spec: {
        ...spec,
        command,
        args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', ...args],
      },
    });
  });

  it('forwards the same spec for either kind of no-request selection', () => {
    for (const optedIn of [true, false]) {
      const intent = { family: 'claude', optedIn, requested: null } as const;
      const result = prepareNativeLaunch(
        { status: 'available', intent },
        { command: 'wrapper', args: ['--settings=custom'] },
        spec,
        'linux',
      );
      expect(result).toEqual({ ok: true, intent, spec });
      if (result.ok) expect(result.spec).toBe(spec);
    }
  });

  it.each([
    ['claude', ['--permission-mode=acceptEdits']],
    ['claude', ['--settings', 'custom']],
    ['claude', ['--dangerously-skip-permissions']],
  ] as const)('classifies %s native/config overrides as conflicts', (command, args) => {
    expect(prepareNativeLaunch(claude, { command, args: [...args] }, spec, 'linux')).toEqual({
      ok: false,
      problem: 'conflict',
    });
  });

  it.each([
    ['claude.bat', '/usr/bin/claude', []],
    ['claude', '/usr/bin/codex', []],
    ['node', '/usr/bin/claude', []],
    ['claude', '/usr/bin/claude', ['--']],
    ['claude', '/usr/bin/claude', ['install']],
    ['claude', '/usr/bin/claude', ['--model', '--oops']],
  ])('refuses unsupported direct launcher or grammar', (command, resolved, args) => {
    expect(
      prepareNativeLaunch(claude, { command, args }, { ...spec, command: resolved }, 'linux'),
    ).toEqual({ ok: false, problem: 'unsupported' });
  });

  it.each([
    ['/usr/bin/wrapper\\claude', '/usr/bin/claude'],
    ['/usr/bin/claude', '/usr/bin/wrapper\\claude'],
  ])(
    'rejects POSIX backslashes inside a configured or resolved executable basename',
    (command, resolved) => {
      expect(
        prepareNativeLaunch(claude, { command, args: [] }, { ...spec, command: resolved }, 'linux'),
      ).toEqual({ ok: false, problem: 'unsupported' });
    },
  );

  it('refuses known native launch while policy is unavailable', () => {
    expect(
      prepareNativeLaunch(
        { status: 'unavailable' },
        { command: 'claude', args: [] },
        spec,
        'linux',
      ),
    ).toEqual({ ok: false, problem: 'policy-unavailable' });
  });
});

it('passes only known safe evidence through the persisted record validator', () => {
  const raw = {
    version: 1,
    generation: 1,
    launchId: 'a'.repeat(32),
    preparedAt: 30,
    intent: { ...claude.intent, requested: { mode: 'plan', private: '/private' }, token: 'secret' },
    future: ['raw field'],
  };
  expect(parseNativeLaunchEvidence(raw)).toEqual({
    version: 1,
    generation: 1,
    launchId: raw.launchId,
    preparedAt: 30,
    intent: claude.intent,
  });
  for (const invalid of [
    { ...raw, version: 2 },
    { ...raw, preparedAt: Infinity },
    { ...raw, intent: { ...raw.intent, optedIn: false } },
    { ...raw, intent: { ...raw.intent, requested: { mode: 'bypassPermissions' } } },
  ])
    expect(parseNativeLaunchEvidence(invalid)).toBeNull();
});
