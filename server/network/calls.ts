import type { McpNetworkPort } from '../../src/conduit-mcp/remote-routing';
import type { StructuredOutput } from '../../src/conduit-mcp/tools';
import { type Result, type ToolError, toolError } from '../../src/conduit-mcp/types';
import {
  BARE_HANDLE,
  LINK_FRAME_MAX_BYTES,
  type LinkFrame,
} from '../../src/contracts/link-protocol';
import type { RemoteCaller } from '../../src/contracts/remote-principal';
import type { LinkRecord } from '../../src/network/link-file';
import type { AuditSink } from './audit-log';

// Routed calls (CON-40, plan decision 4): B runs a session tool for a lead on an ssh controller
// link, as that lead's principal. B serves them only from that kind of link, because only there is
// the far side a controller and not a peer that merely dialed us.

export type CallFrame = Extract<LinkFrame, { t: 'call' }>;
type CallResultFrame = Extract<LinkFrame, { t: 'call.result' }>;

/** At most one `call.refused` audit entry per link in this window, as drive does. */
export const CALL_REFUSAL_AUDIT_MS = 60_000;
/** Headroom under the frame limit for the envelope around a result. */
const RESULT_ENVELOPE_BYTES = 4 * 1024;
const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 1024;
const ERROR_HINT_MAX = 512;

export interface CallsDeps {
  /** My record of the link to a machine: what it is and what I let it do. */
  linkOf(machineId: string): LinkRecord | null;
  /** The MCP host, once it exists. */
  mcp(): Pick<McpNetworkPort, 'callAsRemote'> | null;
  send(machineId: string, frame: LinkFrame): boolean | null;
  audit: AuditSink;
  now(): number;
}

export interface Calls {
  /** Serving side for a `call` frame; always answers it with exactly one call.result. */
  serveCall(machineId: string, frame: CallFrame): Promise<void>;
}

/** Control characters never reach the far side's parser; text is cut to the frame's caps. */
const printable = (s: string, max: number): string =>
  Array.from(s.replace(/\p{Cc}/gu, ''))
    .slice(0, max)
    .join('');

function errorFrame(id: string, error: ToolError): CallResultFrame {
  return {
    t: 'call.result',
    id,
    ok: false,
    error: {
      code: printable(error.code, ERROR_CODE_MAX),
      message: printable(error.message, ERROR_MESSAGE_MAX),
      retryable: error.retryable,
      ...(error.hint === undefined ? {} : { hint: printable(error.hint, ERROR_HINT_MAX) }),
    },
  };
}

/** The answer frame for a result: a result over the frame limit is an error, not a dropped frame. */
function resultFrame(id: string, result: Result<StructuredOutput>): CallResultFrame {
  if (!result.ok) return errorFrame(id, result.error);
  const value = result.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return errorFrame(id, toolError('host_unavailable', 'the call answered with no result'));
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > LINK_FRAME_MAX_BYTES - RESULT_ENVELOPE_BYTES)
    return errorFrame(id, toolError('too_large', 'the result is over the link frame limit'));
  return { t: 'call.result', id, ok: true, result: { ...value } };
}

export function createCalls(deps: CallsDeps): Calls {
  /** The last `call.refused` audit per link, so a flood of refusals audits once a minute. */
  const lastRefusal = new Map<string, number>();

  const refuse = (machineId: string, id: string, reason: string, message: string): void => {
    deps.send(machineId, errorFrame(id, toolError('refused', message)));
    const at = deps.now();
    const last = lastRefusal.get(machineId);
    if (last !== undefined && at - last < CALL_REFUSAL_AUDIT_MS) return;
    lastRefusal.set(machineId, at);
    deps.audit.record({ kind: 'call.refused', peer: machineId, detail: { reason } });
  };

  const serveCall = async (machineId: string, frame: CallFrame): Promise<void> => {
    const link = deps.linkOf(machineId);
    // An inbound ssh record: the peer reached us over its own ssh session, and the record has no
    // ssh endpoint because we never dialed it.
    if (link === null || link.transport !== 'ssh' || link.ssh !== null)
      return refuse(
        machineId,
        frame.id,
        'not_controller',
        'calls are served only to an ssh controller',
      );
    // The handle is the only identity on the wire: a handle with an '@' would pose as an address.
    if (!BARE_HANDLE.test(frame.principal.handle))
      return refuse(machineId, frame.id, 'bad_handle', 'the principal is not a bare handle');
    const mcp = deps.mcp();
    if (mcp === null) {
      deps.send(
        machineId,
        errorFrame(frame.id, toolError('host_unavailable', 'Conduit is not ready here')),
      );
      return;
    }
    // The machine id is the link's own, never the frame's: a peer cannot name another machine.
    const principal: RemoteCaller = {
      kind: 'remote',
      handle: frame.principal.handle,
      machineId: link.machineId,
      trust: 'own',
      controller: true,
      capabilities: { ...link.capabilities },
    };
    const result = await mcp.callAsRemote(principal, frame.tool, frame.args);
    deps.send(machineId, resultFrame(frame.id, result));
  };

  return { serveCall };
}
