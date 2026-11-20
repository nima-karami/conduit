import { describe, expect, it } from 'vitest';
import type { ConversationReference, SessionNamingState } from '../../src/contracts/agent-identity';
import { parseSessions } from '../../src/persistence';

const legacy = { id: 'session', home: '/workspace', name: 'Review', agentId: 'claude' };

function restore(entry: Record<string, unknown>) {
  const result = parseSessions(JSON.stringify({ version: 1, sessions: [entry] }));
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('Expected an existing session');
  return result.sessions[0];
}

describe('agent identity persistence compatibility', () => {
  it('keeps a previously locked Claude label when migrating to coupled naming', () => {
    const namingState: SessionNamingState = {
      version: 1,
      name: 'Review',
      revision: 0,
      naming: 'coupled',
      nativeSync: { status: 'pending' },
    };
    expect(restore({ ...legacy, titleLocked: true })).toMatchObject({ namingState });
  });

  it('allows legacy shells to follow titles only when their name looks like the default', () => {
    const shell = { ...legacy, agentId: 'shell' };
    expect(restore(shell)).toMatchObject({
      namingState: { naming: 'decoupled', followTerminalTitle: false },
    });
    expect(restore({ ...shell, name: 'workspace' })).toMatchObject({
      namingState: { naming: 'decoupled', followTerminalTitle: true },
    });
    expect(restore({ ...shell, name: 'workspace', titleLocked: true })).toMatchObject({
      namingState: { naming: 'decoupled', followTerminalTitle: false },
    });
  });

  it('keeps the session but drops an unsupported conversation reference version', () => {
    const ref: ConversationReference = {
      version: 1,
      adapterId: 'claude',
      conversationId: '0fa294cd-2c72-4bc5-b09c-2b65dd1f5588',
      scope: { cwd: '/workspace', storageHome: '/home/example/.claude', machineId: 'local' },
      capturedAt: { generation: 1, launchId: 'a'.repeat(32) },
    };
    expect(restore({ ...legacy, conversationRef: ref })).toHaveProperty('conversationRef', ref);
    const restored = restore({ ...legacy, conversationRef: { ...ref, version: 9 } });
    expect(restored).toMatchObject({ id: legacy.id, name: legacy.name });
    expect(restored).not.toHaveProperty('conversationRef');
  });
});
