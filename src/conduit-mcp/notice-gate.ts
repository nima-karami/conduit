import type { GateClosedReason, ScreenVerdict } from './types';

// Conditions and their order: docs/specs/2026-10-25-conduit-mcp-server.md §2 notice gate.

export const IDLE_QUIET_MS = 3_000;
export const NOTICE_SPACING_MS = 30_000;

export interface GateInput {
  now: number;
  settleMs: number;
  messagingOn: boolean;
  paused: boolean;
  running: boolean;
  spawnedAt: number | undefined;
  connectionLive: boolean;
  busy: boolean;
  /** SessionActivity's output clock (plan ruling 9). */
  lastOutputAt: number | undefined;
  screen: ScreenVerdict;
  hasDraft: boolean;
  lastNoticeAt: number | undefined;
}
export type GateVerdict = { open: true } | { open: false; reason: GateClosedReason };

const OPEN: GateVerdict = { open: true };
const closed = (reason: GateClosedReason): GateVerdict => ({ open: false, reason });
const within = (now: number, at: number | undefined, ms: number) =>
  at !== undefined && now - at < ms;

export function evaluateGate(i: GateInput): GateVerdict {
  if (!i.messagingOn) return closed('off');
  if (i.paused) return closed('paused');
  if (!i.running) return closed('not-running');
  if (i.spawnedAt === undefined || i.now - i.spawnedAt < i.settleMs) return closed('settling');
  if (!i.connectionLive) return closed('no-connection');
  if (i.busy) return closed('busy');
  if (within(i.now, i.lastOutputAt, IDLE_QUIET_MS)) return closed('quiet');
  if (i.screen === 'blocking') return closed('blocking-prompt');
  if (i.screen !== 'empty-input') return closed('no-empty-input');
  if (i.hasDraft) return closed('draft');
  if (within(i.now, i.lastNoticeAt, NOTICE_SPACING_MS)) return closed('spacing');
  return OPEN;
}

export interface EnterRecheckInput {
  messagingOn: boolean;
  paused: boolean;
  running: boolean;
  sameGeneration: boolean;
  connectionLive: boolean;
  screen: ScreenVerdict;
  inputSinceText: boolean;
}

/**
 * Codex 0.164 shows fast-typed text only on a later frame, measured 220–350 ms after the write —
 * past the submit gap — and an Enter sent before that frame becomes a newline in its composer.
 * So the Enter waits for the echo itself, bounded.
 */
export const ECHO_WAIT_MS = 2_000;
export const ECHO_POLL_MS = 50;

/** Re-runs the Enter recheck while its only objection is a missing echo. */
export async function awaitEnterVerdict(
  check: () => Promise<GateVerdict>,
  clock: { now(): number; sleep(ms: number): Promise<void> },
): Promise<{ verdict: GateVerdict; waitedMs: number }> {
  const start = clock.now();
  for (;;) {
    const verdict = await check();
    const waitedMs = clock.now() - start;
    if (verdict.open || verdict.reason !== 'no-echo' || waitedMs >= ECHO_WAIT_MS) {
      return { verdict, waitedMs };
    }
    await clock.sleep(ECHO_POLL_MS);
  }
}

/** Opens only on positive evidence that the notice is what sits in the input (plan ruling 3). */
export function evaluateEnterRecheck(i: EnterRecheckInput): GateVerdict {
  if (!i.messagingOn) return closed('off');
  if (i.paused) return closed('paused');
  if (!i.running || !i.sameGeneration) return closed('not-running');
  if (!i.connectionLive) return closed('no-connection');
  if (i.inputSinceText) return closed('draft');
  if (i.screen === 'blocking') return closed('blocking-prompt');
  if (i.screen !== 'notice-echoed') return closed('no-echo');
  return OPEN;
}
