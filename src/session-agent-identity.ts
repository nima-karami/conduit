import type {
  AgentIdentityAdapterId,
  ConversationReference,
  SessionLaunchPlan,
  SessionNamingState,
} from './contracts/agent-identity';
import { commandLeaf } from './launch-args';
import { sessionNameFromPath } from './session-name';
import type { Session } from './types';

export const MAX_SESSION_LABEL_CHARS = 80;

export function normalizeSessionLabel(input: string): string | undefined {
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(input)) return undefined;
  const label = input.trim();
  return label && Array.from(label).length <= MAX_SESSION_LABEL_CHARS ? label : undefined;
}

function launcherLeaf(value: string): string {
  return typeof value === 'string'
    ? commandLeaf(value.replace(/^(cli|shell):/, '')).replace(/\.ps1$/i, '')
    : '';
}

export function coupledAdapterId(agentId: string): AgentIdentityAdapterId | undefined {
  const leaf = launcherLeaf(agentId);
  return leaf === 'claude' || leaf === 'codex' ? leaf : undefined;
}

export function isManagedAgent(agentId: string): boolean {
  return /^(claude|codex|cursor-agent|agent|gemini|kiro-cli|opencode|aider)$/.test(
    launcherLeaf(agentId),
  );
}

function isPlainShell(agentId: string): boolean {
  return (
    typeof agentId === 'string' &&
    (agentId.startsWith('shell:') || /^(shell|sh|bash|zsh|fish|pwsh|cmd|powershell)$/.test(agentId))
  );
}

export function initialNaming(
  session: Pick<Session, 'name' | 'agentId'>,
  explicit: boolean,
): SessionNamingState {
  const base = { version: 1 as const, name: session.name, revision: 0 };
  return coupledAdapterId(session.agentId)
    ? { ...base, naming: 'coupled', nativeSync: { status: 'pending' } }
    : {
        ...base,
        naming: 'decoupled',
        followTerminalTitle: isPlainShell(session.agentId) && !explicit,
      };
}

export function restoreNaming(session: Session): SessionNamingState {
  const state = session.namingState;
  const baseline = initialNaming(
    session,
    session.titleLocked === true || session.name !== sessionNameFromPath(session.home),
  );
  if (
    state?.version !== 1 ||
    typeof state.name !== 'string' ||
    !state.name.trim() ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    state.naming !== baseline.naming
  )
    return baseline;
  if (baseline.naming === 'coupled' && state.naming === 'coupled') {
    const status = state.nativeSync?.status;
    return status === 'pending' ||
      status === 'synced' ||
      (status === 'failed' && typeof state.nativeSync.reason === 'string')
      ? state
      : { ...baseline, name: state.name, revision: state.revision };
  }
  if (state.naming === 'decoupled')
    return {
      version: 1,
      name: state.name,
      revision: state.revision,
      naming: 'decoupled',
      followTerminalTitle: isPlainShell(session.agentId) && state.followTerminalTitle === true,
    };
  return baseline;
}

export function validConversationRef(ref: ConversationReference | undefined): boolean {
  return (
    ref?.version === 1 &&
    (ref.adapterId === 'claude' || ref.adapterId === 'codex') &&
    typeof ref.conversationId === 'string' &&
    !!ref.conversationId &&
    typeof ref.scope?.cwd === 'string' &&
    !!ref.scope.cwd &&
    typeof ref.scope.storageHome === 'string' &&
    !!ref.scope.storageHome &&
    typeof ref.scope.machineId === 'string' &&
    !!ref.scope.machineId &&
    Number.isSafeInteger(ref.capturedAt?.generation) &&
    ref.capturedAt.generation > 0 &&
    typeof ref.capturedAt.launchId === 'string' &&
    /^[a-f0-9]{32}$/.test(ref.capturedAt.launchId)
  );
}

export function planSessionLaunch(input: {
  live: boolean;
  managed: boolean;
  previouslyLaunched: boolean;
  startNew: boolean;
  canResume: boolean;
  ref?: ConversationReference;
}): SessionLaunchPlan {
  if (input.live) return { kind: 'attach' };
  if (!input.managed || input.startNew || !input.previouslyLaunched) return { kind: 'fresh' };
  if (!input.canResume) return { kind: 'refused', reason: 'resume-unsupported' };
  if (!input.ref) return { kind: 'refused', reason: 'resume-reference-missing' };
  return { kind: 'resume', ref: input.ref };
}
