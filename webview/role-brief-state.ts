import { BRIEF_MAX_BYTES, briefByteCount } from '../src/role-brief';
import type { BriefError, BriefRequest } from '../src/types';
import { BRIEF_STR } from './role-brief-strings';

export type BriefMode = 'agent' | 'none' | 'text' | 'file';

export interface BriefDialogState {
  /** false until the host answers for this launcher: an unsupported launcher hides the section. */
  supported: boolean;
  agentHas: boolean;
  agentFirstLine?: string;
  agentPath?: string;
  agentError?: BriefError;
  mode: BriefMode;
  text: string;
  path: string;
  probe:
    | { phase: 'idle' | 'checking' }
    | { phase: 'ok'; bytes: number }
    | { phase: 'error'; error: BriefError };
}

export type BriefAction =
  | {
      type: 'agentPreviewed';
      supported: boolean;
      has: boolean;
      firstLine?: string;
      path?: string;
      error?: BriefError;
    }
  | { type: 'launcherChanged' }
  | { type: 'setMode'; mode: BriefMode }
  | { type: 'setText'; text: string }
  | { type: 'setPath'; path: string }
  | { type: 'probing' }
  | { type: 'probed'; ok: boolean; bytes?: number; error?: BriefError };

export function initialBriefState(): BriefDialogState {
  return {
    supported: false,
    agentHas: false,
    mode: 'none',
    text: '',
    path: '',
    probe: { phase: 'idle' },
  };
}

export function reduceBrief(s: BriefDialogState, a: BriefAction): BriefDialogState {
  switch (a.type) {
    case 'launcherChanged':
      return initialBriefState();
    case 'agentPreviewed':
      return {
        ...s,
        supported: a.supported,
        agentHas: a.has,
        agentFirstLine: a.firstLine,
        agentPath: a.path,
        agentError: a.error,
        // A mode the user already chose outranks the host's default.
        mode: s.mode === 'none' || s.mode === 'agent' ? (a.has ? 'agent' : 'none') : s.mode,
      };
    case 'setMode':
      return { ...s, mode: a.mode };
    case 'setText':
      return { ...s, text: a.text };
    case 'setPath':
      // Checking from the same render: a gap would leave Start enabled for an unprobed path.
      return {
        ...s,
        path: a.path,
        probe: { phase: a.path.trim() === '' ? 'idle' : 'checking' },
      };
    case 'probing':
      return { ...s, probe: { phase: 'checking' } };
    case 'probed':
      return {
        ...s,
        probe: a.ok
          ? { phase: 'ok', bytes: a.bytes ?? 0 }
          : { phase: 'error', error: a.error ?? 'brief-unreadable' },
      };
  }
}

export function briefStartBlock(
  s: BriefDialogState,
  briefBlocked: string | undefined,
): { reason: string } | null {
  if (!s.supported || s.mode === 'none') return null;
  if (briefBlocked !== undefined) return { reason: BRIEF_STR.blocked(briefBlocked) };
  switch (s.mode) {
    case 'agent':
      return s.agentError ? { reason: BRIEF_STR.errors[s.agentError] } : null;
    case 'text':
      if (s.text.trim() === '') return { reason: BRIEF_STR.emptyText };
      return briefByteCount(s.text) > BRIEF_MAX_BYTES
        ? { reason: BRIEF_STR.errors['brief-too-large'] }
        : null;
    case 'file':
      if (s.path.trim() === '') return { reason: BRIEF_STR.emptyFile };
      if (s.probe.phase === 'error') return { reason: BRIEF_STR.errors[s.probe.error] };
      return s.probe.phase === 'ok' ? null : { reason: BRIEF_STR.checking };
  }
}

export function briefRequestOf(s: BriefDialogState): BriefRequest | undefined {
  if (!s.supported) return undefined;
  switch (s.mode) {
    case 'agent':
      return { kind: 'agent' };
    case 'none':
      return { kind: 'none' };
    case 'text':
      return { kind: 'text', text: s.text };
    case 'file':
      return { kind: 'file', path: s.path.trim() };
  }
}
