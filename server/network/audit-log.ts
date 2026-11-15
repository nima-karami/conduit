import * as fs from 'node:fs';
import * as path from 'node:path';

export type AuditKind =
  | 'pairing.linked'
  | 'pairing.failed'
  | 'link.state'
  | 'link.revoked'
  | 'link.capability'
  | 'message.in'
  | 'message.out'
  | 'message.refused'
  | 'drive.start'
  | 'drive.stop'
  | 'drive.refused';

export interface AuditEvent {
  kind: AuditKind;
  peer: string | null;
  principal?: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface AuditSink {
  record(e: AuditEvent): void;
}

/**
 * A peer's text reaches the log through detail and principal (CON-27 review M2), so each string
 * there is cut before it is written; the log stays one bounded line per event.
 */
const AUDIT_STRING_MAX = 128;
const capped = (s: string): string => s.slice(0, AUDIT_STRING_MAX);
const capDetail = (d: NonNullable<AuditEvent['detail']>): AuditEvent['detail'] =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' ? capped(v) : v]));

/**
 * The sink is a port: POL's Activity store replaces this file-backed one later. See
 * docs/plans/2026-11-14-conduit-network-machinery.plan.md, Seams with CON-24 item 3.
 */
export function openAuditLog(
  file: string,
  opts: {
    now: () => number;
    append?: (path: string, line: string) => void;
    onError: (err: Error) => void;
  },
): AuditSink {
  const append = opts.append ?? defaultAppend();
  return {
    record(e) {
      const event: AuditEvent = {
        ...e,
        ...(e.principal === undefined ? {} : { principal: capped(e.principal) }),
        ...(e.detail === undefined ? {} : { detail: capDetail(e.detail) }),
      };
      const line = `${JSON.stringify({ v: 1, at: new Date(opts.now()).toISOString(), ...event })}\n`;
      try {
        append(file, line);
      } catch (err) {
        // Audit is a side channel: a full or unwritable disk must not fail the traffic it
        // describes, so the failure goes to onError rather than to the caller.
        opts.onError(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

function defaultAppend(): (path: string, line: string) => void {
  let dirReady = false;
  return (file, line) => {
    if (!dirReady) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      dirReady = true;
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
  };
}
