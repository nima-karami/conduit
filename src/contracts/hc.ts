// C3 — the subset of herdr-core's API Conduit uses. Hand-written from the vendored schema
// (./hc/hc.openrpc.json, HC_PINNED_VERSION); test/unit/contracts.test.ts checks every param name and
// JSON type we send, and every result field we read, against it. Bumping hc = replace the schema, fix
// the test, remote --full e2e.
import type { CloseReason, DisplayFacts, TerminalEndReason } from './frames';

export const HC_PINNED_VERSION = '0.1.16';
export const HC_PROTOCOL_GENERATION = 1;
/**
 * The oldest core known to serve the C3 subset; 0.1.16 is the only one verified. Informational:
 * compatibility is `isCompatibleCore`, not a version comparison, so an older compatible core keeps
 * running live agents and a handover to the bundled hc stays opportunistic (D30, F11, M13).
 */
export const HC_MIN_CORE_VERSION = '0.1.16';

export type HcAddress = string;

/**
 * Wire words, verbatim: hc stores whatever the program reported. The runtime maps them to C1's
 * ReportedStatus (see three-process-architecture §hc invariants); a word outside the map means "no
 * status", never an error.
 */
export interface HcStatus {
  state: string;
  kind?: string | null;
  app?: string;
  msg?: string;
  progress?: number | null;
  title?: string;
}

/** The schema's flat `Terminal`. */
export interface HcTerminal {
  address: HcAddress;
  name?: string | null;
  labels: Record<string, string>;
  argv: string[];
  cwd: string;
  state: 'live' | 'finished';
  created_ms: number;
  /** "exact", or "inexact" after a core crash. */
  screen: string;
  cols: number;
  rows: number;
  title?: string;
  status?: HcStatus | null;
  reported?: boolean;
  turn?: number;
  parent?: string | null;
  /** What runs in it now and where; null once finished. C1 `foreground` (M27). */
  foreground?: HcForeground | null;
  keep?: boolean;
  pid?: number | null;
  exit_code?: number | null;
  signal?: number | null;
  finished_ms?: number | null;
  /**
   * The schema lists `spawn_pending`, but pinned v0.1.16 keeps that claim only under `keep:true`
   * (run.rs); Conduit's `keep:false` runs never rely on it (D21). An upstream request asks to keep
   * it under `keep:false` too.
   */
  reason?: TerminalEndReason | 'spawn_pending' | null;
}

/** The schema's `Foreground`, sampled ~2/s: the source of cwd and typed-CLI detection if M27 passes. */
export interface HcForeground {
  pid: number;
  name: string;
  argv: string[];
  cwd: string;
}

/** The schema's flat `RunResult`: a `Terminal` plus run-only facts. */
export interface HcRunResult extends HcTerminal {
  first_message?: { sent: boolean; reason?: string | null } | null;
}

export interface HcMethods {
  hello: {
    params: { framed?: boolean; generation?: number };
    result: {
      version: string;
      generation: number;
      core: { id: string; name: string };
      framed: boolean;
      methods: string[];
      features: string[];
    };
  };
  /** Conduit always passes no_parent, no_notify and keep:false (three-process-architecture §hc invariants). */
  'terminal.run': {
    params: {
      argv: string[];
      cwd?: string;
      env?: Record<string, string>;
      labels?: Record<string, string>;
      /**
       * Always the launch id. hc refuses a second LIVE terminal with one name (`name_taken`, M24); a
       * finished one frees it, so Conduit never re-runs a name: a lost reply leaves the launch
       * unconfirmed, and a new launch gets a new id (D21).
       */
      name?: string;
      keep?: boolean;
      no_parent?: boolean;
      no_notify?: boolean;
    };
    result: HcRunResult;
  };
  'terminal.list': {
    params: { all?: boolean; labels?: Record<string, string> };
    result: { terminals: HcTerminal[]; hidden_finished: number };
  };
  /**
   * `terminal` is an address or a name; by name reconcile resolves a reserved or unconfirmed launch.
   * Not found never resolves one: a run still preparing isn't registered yet (D21).
   */
  'terminal.get': { params: { terminal: string }; result: HcTerminal };
  /**
   * Screen plus `lines` of history as text, live or finished: a program that ended before the
   * server's attach leaves its final output only here (C1 SpawnFinished).
   */
  'terminal.read': {
    params: { terminal: string; lines?: number };
    result: { text: string; complete: boolean; how: string };
  };
  'terminal.attach': {
    params: {
      terminal: HcAddress;
      cols: number;
      rows: number;
      observe?: boolean;
      /** Scrollback lines to paint first (main screen only). */
      history?: number;
      /**
       * The server's re-attach after a restart or core reconnect, with the record's cols/rows: hc sets
       * the size only once the viewer is active again, so a reconnect never resizes a PTY.
       */
      resumed?: boolean;
      /** The session's last `term.facts`, on every attach, so the core answers display queries. */
      display?: DisplayFacts;
    };
    result: { channel: number; terminal: HcTerminal };
  };
  'terminal.kill': { params: { terminal: HcAddress }; result: HcTerminal };
  'terminal.rm': { params: { terminal: HcAddress }; result: { removed: string } };
  'terminal.label': {
    params: { terminal: HcAddress; labels: Record<string, string> };
    result: HcTerminal;
  };
  'events.subscribe': {
    params: { labels?: Record<string, string>; terminal?: HcAddress };
    result: { seq: number; terminals: HcTerminal[]; channel?: number | null };
  };
  'server.status': {
    params: Record<string, never>;
    result: { version: string; pid: number; live: number; finished: number };
  };
}
export type HcMethod = keyof HcMethods;

export type HcEvent =
  /** `restarted` only follows a lost program replaced under `keep:true`; Conduit never sets it. */
  | { seq: number; type: 'created' | 'restarted'; terminal: HcAddress; data: HcTerminal }
  | {
      seq: number;
      type: 'lost' | 'finished';
      terminal: HcAddress;
      data: {
        reason: TerminalEndReason;
        exit_code: number | null;
        signal: number | null;
        finished_ms: number | null;
      };
    }
  | { seq: number; type: 'removed'; terminal: HcAddress; data: Record<string, never> }
  | {
      seq: number;
      type: 'status';
      terminal: HcAddress;
      data: { status: HcStatus | null; records: Record<string, HcStatus>; reported: boolean };
    }
  | { seq: number; type: 'title'; terminal: HcAddress; data: { title: string } }
  | { seq: number; type: 'size'; terminal: HcAddress; data: { cols: number; rows: number } }
  | { seq: number; type: 'keep'; terminal: HcAddress; data: { keep: boolean } }
  /**
   * Bumps each time the status leaves `working`: derived from the OSC 7501 status attention already
   * consumes, so Conduit doesn't read it (§Reuse audit).
   */
  | { seq: number; type: 'turn'; terminal: HcAddress; data: { turn: number; state: string } }
  | { seq: number; type: 'foreground'; terminal: HcAddress; data: HcForeground | null }
  | {
      seq: number;
      type: 'labels';
      terminal: HcAddress;
      data: { labels: Record<string, string>; record?: HcTerminal };
    }
  /** hc's API only grows: an event type this version doesn't know is ignored, never an error. */
  | { seq: number; type: 'unknown'; raw: unknown };

export type HcNotification =
  | { method: 'event'; params: HcEvent }
  | { method: 'heartbeat'; params: { seq: number } }
  | { method: 'missed'; params: { seq: number; terminals: HcTerminal[] } };

/** Stable error kinds the client branches on; anything else is surfaced as-is. */
export type HcErrorKind =
  | 'not_found'
  | 'blocked'
  | 'unavailable'
  | 'conflict'
  | 'status_mismatch'
  | 'finished'
  | 'spawn_failed'
  /** `terminal.run` with the name of a live terminal: the earlier run registered and is live (D21). */
  | 'name_taken';

/** `disconnected`: our connection to the core dropped; the terminal may well still be live (F10). */
export type HcStreamEnd = CloseReason | { reason: 'disconnected' };

/**
 * One attach channel: the server's active one, or the app's observer. Resize ordering is node-pty's:
 * old-grid bytes in flight still arrive after a resize and ConPTY's repaint corrects them, so hc
 * 0.1.16's lack of `resize_notifications` doesn't matter (D31). Bytes and the end arriving before a
 * handler is set are held, so the first paint is never lost.
 */
export interface HcStream {
  readonly channel: number;
  /** One handler; DATA payloads in order, first paint first. */
  onData(handler: (bytes: Uint8Array) => void): void;
  /** Fires once, after the last onData. */
  onClose(handler: (end: HcStreamEnd) => void): void;
  /**
   * Keystrokes and xterm's focus reports; an observer stream refuses them, and only the server's
   * PtyWriter calls this. There is no FOCUS frame sender: one focus producer, as today.
   */
  write(bytes: Uint8Array): void;
  /** Active stream only, like facts. */
  resize(cols: number, rows: number): void;
  facts(facts: DisplayFacts): void;
  /**
   * Returns credit for bytes handed onward (the app: to IPC; the server: appended to the ring, never
   * the screen model's parse), not for bytes xterm has rendered: today's node-pty path has no renderer
   * backpressure either, and adding it is a non-goal (three-process-architecture §Non-goals, D20).
   */
  credit(n: number): void;
  /** Detach (CLOSE); the program keeps running. */
  close(): void;
}

export interface HcClient {
  call<M extends HcMethod>(
    method: M,
    params: HcMethods[M]['params'],
  ): Promise<HcMethods[M]['result']>;
  attach(
    params: HcMethods['terminal.attach']['params'],
  ): Promise<{ result: HcMethods['terminal.attach']['result']; stream: HcStream }>;
  /** Snapshot first, then events with seq > snapshot.seq; `missed` re-snapshots in place. */
  subscribe(
    params: HcMethods['events.subscribe']['params'],
    onNotification: (n: HcNotification) => void,
  ): Promise<{ snapshot: HcTerminal[]; close(): void }>;
  /**
   * The client reconnects by itself. On `lost` every open stream ends with `disconnected`;
   * `reconnected` fires after a fresh hello, before any resubscribe. Sequence numbers restart with the
   * core, so callers re-subscribe and reconcile (F10).
   */
  onConnection(
    listener: (
      state: 'connected' | 'lost' | 'reconnected',
      hello?: HcMethods['hello']['result'],
    ) => void,
  ): () => void;
  close(): void;
}

/** JSON-schema `type` words a param may be declared with. */
export type HcJsonType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';

/**
 * What the test checks against the vendored schema: each param we send with its JSON type, and each
 * result field we read. Keyed off HcMethods, so a field added to a type must be added here.
 */
export const HC_USED_METHODS: {
  [M in HcMethod]: {
    params: Record<keyof HcMethods[M]['params'], HcJsonType>;
    result: readonly (keyof HcMethods[M]['result'])[];
  };
} = {
  hello: {
    params: { framed: 'boolean', generation: 'integer' },
    result: ['version', 'generation', 'core', 'framed', 'methods', 'features'],
  },
  'terminal.run': {
    params: {
      argv: 'array',
      cwd: 'string',
      env: 'object',
      labels: 'object',
      name: 'string',
      keep: 'boolean',
      no_parent: 'boolean',
      no_notify: 'boolean',
    },
    result: ['address', 'state', 'labels', 'cols', 'rows', 'first_message', 'reason', 'pid'],
  },
  'terminal.list': {
    params: { all: 'boolean', labels: 'object' },
    result: ['terminals', 'hidden_finished'],
  },
  'terminal.get': {
    params: { terminal: 'string' },
    result: [
      'address',
      'state',
      'labels',
      'cols',
      'rows',
      'exit_code',
      'reason',
      'screen',
      'foreground',
    ],
  },
  'terminal.read': {
    params: { terminal: 'string', lines: 'integer' },
    result: ['text', 'complete', 'how'],
  },
  'terminal.attach': {
    params: {
      terminal: 'string',
      cols: 'integer',
      rows: 'integer',
      observe: 'boolean',
      history: 'integer',
      resumed: 'boolean',
      display: 'object',
    },
    result: ['channel', 'terminal'],
  },
  'terminal.kill': { params: { terminal: 'string' }, result: ['address', 'state'] },
  'terminal.rm': { params: { terminal: 'string' }, result: ['removed'] },
  'terminal.label': {
    params: { terminal: 'string', labels: 'object' },
    result: ['address', 'labels'],
  },
  'events.subscribe': {
    params: { labels: 'object', terminal: 'string' },
    result: ['seq', 'terminals', 'channel'],
  },
  'server.status': { params: {}, result: ['version', 'pid', 'live', 'finished'] },
};

/**
 * D30: a core is compatible when it speaks our protocol generation and serves every method of the
 * subset. `hello` itself is exempt: its answer is the proof.
 */
export function isCompatibleCore(
  hello: Pick<HcMethods['hello']['result'], 'generation' | 'methods'>,
): boolean {
  if (hello.generation !== HC_PROTOCOL_GENERATION) return false;
  const served = new Set(hello.methods);
  return Object.keys(HC_USED_METHODS).every((m) => m === 'hello' || served.has(m));
}
