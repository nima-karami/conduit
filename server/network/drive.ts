import type { Capabilities, LinkFrame, LinkState } from '../../src/contracts/link-protocol';
import type { TermGeometry } from '../../src/protocol';
import type { AuditSink } from './audit-log';

// Drive: a person at another machine's GUI types into, resizes, opens and closes my sessions
// (spec §4.1; plan Slice 8 and its handover rulings). It is remote execution, so the serving side
// re-checks my own record of the link on every frame and never trusts the peer's claims.

export type DriveFrame = Extract<
  LinkFrame,
  { t: 'drive.input' | 'drive.resize' | 'drive.open' | 'drive.close' | 'drive.result' }
>;

export interface DriveLink {
  machineId: string;
  state: LinkState;
  /** My record of the link: what I let that machine do. */
  capabilities: Capabilities;
  /** Its record of the link: what it lets me do. */
  peerCapabilities: Capabilities | null;
}

/** Input data larger than this in one frame is refused, not truncated. */
export const DRIVE_INPUT_MAX_BYTES = 64 * 1024;
/** At most one `drive.refused` audit entry per link in this window; never one per keystroke. */
export const DRIVE_REFUSAL_AUDIT_MS = 60_000;
/** `remote.open` / `remote.close` give up waiting for `drive.result` after this. */
export const DRIVE_RESULT_TIMEOUT_MS = 15_000;

export interface DriveDeps {
  links(): DriveLink[];
  /** True only for a live local session (running, with a terminal). */
  liveSession(sessionId: string): boolean;
  /** True only for an id in the domain's registered agents store. */
  agentExists(agentId: string): boolean;
  isDirectory(absolutePath: string): Promise<boolean>;
  /** services.ts `applyHumanInput(id, data, null)`: the C2 human input path. */
  applyHumanInput(sessionId: string, data: string): boolean;
  /** `runtime.resize` then `domain.resized`. */
  resize(sessionId: string, size: TermGeometry): void;
  /** The C2 `sessions.create` + `sessions.start` semantics; resolves to the new session id. */
  openSession(agentId: string, folder: string): Promise<string>;
  /** The C2 `sessions.close` semantics. */
  closeSession(sessionId: string): Promise<void>;
  send(machineId: string, frame: LinkFrame): boolean | null;
  audit: AuditSink;
  now(): number;
  newId(): string;
  after(fn: () => void, ms: number): () => void;
  log(message: string): void;
}

export interface Drive {
  /** Serving side for drive.input/resize/open/close; viewer side for drive.result. */
  onFrame(machineId: string, frame: DriveFrame): Promise<void>;
  /** Any change to a link's state or capabilities, including revoke. */
  linkChanged(machineId: string): void;
  /** Viewer side (C2 `remote.input`). Throws RpcFault `peer_unreachable` or `capability_off`. */
  input(machineId: string, sessionId: string, data: string): void;
  /** Viewer side (C2 `remote.resize`). */
  resize(machineId: string, sessionId: string, cols: number, rows: number): void;
  /** Viewer side (C2 `remote.open`). Resolves on `drive.result`. */
  open(machineId: string, agentId: string, folder: string): Promise<{ sessionId: string }>;
  /** Viewer side (C2 `remote.close`). */
  close(machineId: string, sessionId: string): Promise<void>;
  stop(): void;
}

const live = (state: LinkState) => state === 'up' || state === 'degraded';

/** The capability seam: I let this machine drive right now. Never consults the peer's record. */
export function driveAllowed(link: DriveLink | undefined): boolean {
  return link !== undefined && live(link.state) && link.capabilities.drive === true;
}

export function createDrive(_deps: DriveDeps): Drive {
  throw new Error('CON-27 slice 8: createDrive is not implemented yet');
}
