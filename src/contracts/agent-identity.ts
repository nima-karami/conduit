import type { SessionStartResult } from './server-protocol';
import type { LaunchIds } from './terminal-runtime';

export type AgentIdentityAdapterId = 'claude' | 'codex';

export type NativeNameSync =
  | { status: 'pending' }
  | { status: 'synced' }
  | { status: 'failed'; reason: string };

interface SessionNamingBase {
  version: 1;
  name: string;
  revision: number;
}

export type SessionNamingState = SessionNamingBase &
  (
    | { naming: 'coupled'; nativeSync: NativeNameSync }
    | { naming: 'decoupled'; followTerminalTitle: boolean }
  );

export interface ConversationScope {
  cwd: string;
  storageHome: string;
  machineId: string;
}

export interface ConversationReference {
  version: 1;
  adapterId: AgentIdentityAdapterId;
  conversationId: string;
  scope: ConversationScope;
  capturedAt: LaunchIds;
}

export interface AgentIdentityLaunch {
  sessionId: string;
  ids: LaunchIds;
  scope: ConversationScope;
  command: string;
  argv: readonly string[];
  env: Readonly<NodeJS.ProcessEnv>;
  signal: AbortSignal;
}

export interface AgentIdentityCommand {
  /** Replaces the spawn command; Codex wraps its TUI so its App Server lives and dies with the PTY. */
  command?: string;
  argv: readonly string[];
  env?: Readonly<NodeJS.ProcessEnv>;
}

export interface NativeNameEvent {
  conversationId: string;
  name: string;
  source: 'native';
  /** An adapter may attach a revision only when it can attest which host write caused this event. */
  echoRevision?: number;
}

/** Why a bound conversation stopped being trustworthy; the session then shows as decoupled. */
export type IdentityUnbindReason = 'primary-archived' | 'primary-deleted' | 'server-exited';

export interface AgentIdentityObserver {
  bind(conversationId: string): void;
  rename(event: NativeNameEvent): void;
  /** Keeps the last verified resume reference; only live naming stops until the next relaunch. */
  unbind(reason: IdentityUnbindReason): void;
}

export interface AgentIdentityAdapter {
  readonly id: AgentIdentityAdapterId;
  readonly capabilities: { coupledNaming: boolean; exactResume: boolean };
  /** argv is composed here because resume subcommands and variadic flags have different positions. */
  fresh(launch: AgentIdentityLaunch, name: string): Promise<AgentIdentityCommand>;
  /** name is the current Conduit name: Claude re-applies it with --name on resume. */
  resume(
    launch: AgentIdentityLaunch,
    ref: ConversationReference,
    name: string,
  ): Promise<AgentIdentityCommand>;
  exists(ref: ConversationReference): Promise<'present' | 'missing' | 'unavailable'>;
  setName(ref: ConversationReference, name: string, revision: number): Promise<void>;
  /** Register before spawn so an early ID event can be attributed to this generation. */
  observe(launch: AgentIdentityLaunch, observer: AgentIdentityObserver): Promise<void>;
  /**
   * Re-attaches to a live PTY the server adopted after a restart, with its original LaunchIds and saved
   * reference. Closing this observer only detaches; the process in the PTY owns its own children.
   */
  adopt?(
    launch: AgentIdentityLaunch,
    ref: ConversationReference | undefined,
    observer: AgentIdentityObserver,
  ): Promise<void>;
}

export type ResumeRefusalReason =
  | 'resume-reference-missing'
  | 'resume-reference-invalid'
  | 'resume-unsupported'
  | 'resume-scope-mismatch'
  | 'resume-conversation-missing'
  | 'resume-check-unavailable'
  | 'resume-argv-conflict'
  | 'resume-unconfirmed';

export type SessionLaunchPlan =
  | { kind: 'attach' }
  | { kind: 'fresh' }
  | { kind: 'resume'; ref: ConversationReference }
  | { kind: 'refused'; reason: ResumeRefusalReason };

export interface ConversationResumeRefusal {
  reason: 'conversation-resume';
  problem: ResumeRefusalReason;
  refusalId: string;
}

/** The host checks the refusal ID so a delayed or replayed confirmation cannot replace a newer run. */
export interface ResolveConversationResume {
  sessionId: string;
  refusalId: string;
  action: 'retry' | 'start-new';
}

export type ConversationRecoveryResult =
  | SessionStartResult
  | (Omit<Extract<SessionStartResult, { ok: false }>, 'refusal'> & {
      refusal: ConversationResumeRefusal;
    });

export interface ConversationRecoveryMethods {
  'sessions.resolveConversationResume': {
    params: ResolveConversationResume;
    result: ConversationRecoveryResult;
  };
}
