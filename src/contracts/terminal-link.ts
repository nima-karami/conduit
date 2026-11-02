// C5 — how the app's main process shows a terminal in a pane. The renderer's `term:*` IPC stays
// byte-compatible; this sits underneath it. The app attaches as an hc `observe` viewer: bytes go
// hc → app directly, but it never types or resizes. Input (xterm's focus reports included), size and
// facts go to the server over C2 (`term.*`), which is the only active viewer (D19).
import type { ReplayRun, TermGeometry } from '../protocol';
import type { TerminalEndReason } from './frames';

/** History lines the app asks for, so scrollback above the screen survives an app relaunch (M18). */
export const APP_ATTACH_HISTORY_LINES = 2000;

/**
 * Returned by the server and opaque to app code: only TerminalLinkFactory reads it, so a remote
 * server would replace the factory, not its callers (D3).
 */
export interface AttachTarget {
  hcSession: string;
  terminal: string;
}

/** Complete when hc's first paint ends, by the same boundary rule as C1's `paint` (D20, M8). */
export interface FirstPaint {
  data: string;
  /** One run at the attach size; the renderer writes it like today's replay. */
  replay: ReplayRun[];
}

export interface TerminalLinkEvents {
  data(data: string): void;
  /**
   * hc's `size` event for this terminal. The app requested that size, so its xterm already has it;
   * a mismatch means another active viewer and is logged.
   */
  size(size: TermGeometry): void;
  /**
   * `restartable`: reattach later. `disconnected` (the app's hc client lost the core) is always
   * restartable, and the app reattaches when its client reconnects (F10); otherwise reattach after the
   * session's next start.
   */
  closed(
    reason: TerminalEndReason | 'detached' | 'disconnected',
    exitCode: number | null,
    restartable: boolean,
  ): void;
}

export interface TerminalLink {
  readonly sessionId: string;
  readonly firstPaint: FirstPaint;
  /** Detach without ending the program. */
  close(): void;
}

export interface TerminalLinkFactory {
  /**
   * An `observe` attach. `size` only fills hc's required cols/rows; an observer never sets the PTY
   * size. `history` is APP_ATTACH_HISTORY_LINES.
   */
  attach(
    sessionId: string,
    target: AttachTarget,
    size: TermGeometry,
    history: number,
    events: TerminalLinkEvents,
  ): Promise<TerminalLink>;
}
