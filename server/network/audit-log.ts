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
 * there is cut before any sink sees it; every sink gets one bounded event.
 */
const AUDIT_STRING_MAX = 128;
const capped = (s: string): string => s.slice(0, AUDIT_STRING_MAX);
const capDetail = (d: NonNullable<AuditEvent['detail']>): AuditEvent['detail'] =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' ? capped(v) : v]));

function capAuditEvent(e: AuditEvent): AuditEvent {
  return {
    ...e,
    ...(e.principal === undefined ? {} : { principal: capped(e.principal) }),
    ...(e.detail === undefined ? {} : { detail: capDetail(e.detail) }),
  };
}

/** The file sink is one of two outputs; see docs/plans/2026-11-14-conduit-network-machinery.plan.md, "Seam rulings at the CON-27 merge". */
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
      const line = `${JSON.stringify({ v: 1, at: new Date(opts.now()).toISOString(), ...capAuditEvent(e) })}\n`;
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

/**
 * Every event goes to the file and to the tap, capped once. A failing tap is a side channel
 * like the file: it goes to onError and never reaches the caller, so the revoke path that
 * records an audit event still runs its listeners.
 */
export function teeAudit(
  file: AuditSink,
  onError: (err: Error) => void,
): { sink: AuditSink; setTap(tap: AuditSink): void } {
  let tap: AuditSink | null = null;
  return {
    sink: {
      record(e) {
        const event = capAuditEvent(e);
        file.record(event);
        if (tap === null) return;
        try {
          tap.record(event);
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      },
    },
    setTap(t) {
      tap = t;
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
