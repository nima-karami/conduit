// herdr-core's framed mode (its schema/README.md "Framed mode"), used by the hc client (C3) and the
// app's terminal link (C5). C2 is plain JSON-RPC lines and does not use it (D5).

export const FRAME_HEADER_BYTES = 9;
export const FRAME_MAX_PAYLOAD = 16 * 1024 * 1024;
export const CONTROL_CHANNEL = 0;
export const INITIAL_STREAM_CREDIT = 256 * 1024;

export const FrameKind = {
  Data: 0,
  Credit: 1,
  Close: 2,
  Resize: 3,
  Focus: 4,
  Facts: 5,
} as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

/** Header: channel u32 LE · kind u8 · len u32 LE. */
export interface Frame {
  channel: number;
  kind: FrameKind;
  payload: Uint8Array;
}

/** CLOSE payload sent by the side that ends a stream; empty when a viewer detaches. */
export interface CloseReason {
  reason: TerminalEndReason | 'detached';
  exit_code?: number | null;
  signal?: number | null;
}

export type TerminalEndReason =
  | 'exited'
  | 'killed'
  | 'server_stop'
  | 'host_shutdown'
  | 'holder_lost'
  | 'stopped_by_restart'
  | 'signaled';

/** FACTS payload (hc `Display`). */
export interface DisplayFacts {
  fg?: string | null;
  bg?: string | null;
  cursor?: string | null;
  cell?: [number, number] | null;
}
