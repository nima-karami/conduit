import type { McpNetworkPort } from '../../src/conduit-mcp/remote-routing';
import type { StructuredOutput } from '../../src/conduit-mcp/tools';
import {
  isToolErrorCode,
  type Result,
  type ToolError,
  toolError,
} from '../../src/conduit-mcp/types';
import {
  BARE_HANDLE,
  CALL_ARGS_MAX_BYTES,
  LINK_FRAME_MAX_BYTES,
  type LinkFrame,
  type LinkState,
  ROUTED_CALLS_MIN_MINOR,
  type RoutedTool,
} from '../../src/contracts/link-protocol';
import type { RemoteCaller } from '../../src/contracts/remote-principal';
import type { LinkRecord } from '../../src/network/link-file';
import type { AuditSink } from './audit-log';

// Routed calls (CON-40, plan decisions 1, 4 and 5). Both halves live here. B runs a session tool
// for a lead on an ssh controller link, as that lead's principal (serveCall). A sends a call to a
// machine it dialed over ssh and takes the answer back (call): a call is never re-sent, so a drop
// or a timeout is the caller's to report, not a second run.

export type CallFrame = Extract<LinkFrame, { t: 'call' }>;
type CallResultFrame = Extract<LinkFrame, { t: 'call.result' }>;

/** At most one `call.refused` audit entry per link in this window, as drive does. */
export const CALL_REFUSAL_AUDIT_MS = 60_000;
/**
 * A routed call waits at most this long for its call.result: min(the tool's budget, 60 s). B refuses
 * a tool's ask for a remote lead (remote_ask), so no routed tool runs past what a send or read needs.
 */
export const ROUTED_CALL_MS = 60_000;
/** Headroom under the frame limit for the envelope around a result. */
const RESULT_ENVELOPE_BYTES = 4 * 1024;
const ERROR_CODE_MAX = 64;
const ERROR_MESSAGE_MAX = 1024;
const ERROR_HINT_MAX = 512;

/**
 * An A-side ssh record: a machine I dialed over ssh. Only these may be routed to, and only these
 * may answer; a record the peer dialed to me is never a target (plan decision 6).
 */
export const isDialedSsh = (record: LinkRecord | null): boolean =>
  record !== null && record.transport === 'ssh' && record.ssh !== null;

export interface CallsDeps {
  /** My record of the link to a machine: what it is and what I let it do. */
  linkOf(machineId: string): LinkRecord | null;
  /** The state of my link to a machine, or null when I have none. */
  linkState(machineId: string): LinkState | null;
  /** The protocol minor the peer's hello reported; null until its hello has landed. */
  peerMinor(machineId: string): number | null;
  /** The MCP host, once it exists. */
  mcp(): Pick<McpNetworkPort, 'callAsRemote'> | null;
  send(machineId: string, frame: LinkFrame): boolean | null;
  audit: AuditSink;
  now(): number;
  newId(): string;
  after(fn: () => void, ms: number): () => void;
}

export interface Calls {
  /** Serving side for a `call` frame; always answers it with exactly one call.result. */
  serveCall(machineId: string, frame: CallFrame): Promise<void>;
  /** Routing side: runs a session tool on a machine I dialed, as `principalHandle` on my side. */
  call(
    machineId: string,
    tool: RoutedTool,
    args: Record<string, unknown>,
    principalHandle: string,
    signal: AbortSignal,
  ): Promise<Result<StructuredOutput>>;
  /** Routing side: a call.result from a machine. Ignored unless it answers a pending call of that machine. */
  onResult(machineId: string, frame: CallResultFrame): void;
  /** Any change to a link's state: a link that is no longer live ends its pending calls. */
  linkChanged(machineId: string): void;
  /** Shutdown: every pending call ends as peer_unreachable. */
  stop(): void;
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

/** A peer's error as a tool error. A code this side does not know is a refusal, with its message kept. */
function remoteError(error: Extract<CallResultFrame, { ok: false }>['error']): ToolError {
  const code = isToolErrorCode(error.code) ? error.code : 'refused';
  return {
    code,
    message: error.message,
    retryable: error.retryable,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

const live = (state: LinkState | null) => state === 'up' || state === 'degraded';

interface Pending {
  machineId: string;
  cancel(): void;
  settle(result: Result<StructuredOutput>): void;
}

export function createCalls(deps: CallsDeps): Calls {
  // Per-caller budgets are keyed by the handle@machine address, so a controller that switches
  // handles gets fresh budgets, and calls are not limited in number per link. Both are accepted
  // for a trusted controller: the link is authenticated by ssh, and only it can reach these calls.
  /** The last `call.refused` audit per link, so a flood of refusals audits once a minute. */
  const lastRefusal = new Map<string, number>();
  /** Calls I sent and have not answered, by call id. Each is answered once, then forgotten. */
  const pending = new Map<string, Pending>();

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

  const finish = (id: string, result: Result<StructuredOutput>): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.cancel();
    p.settle(result);
  };

  const unreachable = (message: string, hint?: string): Result<StructuredOutput> => ({
    ok: false,
    error: toolError(
      'peer_unreachable',
      message,
      undefined,
      hint === undefined ? undefined : { hint },
    ),
  });

  const call = (
    machineId: string,
    tool: RoutedTool,
    args: Record<string, unknown>,
    principalHandle: string,
    signal: AbortSignal,
  ): Promise<Result<StructuredOutput>> => {
    const record = deps.linkOf(machineId);
    if (record === null) return Promise.resolve(unreachable('no link to that machine'));
    if (!isDialedSsh(record))
      return Promise.resolve({
        ok: false,
        error: toolError('peer_unsupported', `${record.name} was not added over ssh`, undefined, {
          hint: 'calls go only to a machine added over ssh',
        }),
      });
    const state = deps.linkState(machineId);
    if (state === 'revoked')
      return Promise.resolve({
        ok: false,
        error: toolError('peer_revoked', `${record.name} is revoked`),
      });
    if (state !== 'up')
      return Promise.resolve(
        unreachable(`${record.name} is not connected`, `connect_machine ${record.name} first`),
      );
    const minor = deps.peerMinor(machineId);
    if (minor === null)
      return Promise.resolve(unreachable(`${record.name} has not said hello yet`));
    if (minor < ROUTED_CALLS_MIN_MINOR)
      return Promise.resolve({
        ok: false,
        error: toolError(
          'peer_incompatible',
          `${record.name} runs a Conduit that cannot take routed calls`,
          undefined,
          { hint: `update Conduit on ${record.name}` },
        ),
      });
    if (new TextEncoder().encode(JSON.stringify(args)).byteLength > CALL_ARGS_MAX_BYTES)
      return Promise.resolve({
        ok: false,
        error: toolError('too_large', 'the arguments are over the 64 KiB a routed call carries'),
      });
    if (signal.aborted)
      return Promise.resolve({
        ok: false,
        error: toolError('cancelled', 'the call was cancelled'),
      });

    return new Promise<Result<StructuredOutput>>((settle) => {
      const id = deps.newId();
      const cancelTimer = deps.after(
        () =>
          finish(id, {
            ok: false,
            error: {
              ...toolError(
                'peer_unreachable',
                `${record.name} did not answer ${tool} in time`,
                undefined,
                // B may have run it before the answer was lost; the lead checks before it retries.
                { hint: 'the machine may have run it; check list_sessions before you try again' },
              ),
              retryable: false,
            },
          }),
        ROUTED_CALL_MS,
      );
      const onAbort = () =>
        finish(id, { ok: false, error: toolError('cancelled', 'the call was cancelled') });
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        machineId,
        cancel: () => {
          cancelTimer();
          signal.removeEventListener('abort', onAbort);
        },
        settle,
      });
      const sent = deps.send(machineId, {
        t: 'call',
        id,
        tool,
        args,
        principal: { handle: principalHandle },
      });
      // Refused at once: nothing was sent, so nothing can run.
      if (sent !== true)
        finish(
          id,
          unreachable(`${record.name} is not connected`, `connect_machine ${record.name} first`),
        );
    });
  };

  return {
    serveCall,
    call,
    onResult(machineId, frame) {
      const p = pending.get(frame.id);
      if (!p || p.machineId !== machineId) return;
      // Answers come only from a machine I dialed: its record is the one a call went to.
      if (!isDialedSsh(deps.linkOf(machineId))) return;
      finish(
        frame.id,
        frame.ok
          ? { ok: true, value: { ...frame.result } }
          : { ok: false, error: remoteError(frame.error) },
      );
    },
    linkChanged(machineId) {
      if (live(deps.linkState(machineId))) return;
      const revoked = deps.linkState(machineId) === 'revoked';
      for (const [id, p] of [...pending]) {
        if (p.machineId !== machineId) continue;
        finish(
          id,
          revoked
            ? { ok: false, error: toolError('peer_revoked', 'the link was revoked') }
            : unreachable('the link dropped before the answer came back'),
        );
      }
    },
    stop() {
      for (const id of [...pending.keys()])
        finish(id, unreachable('Conduit is stopping the network'));
    },
  };
}
