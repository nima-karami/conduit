/**
 * One cold launch per session at a time. term:start awaits between its isAlive re-check and
 * pty.start (the token store behind prepareLaunch), so a second start for the same session would
 * otherwise allocate, prepare and spawn again, resetting the first launch's wiring under its live
 * CLI. The second start joins the first instead and then takes the attach path.
 */
export type LaunchClaim =
  | { kind: 'owner'; release(): void }
  | { kind: 'joined'; settled: Promise<void> };

export interface LaunchClaims {
  /** Synchronous, so nothing can interleave between a caller's re-check and its claim. */
  claim(sessionId: string): LaunchClaim;
}

export function createLaunchClaims(): LaunchClaims {
  const inFlight = new Map<string, Promise<void>>();
  return {
    claim(sessionId) {
      const pending = inFlight.get(sessionId);
      if (pending) return { kind: 'joined', settled: pending };
      let settle = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      inFlight.set(sessionId, settled);
      let released = false;
      return {
        kind: 'owner',
        release() {
          if (released) return;
          released = true;
          inFlight.delete(sessionId);
          settle();
        },
      };
    },
  };
}
