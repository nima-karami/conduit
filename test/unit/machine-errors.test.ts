import { describe, expect, it } from 'vitest';
import { machineToolError } from '../../src/conduit-mcp/machine-errors';
import type { ToolErrorCode } from '../../src/conduit-mcp/types';
import type { MachineError, MachineErrorCode } from '../../src/contracts/machines';

const MACHINE = 'win-box';

describe('machineToolError', () => {
  // One row per MachineErrorCode: the tool code it becomes, whether the caller may retry, and the
  // hint an agent reads (spec 5.2; where the spec gives no hint the wording is ours).
  const rows: Array<{
    error: MachineError;
    code: ToolErrorCode;
    retryable: boolean;
    hint: string;
  }> = [
    {
      error: { code: 'machine_unknown', detail: {} },
      code: 'machine_unknown',
      retryable: false,
      hint: 'name a machine from list_machines, or an ssh Host from your ssh config',
    },
    {
      error: {
        code: 'machine_unknown',
        detail: {},
        candidates: ['m-aaaaaaaa', 'm-bbbbbbbb'],
      },
      code: 'machine_unknown',
      retryable: false,
      hint: 'several machines share that name; retry with one of these ids: m-aaaaaaaa, m-bbbbbbbb',
    },
    {
      error: { code: 'ssh_needs_person', detail: { reason: 'host_key_unknown' } },
      code: 'ssh_needs_person',
      retryable: false,
      hint: `ask the human to connect ${MACHINE} once from Machines`,
    },
    {
      error: { code: 'ssh_unreachable', detail: { detail: 'timeout' } },
      code: 'ssh_unreachable',
      retryable: true,
      hint: 'the machine may be asleep or offline; try again shortly',
    },
    {
      error: { code: 'ssh_auth_failed', detail: {} },
      code: 'ssh_auth_failed',
      retryable: false,
      hint: `the keys for ${MACHINE} were refused; the human must fix ssh access and connect it once from Machines`,
    },
    {
      error: { code: 'remote_unsupported', detail: { os: 'darwin', arch: 'arm64' } },
      code: 'remote_unsupported',
      retryable: false,
      hint: 'Conduit has no build for that platform yet; it runs on linux x64 and windows x64',
    },
    {
      error: { code: 'install_failed', detail: { step: 'checksum', detail: 'mismatch' } },
      code: 'install_failed',
      retryable: true,
      hint: 'the install did not finish at its checksum step; try again shortly',
    },
    {
      error: { code: 'identity_changed', detail: {} },
      code: 'identity_changed',
      retryable: false,
      hint: `${MACHINE}'s identity changed since it was added; the human must confirm it from Machines`,
    },
    {
      error: { code: 'identity_conflict', detail: { machine: 'office-pc' } },
      code: 'identity_conflict',
      retryable: false,
      hint: `this target reaches a machine already added as "office-pc"; connect it by that name`,
    },
    {
      error: { code: 'peer_incompatible', detail: {} },
      code: 'peer_incompatible',
      retryable: false,
      hint: 'the machine runs a Conduit version that cannot talk to this one; update the older side',
    },
  ];

  it.each(rows)('$error.code maps to $code', ({ error, code, retryable, hint }) => {
    const out = machineToolError(error, MACHINE);
    expect(out.code).toBe(code);
    expect(out.retryable).toBe(retryable);
    expect(out.hint).toBe(hint);
    expect(out.message.length).toBeGreaterThan(0);
  });

  it('every MachineErrorCode has a row', () => {
    const all: MachineErrorCode[] = [
      'machine_unknown',
      'ssh_needs_person',
      'ssh_unreachable',
      'ssh_auth_failed',
      'remote_unsupported',
      'install_failed',
      'identity_changed',
      'identity_conflict',
      'peer_incompatible',
    ];
    expect(new Set(rows.map((r) => r.error.code))).toEqual(new Set(all));
  });

  it('an ambiguous name lists its candidate ids in valid, capped as tool errors are', () => {
    const out = machineToolError(
      { code: 'machine_unknown', detail: {}, candidates: ['m-aaaaaaaa', 'm-bbbbbbbb'] },
      MACHINE,
    );
    expect(out.valid).toEqual(['m-aaaaaaaa', 'm-bbbbbbbb']);
  });

  it('ssh_needs_person names the reason it needs a person for', () => {
    const out = machineToolError(
      { code: 'ssh_needs_person', detail: { reason: 'passphrase' } },
      MACHINE,
    );
    expect(out.message).toContain('passphrase');
  });

  it('ssh_unreachable and install_failed are retryable; no other code is', () => {
    const retryable = rows.filter((r) => r.retryable).map((r) => r.code);
    expect(retryable.sort()).toEqual(['install_failed', 'ssh_unreachable']);
  });
});

describe('machineToolError structured fields (spec 5.2)', () => {
  it('ssh_needs_person carries its reason as a field agents can branch on', () => {
    const out = machineToolError(
      { code: 'ssh_needs_person', detail: { reason: 'host_key_changed' } },
      MACHINE,
    );
    expect(out.reason).toBe('host_key_changed');
  });

  it('remote_unsupported carries os and arch as fields', () => {
    const out = machineToolError(
      { code: 'remote_unsupported', detail: { os: 'darwin', arch: 'arm64' } },
      MACHINE,
    );
    expect(out).toMatchObject({ os: 'darwin', arch: 'arm64' });
  });

  it('install_failed carries its step as a field', () => {
    const out = machineToolError(
      { code: 'install_failed', detail: { step: 'download', detail: 'timeout' } },
      MACHINE,
    );
    expect(out.step).toBe('download');
  });

  it('a revoked machine says it was removed from the links, not that no machine exists', () => {
    const out = machineToolError(
      { code: 'machine_unknown', detail: { reason: 'revoked' } },
      MACHINE,
    );
    expect(out.message).toBe(`${MACHINE} was removed from this machine's links`);
    expect(out.code).toBe('machine_unknown');
  });

  it('the structured fields reach the agent in the JSON error payload', async () => {
    const { toToolCallResult } = await import('../../src/conduit-mcp/tools');
    const out = machineToolError(
      { code: 'ssh_needs_person', detail: { reason: 'passphrase' } },
      MACHINE,
    );
    const result = toToolCallResult({ ok: false, error: out });
    expect(result.structuredContent).toMatchObject({ error: { reason: 'passphrase' } });
    const first = result.content[0];
    expect(first.type).toBe('text');
    if (first.type !== 'text') throw new Error('expected a text item');
    expect(JSON.parse(first.text)).toMatchObject({
      error: { code: 'ssh_needs_person', reason: 'passphrase' },
    });
  });
});
