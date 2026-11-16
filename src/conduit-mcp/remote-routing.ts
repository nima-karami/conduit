// Node-free. The MCP host reads remote sessions through NetworkPort; the directory implementation
// lives in src/network/remote-directory.ts. Plan: 2026-11-14-conduit-network-machinery.plan.md, Slice 5.

import {
  type Capabilities,
  type MonitorOpener,
  type MonitorSnapshot,
  type RequestAnswerBody,
  type RequestMirror,
  ROUTED_TOOLS,
  type RoutedTool,
  type WireRecipientOutcome,
} from '../contracts/link-protocol';
import type {
  ConnectMachineResult,
  DisconnectMachineResult,
  MachineView,
} from '../contracts/machines';
import type { RemotePolicyDoc, RemotePolicySnapshot } from '../contracts/remote-policy';
import type { RemoteCaller } from '../contracts/remote-principal';
import { parseAddress } from '../network/addresses';
import type { GrantChoice } from './grant-store';
import type { RemoteAnswerResult } from './request-service';
import type { AnswerInput } from './request-types';
import type { WaitReading } from './session-waits';
import type { DirectoryEntry, StructuredOutput } from './tools';
import {
  type Handle,
  type MessageRecord,
  type RecipientStatus,
  type Result,
  type ToolError,
  toolError,
} from './types';
import type { AskSummary } from './ui-types';

export interface RemoteEntry extends DirectoryEntry {
  /** Canonical 'handle@m-xxxxxxxx'. */
  address: string;
  /** Shown form 'handle@<machine name>'. */
  display: string;
  machineId: string;
  machine: string;
  trust: 'own';
  link: 'up' | 'degraded' | 'down';
  /**
   * Who opened it, as I name them: a handle with machineId null is my own lead; otherwise a lead on
   * the machine named. Null when nobody I can name opened it.
   */
  opener: MonitorOpener | null;
}

export type RemoteResolution =
  | { kind: 'local'; handle: Handle }
  | { kind: 'remote'; entry: RemoteEntry }
  | { kind: 'unknown'; hint: string };

export interface RemoteRecipientOutcome {
  address: string;
  status: 'queued' | 'refused';
  reason:
    | 'peer_unreachable'
    | 'peer_revoked'
    | 'peer_incompatible'
    | 'capability_off'
    | 'outbox_full'
    | null;
}

/** B's rules as a conflict reports them: the rev a push must have started from, and the doc there. */
export interface RemotePolicyCurrent {
  rev: number;
  doc: RemotePolicyDoc;
}

/** A push's answer. Only a conflict carries B's `current`, so the caller can show what it lost to. */
export type RemotePolicyPushResult =
  | Result<{ rev: number }>
  | { ok: false; error: ToolError; current: RemotePolicyCurrent };

/** What the link feeds A's copy of a machine's rules. `apply` takes a full snapshot; the states mark it stale or drop it. */
export interface RemotePolicySink {
  apply(machineId: string, snap: RemotePolicySnapshot): void;
  setLinkState(machineId: string, state: 'up' | 'down' | 'gone'): void;
}

/** B's policy service, as the link calls it: `applyRemotePolicy` refuses a stale rev with `current`. */
export type RemotePolicyApplyResult =
  | { ok: true; rev: number }
  | {
      ok: false;
      code: 'policy_conflict' | 'invalid_args' | 'policy_unavailable';
      message: string;
      current?: RemotePolicyCurrent;
    };

export type RemoteGrantRevokeResult =
  | { ok: true }
  | { ok: false; code: 'not_found'; message: string };

export interface NetworkPort {
  remoteEntries(): RemoteEntry[];
  /**
   * Runs a session tool on a machine I dialed over ssh, as `principalHandle` there (CON-40 S3). The
   * answer is that machine's result, or a tool error (peer_unreachable when the link ends first).
   */
  call(
    machineId: string,
    tool: RoutedTool,
    args: Record<string, unknown>,
    principalHandle: string,
    signal: AbortSignal,
  ): Promise<Result<StructuredOutput>>;
  resolve(target: string): RemoteResolution;
  enqueue(msg: MessageRecord, recipients: RemoteEntry[]): RemoteRecipientOutcome[];
  waitReading(address: string, callerHandle: Handle): WaitReading | 'unreachable' | null;
  /** What that machine lets me do (its record of the link), not what I let it do. */
  peerCapabilitiesOf(machineId: string): Capabilities | null;
  onChange(listener: () => void): () => void;
  /** Every pinned machine with its state, meta and session count (list_machines). */
  listMachines(): MachineView[];
  /** Connects by name, id or ssh target within the caller's budget (connect_machine). */
  connectMachine(machine: string, signal: AbortSignal): Promise<ConnectMachineResult>;
  /** Closes a machine and clears its enabled flag; its remote sessions keep running (disconnect_machine). */
  disconnectMachine(machine: string): Promise<DisconnectMachineResult>;
  /** This machine's name, shown to a remote lead that must be answered here (remote_ask). */
  selfName(): string;
  /**
   * Sends the owner's answer to a request on a controlled machine (request.answer, CON-42). Resolves
   * when that machine acknowledges it; a drop is peer_unreachable and the answer is not replayed.
   */
  answerRemoteRequest(
    machineId: string,
    requestId: string,
    answer: RequestAnswerBody,
  ): Promise<Result<null>>;
  /**
   * Pushes a whole portable doc to a machine I dialed over ssh, as the edit that started from
   * `baseRev` (CON-46). Resolves once; a drop or timeout is peer_unreachable and is never re-sent.
   */
  pushPolicy(
    machineId: string,
    baseRev: number,
    doc: RemotePolicyDoc,
  ): Promise<RemotePolicyPushResult>;
  /** Revokes one of a dialed machine's grants on that machine (CON-46). Same call rules as pushPolicy. */
  revokeRemoteGrant(machineId: string, grantId: string): Promise<Result<null>>;
}

/**
 * What the link feeds A's mirror of remote requests. `apply` takes a machine's full snapshot (seq
 * decides whether it is newer); `setLinkState` marks it stale on down and drops it on gone.
 */
export interface RemoteRequestSink {
  apply(machineId: string, seq: number, requests: RequestMirror[], machineName: string): boolean;
  setLinkState(machineId: string, state: 'up' | 'down' | 'gone'): void;
}

/** Implemented by the mcp host; read by server/network. Slice 6 adds its members here. */
export interface McpNetworkPort {
  localDirectory(): DirectoryEntry[];
  /** Runs a routed call from a remote lead, as that lead's principal (host.callAsRemote). */
  callAsRemote(
    principal: RemoteCaller,
    tool: RoutedTool,
    args: Record<string, unknown>,
  ): Promise<Result<StructuredOutput>>;
  hasMessage(messageId: string): boolean;
  readBlob(sha256: string): Promise<Uint8Array | undefined>;
  /**
   * Stores a message that arrived over a link for the local handles in msg.to it may reach; one
   * outcome per msg.to entry, in order. Resolves only after the append is durable, so the caller
   * acks nothing it could still lose. Rejects when the store cannot write (the caller retries).
   */
  deliverInbound(
    msg: MessageRecord & { origin: string },
    blobs: { name: string; mime: string; bytes: Buffer }[],
    framedAsHuman: boolean,
  ): Promise<WireRecipientOutcome[]>;
  /** True when the local thread already carried a message to a recipient on that machine. */
  threadExportedTo(threadId: string, machineId: string): boolean;
  /**
   * The thread id that machine knows a local thread by: the wire id it sent when the thread came
   * from there (MessageRecord.originThreadId), otherwise the local id. CON-27 review B1.
   */
  wireThreadFor(threadId: string, machineId: string): string;
  /** A receipt or failure for a remote recipient of a message sent from here. */
  setRemoteStatus(messageId: string, address: string, status: RecipientStatus): Promise<void>;
  /**
   * Fires when a local recipient of a message that came over a link is noticed or reads it.
   * `messageId` is the origin's own (wire) id, MessageRecord.originMessageId, never the local one.
   */
  onLocalStatus(
    listener: (
      messageId: string,
      handle: Handle,
      status: 'noticed' | 'read',
      origin: string,
    ) => void,
  ): () => void;
  youUnread(): number;
  ownerPresence(): 'here' | 'away';
  requestsSummary(): MonitorSnapshot['requests'];
  /** The A-side mirror of remote requests; the link writes into it (CON-42 L3). */
  remoteRequests(): RemoteRequestSink;
  /** B's open requests plus those that ended in the last 10 min, as the link sends them (CON-42 L4). */
  mirrorOf(): RequestMirror[];
  /**
   * Applies a controller's answer to a request on this machine. Refusals are the request service's;
   * a local policy ask is not answered this way yet (CON-42 L5a).
   */
  applyRemoteAnswer(
    requestId: string,
    answer: RequestAnswerBody,
    answerId: string,
    machineId: string,
  ): RemoteAnswerResult;
  /** True while the mirror holds an ended entry, so the snapshot is re-sent until it ages out (CON-42 L5b). */
  requestsHasEnded(): boolean;
  /** Fires when a mirrored request changes; returns its unsubscribe (CON-42 L5b). */
  onRequestsMirrorChange(listener: () => void): () => void;
  /** B's rules, their rev and live grants, as a controller sees them (CON-46 L2). */
  policyDoc(): RemotePolicySnapshot;
  /** Fires when B's rules or grants change; returns its unsubscribe (CON-46 L2). */
  onPolicyDocChange(listener: () => void): () => void;
  /** Applies a controller's pushed doc to B's rules; B validates it and refuses a stale rev (CON-46 L2). */
  applyRemotePolicy(baseRev: number, doc: unknown): RemotePolicyApplyResult;
  /** Revokes a grant of B's, as the controller asked (CON-46 L2). */
  revokeRemoteGrant(grantId: string): RemoteGrantRevokeResult;
  /** A's copy of the rules a machine I dialed owns (CON-46 L4). */
  remotePolicySink(): RemotePolicySink;
}

/**
 * The grant an owner's answer to a remote ask may make. Only an allow of a grantable ask grants: a
 * forced ask (RS-D6) is approve-once, whatever the answer carries.
 */
export function remoteGrantOf(answer: AnswerInput, grantable: boolean): GrantChoice | null {
  if (answer.outcome !== 'allowed' || answer.grant === undefined || !grantable) return null;
  return answer.grant;
}

/** The tools that take `machine`: they run on that machine, or on this one when it is absent. */
const MACHINE_ARG_TOOLS: ReadonlySet<RoutedTool> = new Set<RoutedTool>([
  'list_agents',
  'open_session',
  'open_terminal',
]);
/** The tools that take a `handle@machine` session address (CON-40 S3). */
const ADDRESS_ARG_TOOLS: ReadonlySet<RoutedTool> = new Set<RoutedTool>([
  'read_screen',
  'send_input',
  'close_session',
]);
const MAX_MACHINE_CHARS = 128;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isRoutedTool = (name: string): name is RoutedTool =>
  ROUTED_TOOLS.some((tool) => tool === name);

/**
 * Where a session tool call goes. `machine` names the machine a call runs on (list_agents, open_*);
 * `address` is a session on a machine I dialed (read_screen, send_input, close_session). `args` are
 * what that machine reads: the machine is never forwarded, and the address's handle replaces it.
 */
export type RoutedIntent =
  | { tool: RoutedTool; kind: 'machine'; machine: string; args: Record<string, unknown> }
  | {
      tool: RoutedTool;
      kind: 'address';
      handle: string;
      /** The machine part as typed: a name, machine id or ssh target. */
      machine: string;
      address: string;
      args: Record<string, unknown>;
    };

/** The machine a routed call names, as the lead typed it: a machine ref, or the address it reaches. */
export function routedRefOf(tool: string, args: unknown): string | null {
  const routed = routedIntentOf(tool, args);
  if (!routed.ok || routed.value === null) return null;
  return routed.value.kind === 'machine' ? routed.value.machine : routed.value.address;
}

/**
 * Whether a session tool call names another machine by its args. A malformed one counts too, so it is
 * refused as bad arguments, not as a window it never needed.
 */
export function isRoutedCall(tool: string, args: unknown): boolean {
  const routed = routedIntentOf(tool, args);
  return !routed.ok || routed.value !== null;
}

/**
 * The routed intent of a session tool call, or null when the call stays on this machine. A malformed
 * address or machine is invalid_args here, before anything is sent.
 */
export function routedIntentOf(tool: string, rawArgs: unknown): Result<RoutedIntent | null> {
  if (!isRoutedTool(tool)) return { ok: true, value: null };
  const args = isRecord(rawArgs) ? rawArgs : {};
  if (MACHINE_ARG_TOOLS.has(tool) && args.machine !== undefined) {
    const { machine, ...rest } = args;
    if (typeof machine !== 'string' || machine.length === 0 || machine.length > MAX_MACHINE_CHARS)
      return {
        ok: false,
        error: toolError('invalid_args', 'machine must be a machine name, id or ssh target'),
      };
    return { ok: true, value: { tool, kind: 'machine', machine, args: rest } };
  }
  if (
    ADDRESS_ARG_TOOLS.has(tool) &&
    typeof args.session === 'string' &&
    args.session.includes('@')
  ) {
    const parsed = parseAddress(args.session);
    if (parsed === null || parsed.machine === null)
      return {
        ok: false,
        error: toolError('invalid_args', `${args.session} is not a handle@machine address`),
      };
    if (tool === 'close_session' && (args.sessions !== undefined || args.children !== undefined))
      return {
        ok: false,
        error: toolError(
          'invalid_args',
          'close one session on another machine at a time',
          undefined,
          { hint: 'pass session alone for a session on another machine' },
        ),
      };
    return {
      ok: true,
      value: {
        tool,
        kind: 'address',
        handle: parsed.handle,
        machine: parsed.machine,
        address: args.session,
        args: { ...args, session: parsed.handle },
      },
    };
  }
  return { ok: true, value: null };
}

/** A machine or session on another machine, as the routed call needs it. */
export interface RoutedTarget {
  machineId: string;
  /** The name the machine is shown by. */
  machine: string;
  label: string;
  home: string;
}

/** The added machine a name, id or ssh target names. Only machines I have added answer. */
export function machineTarget(
  network: Pick<NetworkPort, 'listMachines'>,
  ref: string,
): Result<RoutedTarget> {
  const matches = network
    .listMachines()
    .filter((m) => m.machine === ref || m.machine_id === ref || m.target === ref);
  const ids = [...new Set(matches.map((m) => m.machine_id))];
  const [only] = matches;
  if (only === undefined)
    return {
      ok: false,
      error: toolError('machine_unknown', `no machine is called ${ref}`, undefined, {
        hint: 'name a machine from list_machines, or an ssh Host from your ssh config',
      }),
    };
  if (ids.length > 1)
    return {
      ok: false,
      error: toolError('machine_unknown', `more than one machine is called ${ref}`, undefined, {
        hint: `retry with one of these ids: ${ids.join(', ')}`,
        valid: ids,
      }),
    };
  return {
    ok: true,
    value: {
      machineId: only.machine_id,
      machine: addressableName(network.listMachines(), only),
      label: '',
      home: '',
    },
  };
}

/**
 * The name a machine's results carry: its name when that is unique among the added machines and
 * survives as the machine part of an address; otherwise its id, so the address a result names is
 * always one the lead can send back (CON-40 S3 review).
 */
export function addressableName(
  machines: readonly Pick<MachineView, 'machine' | 'machine_id'>[],
  m: Pick<MachineView, 'machine' | 'machine_id'>,
): string {
  const sameName = machines.filter((x) => x.machine === m.machine).length;
  const usable = parseAddress(`handle@${m.machine}`)?.machine === m.machine;
  return sameName === 1 && usable ? m.machine : m.machine_id;
}

/*
 * A session address is resolved on the machine that owns the session, never from A's snapshot of it:
 * a snapshot lags and depends on B's monitor capability. A resolves only the machine part here, and
 * B decides whether the handle exists there.
 */

/** The name a session on another machine goes by in a result: handle@<machine name>, as list_sessions shows it. */
export function routedName(handle: string, machine: string): string {
  return `${handle}@${machine}`;
}

/** A routed result with its session named on the machine it came from. list_agents rows come back as they are. */
export function nameOnMachine(
  tool: RoutedTool,
  out: StructuredOutput,
  machine: string,
): StructuredOutput {
  if (tool === 'list_agents') return out;
  // Handles are renamed onto the machine; session ids (session_id, close_session's `closed`) pass
  // through as B's own ids (plan decision 5).
  const named: Record<string, unknown> = { ...out };
  for (const key of ['handle', 'session'] as const) {
    const value = named[key];
    if (typeof value === 'string') named[key] = routedName(value, machine);
  }
  return named;
}

/**
 * What an ask card shows for a routed call (the owner of this machine answers it here). A call whose
 * arguments can't be shown is null, so the caller refuses before it asks anyone.
 */
export function routedAskSummary(
  intent: RoutedIntent,
  target: RoutedTarget,
  shown: string | null,
): AskSummary | null {
  const { args } = intent;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  switch (intent.tool) {
    case 'open_session': {
      const path = str(args.path);
      const agent = str(args.agent);
      if (path === null || agent === null) return null;
      const model = str(args.model);
      const message = str(args.message);
      return {
        tool: 'open_session',
        path,
        agent,
        focus: args.focus !== false,
        machine: target.machine,
        ...(model === null ? {} : { model }),
        ...(message === null ? {} : { message: message.length }),
      };
    }
    case 'open_terminal': {
      const path = str(args.path);
      const command = str(args.command);
      if (path === null || command === null) return null;
      return {
        tool: 'open_terminal',
        path,
        command,
        focus: args.focus !== false,
        machine: target.machine,
      };
    }
    case 'list_agents':
      return { tool: 'list_agents' };
    case 'read_screen':
      return { tool: 'read_screen', target: shown ?? target.machine };
    case 'close_session':
      return { tool: 'close_session', target: shown ?? target.machine };
    case 'send_input': {
      const text = str(args.text) ?? '';
      const keys = Array.isArray(args.keys)
        ? args.keys.filter((k): k is string => typeof k === 'string')
        : [];
      return {
        tool: 'send_input',
        target: shown ?? target.machine,
        label: target.label,
        home: target.home,
        text,
        keys,
      };
    }
  }
}

/** A control tool target naming another machine: orchestrate is v1 (NET §4.1), so say so plainly. */
export function remoteTargetRefusal(target: string): ToolError | null {
  const parsed = parseAddress(target);
  if (parsed === null || parsed.machine === null) return null;
  return toolError(
    'peer_unsupported',
    `${target} is on another machine; opening, typing into or reading sessions on other machines isn't available yet`,
    undefined,
    { hint: 'message it with send_message instead' },
  );
}

/** Local rows keep their order and come first, so a bare handle still finds its local session. */
export function mergeDirectory(
  local: DirectoryEntry[],
  remote: RemoteEntry[],
): (DirectoryEntry | RemoteEntry)[] {
  return [...local, ...remote];
}

export function isRemote(e: DirectoryEntry | RemoteEntry): e is RemoteEntry {
  return 'address' in e;
}

/** A machine is known when a pinned one answers to the name, id or ssh target given (plan decision 5). */
export function isKnownMachine(machines: readonly MachineView[], ref: string): boolean {
  return machines.some((m) => m.machine === ref || m.machine_id === ref || m.target === ref);
}
