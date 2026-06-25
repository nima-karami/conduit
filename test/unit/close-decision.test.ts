import { describe, expect, it } from 'vitest';
import { shouldConfirmClose } from '../../src/close-decision';

describe('shouldConfirmClose', () => {
  const base = { status: 'running', hasOpenEditors: false, confirmEnabled: true };

  it('does NOT confirm a plain shell with no open editors', () => {
    expect(shouldConfirmClose({ ...base, agentId: 'shell:cmd' })).toBe(false);
    expect(shouldConfirmClose({ ...base, agentId: undefined })).toBe(false);
  });

  it('confirms a running agent session (Claude Code / Codex)', () => {
    expect(shouldConfirmClose({ ...base, agentId: 'claude-code' })).toBe(true);
    expect(shouldConfirmClose({ ...base, agentId: 'codex' })).toBe(true);
  });

  it('confirms a plain shell that owns open editor tabs', () => {
    expect(shouldConfirmClose({ ...base, agentId: 'shell:pwsh', hasOpenEditors: true })).toBe(true);
  });

  it('never confirms when the session is not running', () => {
    expect(shouldConfirmClose({ ...base, status: 'exited', agentId: 'claude-code' })).toBe(false);
    expect(
      shouldConfirmClose({
        ...base,
        status: 'stale',
        agentId: 'claude-code',
        hasOpenEditors: true,
      }),
    ).toBe(false);
  });

  it('never confirms when the setting is off', () => {
    expect(shouldConfirmClose({ ...base, agentId: 'claude-code', confirmEnabled: false })).toBe(
      false,
    );
  });
});
