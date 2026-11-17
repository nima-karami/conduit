export interface NativeModes {
  claude: 'unset' | 'plan' | 'acceptEdits';
  codex: 'unset' | 'read-only' | 'workspace-write';
}

export type NativeFamily = keyof NativeModes;

export type NativeLaunchIntent =
  | { family: NativeFamily; optedIn: boolean; requested: null }
  | {
      family: 'claude';
      optedIn: true;
      requested: { mode: Exclude<NativeModes['claude'], 'unset'> };
    }
  | {
      family: 'codex';
      optedIn: true;
      requested: { sandbox: Exclude<NativeModes['codex'], 'unset'>; approval: 'on-request' };
    };

export interface NativeLaunchEvidence {
  version: 1;
  generation: number;
  launchId: string;
  preparedAt: number;
  intent: NativeLaunchIntent;
}

export type NativeSelection =
  | { status: 'available'; intent: NativeLaunchIntent }
  | { status: 'unavailable' };

export interface NativeSessionUi {
  atLaunch: Pick<NativeLaunchEvidence, 'intent' | 'preparedAt'> | null;
  next: NativeSelection | { status: 'not-applicable' };
}

export type NativeLaunchFailure = 'conflict' | 'unsupported' | 'policy-unavailable' | 'save-failed';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseNativeModes(value: unknown): NativeModes | null {
  if (!record(value)) return null;
  const { claude, codex } = value;
  if (claude !== 'unset' && claude !== 'plan' && claude !== 'acceptEdits') return null;
  if (codex !== 'unset' && codex !== 'read-only' && codex !== 'workspace-write') return null;
  return { claude, codex };
}

export function parseNativeLaunchIntent(value: unknown): NativeLaunchIntent | null {
  if (!record(value)) return null;
  const { family, optedIn, requested } = value;
  if (family !== 'claude' && family !== 'codex') return null;
  if (typeof optedIn !== 'boolean') return null;
  if (requested === null) return { family, optedIn, requested };
  if (!optedIn || !record(requested)) return null;
  if (family === 'claude') {
    const { mode } = requested;
    return mode === 'plan' || mode === 'acceptEdits'
      ? { family, optedIn, requested: { mode } }
      : null;
  }
  const { sandbox, approval } = requested;
  return (sandbox === 'read-only' || sandbox === 'workspace-write') && approval === 'on-request'
    ? { family, optedIn, requested: { sandbox, approval } }
    : null;
}

export function parseNativeLaunchEvidence(value: unknown): NativeLaunchEvidence | null {
  if (!record(value)) return null;
  const { version, generation, launchId, preparedAt } = value;
  if (
    version !== 1 ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    return null;
  if (typeof launchId !== 'string' || !/^[a-f0-9]{32}$/.test(launchId)) return null;
  if (typeof preparedAt !== 'number' || !Number.isFinite(preparedAt) || preparedAt <= 0)
    return null;
  const intent = parseNativeLaunchIntent(value.intent);
  return intent ? { version, generation, launchId, preparedAt, intent } : null;
}
