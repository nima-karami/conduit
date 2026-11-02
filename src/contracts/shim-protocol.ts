// C6 — MCP shim ↔ server. FROZEN: every shim a live agent runs speaks this until the agent exits, so a
// server of any later version must accept it. Changing a field = a new generation the server also
// keeps accepting. Shim code: resources/conduit-mcp/conduit-mcp-shim.cjs (three-process-architecture
// F6). Recorded wire lines: test/fixtures/contracts/shim-hello.json.

/** 1 = the v0.51 byte relay (no welcome, no resume, permanent fallback on close). */
export const SHIM_PROTOCOL_GENERATION = 2;

/** v0.51's hello, still accepted: no resume, so its server treats the client as fresh. */
export interface ShimHelloV1 {
  conduit: 1;
  token: string | null;
}

/** First line, shim → server. */
export interface ShimHelloV2 {
  conduit: 2;
  token: string | null;
  /** Shim build, for logs only; never branch on it. */
  shim: string;
  /** Present after a reconnect once the handshake reached `init-done`. */
  resume: ShimResume | null;
}

export type ShimHello = ShimHelloV1 | ShimHelloV2;

export interface ShimResume {
  /** The client's original `initialize` request params, verbatim. */
  initialize: Record<string, unknown>;
  /**
   * Whether the shim has actually read `notifications/initialized` from the client, never assumed:
   * after a local initialize answer it may not have come yet. When false the server waits for the
   * notification on the relayed stream before treating the connection as initialized.
   */
  initialized: boolean;
}

/** v0.51's endpoint limit, kept for gen 1; gen 2 carries the cached initialize. */
export const SHIM_HELLO_V1_MAX_BYTES = 4 * 1024;
/** A cached initialize that would push the hello past this gets `reinitialize_required`. */
export const SHIM_HELLO_MAX_BYTES = 64 * 1024;

/**
 * First line, server → shim. Generation-1 shims never get one. While the server's token store is
 * unreadable every hello gets `draining`, so shims keep retrying; `unknown_token` only follows a clean
 * store load, since it ends the shim's retries for good (D21).
 */
export type ShimWelcome =
  | { conduit: 2; ok: true }
  | { conduit: 2; ok: false; reason: 'unknown_token' | 'unsupported_generation' | 'draining' };

/**
 * The handshake as the shim tracks it, for the shim's whole life. `init-pending`: initialize relayed,
 * no reply yet; on a drop it stays pending and the cached request is re-sent after reconnect with the
 * same id (initialize is idempotent). It is the one outstanding request exempt from `outcome_unknown`,
 * and it is answered exactly once: by the server, or by the local fallback past the deadline below.
 * `init-done`: a SUCCESSFUL initialize result reached the client, from the server or from the local
 * fallback (then marked local); a resume carries it from then on. An initialize error response returns
 * the phase to `idle`.
 */
export type ShimInitPhase = 'idle' | 'init-pending' | 'init-done';

/**
 * Connection states. RELAYING forwards whole JSON-RPC lines (never partial bytes). CONNECTING and
 * RECONNECTING buffer stdin up to SHIM_CONNECT_BUFFER_MAX_BYTES and retry with SHIM_RECONNECT backoff.
 * FALLBACK answers locally until the first successful connect; PERMANENT_FALLBACK never retries.
 * The initial-connect deadline applies to the first CONNECTING and to RECONNECTING in `init-pending`;
 * RECONNECTING after `init-done` keeps buffering, since its client already has a handshake.
 * Snapshot rule: a hello carries the init snapshot (phase, cached initialize, `initialized`) at the moment it is
 * sent. If any of it changes before that attempt's welcome, e.g. the local fallback answers
 * `initialize`, the attempt is abandoned: close its socket and send a new hello with the new snapshot
 * (`resume` present). A connection is promoted to RELAYING only when its welcome answers the hello
 * carrying the current snapshot, so exactly one `initialize` response ever reaches the client.
 * Transitions (recorded cases: test/fixtures/contracts/shim-hello.json `transitions`):
 *
 * | Event                                       | Action                                         |
 * |---------------------------------------------|------------------------------------------------|
 * | welcome `unknown_token`/`unsupported_generation` | permanent fallback, no retry              |
 * | welcome `draining` (also every hello while   | retry                                          |
 * |   the server's token store is unreadable)    |                                                |
 * | no welcome within SHIM_WELCOME_TIMEOUT_MS   | treat as a failed connect, retry               |
 * | initial CONNECTING, no welcome within        | FALLBACK: answer a buffered `initialize` once,  |
 * |   SHIM_INITIAL_CONNECT_DEADLINE_MS           | locally (FALLBACK_CAPABILITIES); other buffered |
 * |                                             | requests get `host_unavailable`; keep retrying  |
 * | RECONNECTING in `init-pending`, no reconnect | answer the pending `initialize` once, locally   |
 * |   within SHIM_INITIAL_CONNECT_DEADLINE_MS    | (FALLBACK_CAPABILITIES); phase `init-done`,     |
 * |                                             | marked local; keep retrying                     |
 * | drop in `init-pending`                      | keep the initialize pending, no error for it;   |
 * |                                             | re-send it with the same id after the welcome   |
 * | first successful connect, phase `init-done` | hello with `resume` (the cached initialize);    |
 * |                                             | the server sends RESUME_NOTIFICATION            |
 * | first successful connect, phase `idle`      | hello with `resume: null`                       |
 * |   (FALLBACK entered before any initialize)   |                                                 |
 * | phase changes between a hello and its       | abandon the attempt (close, ignore its welcome);|
 * |   welcome (a local initialize answer)        | new hello with the new snapshot (`resume`)      |
 * | a resume hello would exceed                  | answer the request that needs the host with     |
 * |   SHIM_HELLO_MAX_BYTES                       | `reinitialize_required` once, then              |
 * |                                             | PERMANENT_FALLBACK; no hello is sent            |
 * | connect `error` and `close` for one attempt | exactly one retry is scheduled                 |
 * | stdin EOF, any state                        | cancel retries, flush stdout, exit             |
 * | stdout EPIPE                                | exit                                           |
 * | hello with `token: null`                    | accepted with no tools, as in v0.51            |
 *
 * Process-lifetime state survives every reconnect: the stdin line parser (a partial stdin line is
 * never dropped), the cached initialize request (id + params) and the init phase. Attempt-lifetime
 * state dies with its socket: the response parser's fragments are discarded, and the outstanding-
 * request map is failed per the rules above, except a pending `initialize`. Callbacks from an
 * abandoned socket are ignored. `notifications/cancelled` removes its id, so no local reply is
 * fabricated for it. Numeric and string ids stay distinct (`1` ≠ `"1"`).
 */
export type ShimState =
  | 'connecting'
  | 'relaying'
  | 'reconnecting'
  | 'fallback'
  | 'permanent_fallback'
  | 'exiting';

export const SHIM_RECONNECT = { firstMs: 250, maxMs: 5_000 } as const;
export const SHIM_WELCOME_TIMEOUT_MS = 3_000;
/** Without it a small buffered or pending `initialize` waits forever for an absent server. */
export const SHIM_INITIAL_CONNECT_DEADLINE_MS = 2_000;
/** Past this, further requests get `host_unavailable` instead of being buffered. */
export const SHIM_CONNECT_BUFFER_MAX_BYTES = 1024 * 1024;

/**
 * Answered locally by the fallback, so a later promotion to the real host only needs list_changed:
 * the client was already told the tool list can change.
 */
export const FALLBACK_CAPABILITIES = { tools: { listChanged: true } } as const;

/**
 * After accepting a `resume`, the server never replies to the replayed `initialize`: the client
 * already has its one response. It treats the connection as initialized at once when
 * `resume.initialized` is true, else once `notifications/initialized` arrives, then sends this so the
 * client refetches the (possibly changed) tool list. The no-initialize grace counts a resume as an
 * initialize.
 */
export const RESUME_NOTIFICATION = 'notifications/tools/list_changed';

/**
 * The shim's own failures. `host_unavailable`: never written to a socket, safe to retry.
 * `outcome_unknown`: written, unanswered when the pipe dropped; it may have completed.
 * `reinitialize_required`: the resume hello can't fit SHIM_HELLO_MAX_BYTES; sent once, then the shim
 * enters `permanent_fallback`.
 */
export const SHIM_ERRORS = {
  host_unavailable: { message: 'Conduit is restarting; retry shortly', retryable: true },
  outcome_unknown: {
    message: 'Conduit restarted mid-call; it may have completed, check before retrying',
    retryable: false,
  },
  reinitialize_required: {
    message: 'Conduit lost this session’s handshake; restart the MCP client',
    retryable: false,
  },
} as const;
export type ShimErrorCode = keyof typeof SHIM_ERRORS;

/** JSON-RPC server-error code for non-tool requests. */
export const SHIM_ERROR_RPC_CODE = -32000;

/**
 * The MCP-correct envelope: a `CallToolResult` with `isError` for `tools/call`, matching the v0.51
 * shim's fallback (`{content:[{type:'text', text: JSON.stringify({error})}], isError:true}`), and a
 * JSON-RPC error for anything else.
 */
export function shimErrorReply(
  id: string | number,
  method: string,
  code: ShimErrorCode,
): Record<string, unknown> {
  const { message, retryable } = SHIM_ERRORS[code];
  if (method === 'tools/call') {
    const text = JSON.stringify({ error: { code, message, retryable } });
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: SHIM_ERROR_RPC_CODE, message, data: { code, retryable } },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const tokenOf = (v: unknown): string | null | undefined => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return undefined;
  return v.trim() === '' ? null : v;
};

/**
 * `unsupported_generation`: a well-formed hello from a newer shim, which gets that welcome (then
 * falls back permanently) instead of a silent drop.
 */
export type ShimHelloParse =
  | { ok: true; hello: ShimHello }
  | { ok: false; reason: 'unsupported_generation' };

const parseKnownHello = (v: Record<string, unknown>, bytes: number): ShimHello | null => {
  const token = tokenOf(v.token);
  if (token === undefined) return null;
  if (v.conduit === 1) return bytes > SHIM_HELLO_V1_MAX_BYTES ? null : { conduit: 1, token };
  if (v.conduit !== 2 || typeof v.shim !== 'string') return null;
  if (v.resume === null) return { conduit: 2, token, shim: v.shim, resume: null };
  const r = v.resume;
  if (!isRecord(r) || !isRecord(r.initialize) || typeof r.initialized !== 'boolean') return null;
  return {
    conduit: 2,
    token,
    shim: v.shim,
    resume: { initialize: r.initialize, initialized: r.initialized },
  };
};

/**
 * The server's reading of a hello line; null = garbage, drop the connection. Unknown fields are
 * ignored, so the check is on the frozen ones only. Gen 1 parses as v0.51's endpoint did. A newer
 * generation is judged by `conduit` alone: its other fields are not ours to know.
 */
export function parseShimHello(line: string): ShimHelloParse | null {
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > SHIM_HELLO_MAX_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  if (
    typeof v.conduit === 'number' &&
    Number.isInteger(v.conduit) &&
    v.conduit > SHIM_PROTOCOL_GENERATION
  )
    return { ok: false, reason: 'unsupported_generation' };
  const hello = parseKnownHello(v, bytes);
  return hello ? { ok: true, hello } : null;
}

/** The frozen field names; contracts.test.ts checks them against the types above. */
export const SHIM_FROZEN_FIELDS = {
  helloV1: ['conduit', 'token'],
  hello: ['conduit', 'token', 'shim', 'resume'],
  resume: ['initialize', 'initialized'],
  welcome: ['conduit', 'ok', 'reason'],
} as const;
