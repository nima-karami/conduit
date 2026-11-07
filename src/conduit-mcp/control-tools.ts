// The three open tools (spec 2026-10-27-conduit-mcp-control-tools §3.1) and the pipeline every
// control tool shares; the app-control tools live in app-control-tools.ts. No IO here: stat,
// registry, command resolution, session creation and git are deps, so tests run on POSIX fakes.

import type { DomainOpenOutcome, DomainPort } from '../contracts/server-ports';
import { coerceModel, coerceSessionCommand, commandLabel } from '../session-command';
import type { SessionOpResult } from '../session-ops';
import type { SessionCommand, SessionOpener } from '../types';
import { listAgentsOutput } from './agent-listing';
import { isRefusedLeaf, resolveAgentArg } from './agent-resolve';
import type { GitCall } from './git-refs';
import {
  type MESSAGING_TOOL_NAMES,
  type Move,
  NOT_IN_SESSION_HINT,
  type Reach,
  TOOL_SPECS,
  type ToolName,
} from './tool-policy';
import {
  type AgentListing,
  type Caller,
  type ListAgentsOutput,
  MAX_BODY_BYTES,
  type SendOptions,
} from './tools';
import {
  type Handle,
  type Result,
  type SendMessageOutput,
  type ToolError,
  type ToolErrorCode,
  type ToolErrorDetail,
  toolError,
} from './types';
import type { AskSummary, McpUiAction, McpUiResult } from './ui-types';

// spec 2026-10-30-conduit-mcp-tool-policy §3.3 "Rate"
export const ACT_RATE_PER_CALLER = 10;
export const ACT_RATE_GLOBAL = 20;
export const SHOW_RATE_PER_CALLER = 30;
export const MAX_LABEL_CHARS = 80;
export const MAX_OPEN_MESSAGE_CHARS = 16_000;
const RATE_WINDOW_MS = 60_000;

export interface OpenSessionOutput {
  session_id: string;
  handle: Handle | null;
  label: string;
  agent: string;
  /**
   * Present when open_session got a message. A failure to store it never fails the open: the
   * session is open and `id` is null with the reason (spec flexible-agent-contracts §3.2).
   */
  message?: OpenMessageOutput;
}
export interface OpenMessageOutput {
  id: string | null;
  error?: { code: ToolErrorCode; message: string };
}
export type OpenFileOutput = { opened: string; session_id: string } | { results: OpenFileResult[] };
export type McpLaunch =
  | { kind: 'agent'; agentId: string }
  | { kind: 'command'; command: SessionCommand };
export interface McpOpenRequest {
  callerSessionId: string;
  openedBy: SessionOpener;
  home: string;
  label: string | undefined;
  focus: boolean;
  launch: McpLaunch;
  /** The session closes once its program exits; finished output is lost (CON-152). */
  closeWhenDone: boolean;
  /** The CLI's model flag value; agents only (CON-148). */
  model?: string;
}
export type McpOpenOutcome = DomainOpenOutcome;
export interface McpFileRequest {
  callerSessionId: string;
  path: string;
  line: number | undefined;
  column: number | undefined;
  focus: boolean;
}
/** A stat failure of any errno is 'missing'. */
export type PathKind = 'dir' | 'file' | 'other' | 'missing';
export interface ControlDeps {
  closeSession: DomainPort['closeSession'];
  /** Persisted home of a live session; undefined ⇒ not_in_session. */
  homeOf(sessionId: string): string | undefined;
  resolvePath(home: string, p: string): string;
  kindOf(absPath: string): Promise<PathKind>;
  agentIds(): string[];
  /** Every listed agent, for list_agents (flexible-agent-contracts §4.2). */
  agents(): AgentListing[];
  /** The registered id a name reaches, aliases included (flexible-agent-contracts §3.1). */
  registeredIdOf(name: string): string | undefined;
  resolveCommand(command: string): string | undefined;
  openSession(req: McpOpenRequest): Promise<McpOpenOutcome>;
  openFile(req: McpFileRequest): Promise<{ sessionId: string }>;
  /** The handle an opened session gets; the tool picks the prefix rule for an adapter-less program. */
  claimHandle(sessionId: string, tool: 'open_session' | 'open_terminal'): Handle | null;
  now(): number;
  info(message: string, data: Record<string, unknown>): void;
  foldersOf(sessionId: string): { home: string; roots: string[] } | undefined;
  addRoot(sessionId: string, path: string): Promise<SessionOpResult>;
  /** raise: the target's window isn't the caller's (show + focus it, as moveSessionToWindow does). */
  activateSession(sessionId: string, raise: boolean): void;
  git: GitCall;
  /** Follows symlinks; null when the path does not exist. */
  realPath(absPath: string): Promise<string | null>;
  /** Read at most `max` bytes; null when the path is missing or unreadable. */
  readBytes(absPath: string, max: number): Promise<Uint8Array | null>;
  /** list_sessions' sessions: the only ones a tool may target (tool-policy spec A7). */
  targets(): readonly TargetSession[];
  ownerWindowOf(sessionId: string): number | null;
  windowReady(windowId: number): boolean;
  /** The flag a registered agent's model goes after; undefined ⇒ it takes no model. */
  modelFlagOf(agentId: string): string | undefined;
  /** The same for a bare command's resolved path (flexible-agent-contracts §3.1). */
  commandModelFlag(command: string): string | undefined;
  /** Messaging is on and its store is up, so a message can be stored. */
  messageReady(): boolean;
  /** send_message's own storage, from the caller to a session's handle (CON-148). */
  sendMessage(
    caller: Caller,
    args: unknown,
    opts?: SendOptions,
  ): Promise<Result<SendMessageOutput>>;
}
export interface TargetSession {
  sessionId: string;
  handle: Handle;
  openerSessionId: string | null;
}
/** A prepare answer: a call to ask about and run, or a result known without acting (no token spent). */
export type Prepared<T> = PreparedCall<T> | { done: Result<T> };
export interface PreparedCall<T> {
  summary: AskSummary;
  /** Its run waits on a renderer (mcp:ui): the ask budget shrinks by UI_TIMEOUT_MS. */
  routesUi: boolean;
  /**
   * A bare command on PATH: an 'on' policy still asks, since the human never registered the program
   * (flexible-agent-contracts §3.1).
   */
  alwaysAsk?: boolean;
  /** Executes; refunds the rate token itself when the open fails (step 9). */
  run(): Promise<Result<T>>;
  /** Refunds the token for a refusal between prepare and run that isn't an ask outcome. Idempotent. */
  release(): void;
}
/** Built per call by the host from the caller's resolved policy. */
export interface ControlCallContext {
  move: Move | undefined;
  reach: Reach | undefined;
  /** Bound by the host to flow.requestUi with this call's in-flight entry and caller. */
  ui(windowId: number, routedSessionId: string, action: McpUiAction): Promise<Result<McpUiResult>>;
}
export interface ControlHandlers {
  prepareOpenSession(
    caller: Caller,
    args: unknown,
    ctx: ControlCallContext,
  ): Promise<Result<Prepared<OpenSessionOutput>>>;
  prepareOpenTerminal(
    caller: Caller,
    args: unknown,
    ctx: ControlCallContext,
  ): Promise<Result<Prepared<OpenSessionOutput>>>;
  prepareOpenFile(
    caller: Caller,
    args: unknown,
    ctx: ControlCallContext,
  ): Promise<Result<Prepared<OpenFileOutput>>>;
  prepareListAgents(caller: Caller, args: unknown): Promise<Result<Prepared<ListAgentsOutput>>>;
  /** reserve → home → check → refund unless the exec kept the token. */
  prepared<T>(
    tool: ControlTool,
    caller: Caller,
    check: (who: CallWho) => Promise<CheckResult<T>>,
  ): Promise<Result<Prepared<T>>>;
}

export type Fail = { ok: false; error: ToolError };
export const fail = (code: ToolErrorCode, message: string, detail?: ToolErrorDetail): Fail => ({
  ok: false,
  error: toolError(code, message, undefined, detail),
});
export const isFail = (v: unknown): v is Fail =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface Common {
  path: string;
  label: string | undefined;
  focus: boolean;
}

/** An object with no keys outside `allowed`. */
export function parseKeys(
  raw: unknown,
  allowed: readonly string[],
): Record<string, unknown> | Fail {
  if (!isRecord(raw)) return fail('invalid_args', 'arguments must be an object');
  const extra = Object.keys(raw).find((k) => !allowed.includes(k));
  if (extra !== undefined) return fail('invalid_args', `unknown argument: ${extra}`);
  return raw;
}

/** parseKeys, plus a non-empty `path` and an optional boolean `focus`. */
export function parseObject(
  raw: unknown,
  allowed: readonly string[],
): Record<string, unknown> | Fail {
  const o = parseKeys(raw, allowed);
  if (isFail(o)) return o;
  return checkPathFocus(o);
}

function checkPathFocus(raw: Record<string, unknown>): Record<string, unknown> | Fail {
  if (typeof raw.path !== 'string' || raw.path.length === 0)
    return fail('invalid_args', 'path must be a non-empty string');
  if (raw.focus !== undefined && typeof raw.focus !== 'boolean')
    return fail('invalid_args', 'focus must be a boolean');
  return raw;
}

function parseLabel(v: unknown): string | undefined | Fail {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return fail('invalid_args', 'label must be a string');
  // Code points, as JSON Schema's maxLength counts them.
  if (Array.from(v).length > MAX_LABEL_CHARS)
    return fail('invalid_args', `label is over ${MAX_LABEL_CHARS} chars`);
  return v;
}

/** What only the two open-a-session tools carry. */
interface OpenExtras {
  closeWhenDone: boolean;
}

/** What only open_session carries (CON-148). */
interface SessionExtras {
  model: string | undefined;
  message: string | undefined;
}

function common(o: Record<string, unknown>, label: string | undefined): Common {
  return { path: o.path as string, label, focus: o.focus !== false };
}

/** Optional boolean: true closes the session once its program exits (CON-152). */
function parseCloseWhenDone(o: Record<string, unknown>): boolean | Fail {
  if (o.close_when_done !== undefined && typeof o.close_when_done !== 'boolean')
    return fail('invalid_args', 'close_when_done must be a boolean');
  return o.close_when_done === true;
}

/** A model name the CLI's flag takes as one argv entry (session-command coerceModel). */
function parseModel(v: unknown): string | undefined | Fail {
  if (v === undefined) return undefined;
  return (
    coerceModel(v) ??
    fail(
      'invalid_args',
      'model must be 1–64 chars of letters, digits, . _ : / -, starting with a letter or digit',
    )
  );
}

/** The opener's first task: send_message's body limits, in characters and in bytes. */
function parseMessage(v: unknown): string | undefined | Fail {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0 || Array.from(v).length > MAX_OPEN_MESSAGE_CHARS)
    return fail('invalid_args', `message must be 1–${MAX_OPEN_MESSAGE_CHARS} chars`);
  // Checked here, not by the send, so a too-large message never leaves a session open unmessaged.
  if (new TextEncoder().encode(v).byteLength > MAX_BODY_BYTES)
    return fail('invalid_args', 'message is over 32 KB');
  return v;
}

function parseSessionArgs(
  raw: unknown,
): (Common & OpenExtras & SessionExtras & { agent: string }) | Fail {
  const o = parseObject(raw, [
    'path',
    'agent',
    'label',
    'focus',
    'close_when_done',
    'model',
    'message',
  ]);
  if (isFail(o)) return o;
  if (typeof o.agent !== 'string') return fail('invalid_args', 'agent must be a string');
  const label = parseLabel(o.label);
  if (isFail(label)) return label;
  const closeWhenDone = parseCloseWhenDone(o);
  if (isFail(closeWhenDone)) return closeWhenDone;
  const model = parseModel(o.model);
  if (isFail(model)) return model;
  const message = parseMessage(o.message);
  if (isFail(message)) return message;
  return { ...common(o, label), agent: o.agent, closeWhenDone, model, message };
}

function parseTerminalArgs(
  raw: unknown,
): (Common & OpenExtras & { command: SessionCommand }) | Fail {
  const o = parseObject(raw, ['path', 'command', 'args', 'label', 'focus', 'close_when_done']);
  if (isFail(o)) return o;
  const command = coerceSessionCommand({
    command: o.command,
    args: o.args === undefined ? [] : o.args,
  });
  if (!command)
    return fail(
      'invalid_args',
      'command must be a non-empty string up to 1 KB, args up to 64 strings and 8 KB',
    );
  const label = parseLabel(o.label);
  if (isFail(label)) return label;
  const closeWhenDone = parseCloseWhenDone(o);
  if (isFail(closeWhenDone)) return closeWhenDone;
  return { ...common(o, label), command, closeWhenDone };
}

const position = (v: unknown): v is number | undefined =>
  v === undefined || (Number.isInteger(v) && (v as number) >= 1);

export const MAX_OPEN_FILE_PATHS = 20;

type FileArgs =
  | (Common & { kind: 'one'; line: number | undefined; column: number | undefined })
  | { kind: 'many'; paths: string[]; focus: boolean };

function parseFileArgs(raw: unknown): FileArgs | Fail {
  const o = parseKeys(raw, ['path', 'paths', 'line', 'column', 'focus']);
  if (isFail(o)) return o;
  if ((o.path === undefined) === (o.paths === undefined))
    return fail('invalid_args', 'pass exactly one of path or paths');
  if (o.paths !== undefined) {
    if (o.line !== undefined || o.column !== undefined)
      return fail('invalid_args', 'line and column go with path, not paths');
    const p = o.paths;
    if (
      !Array.isArray(p) ||
      p.length < 1 ||
      p.length > MAX_OPEN_FILE_PATHS ||
      !p.every((x) => typeof x === 'string' && x.length > 0)
    )
      return fail('invalid_args', `paths must be 1–${MAX_OPEN_FILE_PATHS} non-empty strings`);
    if (o.focus !== undefined && typeof o.focus !== 'boolean')
      return fail('invalid_args', 'focus must be a boolean');
    return { kind: 'many', paths: p as string[], focus: o.focus !== false };
  }
  const one = checkPathFocus(o);
  if (isFail(one)) return one;
  if (!position(o.line) || !position(o.column))
    return fail('invalid_args', 'line and column must be integers ≥ 1');
  return { kind: 'one', ...common(one, undefined), line: o.line, column: o.column };
}

export type OpenFileResult =
  | { path: string; opened: true }
  | { path: string; opened: false; error: ToolError };

/** Times of reserved or completed calls, oldest first. */
class Window {
  private times: number[] = [];
  count(now: number): number {
    while (this.times.length && now - this.times[0] >= RATE_WINDOW_MS) this.times.shift();
    return this.times.length;
  }
  add(t: number): void {
    this.times.push(t);
  }
  release(t: number): void {
    const i = this.times.lastIndexOf(t);
    if (i >= 0) this.times.splice(i, 1);
  }
}

/** One reservation: refunded at most once, and never after it was kept. */
interface Token {
  refund(): void;
  keep(): void;
}
/** spend() takes one more token from the call's budget, for a list call's further targets. */
export type CallWho = { sessionId: string; home: string; spend(): Token | Fail };
export type CheckResult<T> =
  | Fail
  | { done: Result<T> }
  | {
      summary: AskSummary;
      routesUi?: true;
      alwaysAsk?: boolean;
      exec: (token: Token) => Promise<Result<T>>;
    };

class Budget {
  private readonly global = new Window();
  private readonly perCaller = new Map<Handle, Window>();
  constructor(
    private readonly perCallerMax: number,
    private readonly globalMax: number | null,
    private readonly what: string,
  ) {}

  /**
   * Synchronous, before any await, so concurrent calls can't all pass the check; the token
   * undoes it when the call is then refused or fails (only successes are charged).
   */
  reserve(handle: Handle, now: number): Token | Fail {
    let mine = this.perCaller.get(handle);
    if (!mine) {
      mine = new Window();
      this.perCaller.set(handle, mine);
    }
    if (mine.count(now) >= this.perCallerMax)
      return fail('rate_limited', `more than ${this.perCallerMax} ${this.what} in a minute`);
    if (this.globalMax !== null && this.global.count(now) >= this.globalMax)
      return fail('rate_limited', `too many ${this.what} in Conduit this minute`);
    mine.add(now);
    this.global.add(now);
    const w = mine;
    let settled = false;
    return {
      refund: () => {
        if (settled) return;
        settled = true;
        w.release(now);
        this.global.release(now);
      },
      keep: () => {
        settled = true;
      },
    };
  }
}

/** Every non-messaging tool. */
export type ControlTool = Exclude<ToolName, (typeof MESSAGING_TOOL_NAMES)[number]>;

export function createControlHandlers(deps: ControlDeps): ControlHandlers {
  const budgets = {
    act: new Budget(ACT_RATE_PER_CALLER, ACT_RATE_GLOBAL, 'actions'),
    show: new Budget(SHOW_RATE_PER_CALLER, null, 'view requests'),
  };

  function reserve(tool: ControlTool, caller: Caller): Token | Fail {
    return budgets[TOOL_SPECS[tool].budget].reserve(caller.handle, deps.now());
  }

  function home(caller: Caller): { sessionId: string; home: string } | Fail {
    const home = caller.sessionId === null ? undefined : deps.homeOf(caller.sessionId);
    if (caller.sessionId === null || home === undefined)
      return fail('not_in_session', 'this MCP connection is not a Conduit session', {
        hint: NOT_IN_SESSION_HINT,
      });
    return { sessionId: caller.sessionId, home };
  }

  /**
   * main's open path, git and the renderer step do real IO; a throw must still answer tools/call,
   * because json-rpc awaits deps.call unguarded and an escaped rejection leaves the request
   * unanswered.
   */
  function failed(tool: string, caller: Caller, e: unknown, path?: string): Fail {
    const message = e instanceof Error ? e.message : String(e);
    deps.info('control call failed', { tool, caller: caller.handle, path, error: message });
    return fail('open_failed', message);
  }

  async function checkKind(abs: string, want: 'dir' | 'file'): Promise<Fail | null> {
    const kind = await deps.kindOf(abs);
    if (kind === 'missing') return fail('path_missing', `no such path: ${abs}`);
    if (kind !== want)
      return want === 'dir'
        ? fail('not_a_directory', `not a folder: ${abs}`)
        : fail('not_a_file', `not a file: ${abs}`);
    return null;
  }

  /**
   * Holds the reservation across the caller's checks: any refusal (or throw) before a
   * PreparedCall is handed out refunds it.
   */
  async function prepared<T>(
    tool: ControlTool,
    caller: Caller,
    check: (who: CallWho) => Promise<CheckResult<T>>,
  ): Promise<Result<Prepared<T>>> {
    const token = reserve(tool, caller);
    if (isFail(token)) return token;
    let handed = false;
    try {
      const who = home(caller);
      if (isFail(who)) return who;
      let c: CheckResult<T>;
      try {
        c = await check({ ...who, spend: () => reserve(tool, caller) });
      } catch (e) {
        return failed(tool, caller, e);
      }
      if (isFail(c)) return c;
      // Nothing to run: the reservation is refunded by the finally below, as for any refusal.
      if ('done' in c) return { ok: true, value: { done: c.done } };
      const exec = c.exec;
      handed = true;
      return {
        ok: true,
        value: {
          summary: c.summary,
          routesUi: c.routesUi === true,
          alwaysAsk: c.alwaysAsk === true,
          async run() {
            try {
              return await exec(token);
            } catch (e) {
              return failed(tool, caller, e);
            } finally {
              token.refund();
            }
          },
          release: token.refund,
        },
      };
    } finally {
      if (!handed) token.refund();
    }
  }

  /**
   * The opener's first message to the session it just opened (CON-148). The session cannot read
   * yet, so the send skips the not_messageable check for this one message (spec §3.2).
   */
  async function openMessage(
    caller: Caller,
    handle: Handle | null,
    body: string,
  ): Promise<OpenMessageOutput> {
    if (handle === null)
      return {
        id: null,
        error: { code: 'open_failed', message: 'opened, but it has no handle to message' },
      };
    const sent = await deps.sendMessage(caller, { to: [handle], body }, { allowUnconnected: true });
    if (!sent.ok)
      return { id: null, error: { code: sent.error.code, message: sent.error.message } };
    return { id: sent.value.message_id };
  }

  /** What open_session or open_terminal launches, once its arguments name something real. */
  interface Resolved {
    launch: McpLaunch;
    /** The output's `agent`: a registered id, or a command's leaf. */
    agent: string;
    /** A bare command: the summary shows its absolute path, and its label defaults to the leaf. */
    bare: boolean;
    label: string | undefined;
  }

  const modelFlagOfLaunch = (launch: McpLaunch): string | undefined =>
    launch.kind === 'agent'
      ? deps.modelFlagOf(launch.agentId)
      : deps.commandModelFlag(launch.command.command);

  function prepareOpen(
    tool: 'open_session' | 'open_terminal',
    caller: Caller,
    a: Common & OpenExtras & Partial<SessionExtras>,
    resolve: () => Promise<Result<Resolved>>,
  ): Promise<Result<Prepared<OpenSessionOutput>>> {
    return prepared(tool, caller, async (who) => {
      const abs = deps.resolvePath(who.home, a.path);
      const bad = await checkKind(abs, 'dir');
      if (bad) return bad;
      const target = await resolve();
      if (!target.ok) return target;
      const { launch, agent, bare, label } = target.value;
      if (a.model !== undefined && modelFlagOfLaunch(launch) === undefined) {
        const withModel = deps.agentIds().filter((id) => deps.modelFlagOf(id) !== undefined);
        return fail('invalid_args', "this agent doesn't take a model", {
          hint: `add an agents.json profile with capabilities.model_flag, or use one of: ${
            withModel.length > 0 ? withModel.join(', ') : 'none'
          }`,
        });
      }
      if (a.message !== undefined && !deps.messageReady())
        return fail('invalid_args', 'message needs messaging on');
      const command = launch.kind === 'command' ? launch.command : null;
      const summary: AskSummary =
        command !== null && tool === 'open_terminal'
          ? {
              tool: 'open_terminal',
              path: abs,
              command: [command.command, ...command.args].join(' '),
              focus: a.focus,
            }
          : {
              tool: 'open_session',
              path: abs,
              agent,
              focus: a.focus,
              ...(bare && command !== null ? { command: command.command } : {}),
              ...(a.model !== undefined ? { model: a.model } : {}),
              ...(a.message !== undefined ? { message: Array.from(a.message).length } : {}),
            };
      return {
        summary,
        alwaysAsk: bare,
        exec: async (token): Promise<Result<OpenSessionOutput>> => {
          let outcome: McpOpenOutcome;
          try {
            outcome = await deps.openSession({
              callerSessionId: who.sessionId,
              openedBy: { handle: caller.handle, sessionId: who.sessionId },
              home: abs,
              label: a.label ?? label,
              focus: a.focus,
              launch,
              closeWhenDone: a.closeWhenDone,
              model: a.model,
            });
          } catch (e) {
            return failed(tool, caller, e, abs);
          }
          if (!outcome.ok)
            return {
              ok: false,
              error: toolError(
                outcome.code,
                outcome.message,
                outcome.code === 'spawn_unconfirmed' ? outcome.sessionId : undefined,
              ),
            };
          token.keep();
          deps.info('control open', {
            tool,
            caller: caller.handle,
            sessionId: outcome.sessionId,
            path: abs,
          });
          const handle = deps.claimHandle(outcome.sessionId, tool);
          if (a.message === undefined)
            return {
              ok: true,
              value: { session_id: outcome.sessionId, handle, label: outcome.label, agent },
            };
          const message = await openMessage(caller, handle, a.message);
          return {
            ok: true,
            value: { session_id: outcome.sessionId, handle, label: outcome.label, agent, message },
          };
        },
      };
    });
  }

  // spec 2026-10-30-conduit-mcp-tool-policy §3.2: move:no runs a focus:true open as focus:false.
  const focusFor = <T extends Common>(a: T, ctx: ControlCallContext): T =>
    ctx.move === 'no' ? { ...a, focus: false } : a;

  async function resolveSessionAgent(agent: string): Promise<Result<Resolved>> {
    const arg = resolveAgentArg(agent, {
      registeredIds: deps.agentIds(),
      resolveRegistered: (n) => deps.registeredIdOf(n),
      resolveCommand: (c) => deps.resolveCommand(c),
    });
    if (!arg.ok) return arg;
    const v = arg.value;
    if (v.kind === 'registered')
      return {
        ok: true,
        value: {
          launch: { kind: 'agent', agentId: v.id },
          agent: v.id,
          bare: false,
          label: undefined,
        },
      };
    // PATH can hand back a directory, or a symlink named like an agent that runs a shell.
    if ((await deps.kindOf(v.path)) !== 'file')
      return fail('unknown_agent', `command "${agent}" on PATH is not a file: ${v.path}`, {
        hint: 'call list_agents; a bare command must be an agent CLI on PATH',
      });
    const real = await deps.realPath(v.path);
    if (real !== null && isRefusedLeaf(real))
      return fail('invalid_args', `"${agent}" runs ${real}, a shell or tool`, {
        hint: 'use open_terminal to run shells and tools',
      });
    return {
      ok: true,
      value: {
        launch: { kind: 'command', command: { command: v.path, args: [] } },
        agent: v.leaf,
        bare: true,
        label: v.leaf,
      },
    };
  }

  return {
    prepared,
    async prepareOpenSession(caller, raw, ctx) {
      const a = parseSessionArgs(raw);
      if (isFail(a)) return a;
      return prepareOpen('open_session', caller, focusFor(a, ctx), () =>
        resolveSessionAgent(a.agent),
      );
    },
    async prepareOpenTerminal(caller, raw, ctx) {
      const a = parseTerminalArgs(raw);
      if (isFail(a)) return a;
      const leaf = commandLabel(a.command);
      return prepareOpen(
        'open_terminal',
        caller,
        focusFor({ ...a, label: a.label ?? leaf }, ctx),
        async () =>
          deps.resolveCommand(a.command.command) === undefined
            ? fail('command_not_found', `command not found: ${a.command.command}`)
            : {
                ok: true,
                value: {
                  launch: { kind: 'command', command: a.command },
                  agent: leaf,
                  bare: false,
                  label: undefined,
                },
              },
      );
    },
    async prepareListAgents(caller, raw) {
      const o = parseKeys(raw, []);
      if (isFail(o)) return o;
      return prepared('list_agents', caller, async () => ({
        summary: { tool: 'list_agents' },
        exec: async (token) => {
          token.keep();
          return { ok: true, value: listAgentsOutput(deps.agents()) };
        },
      }));
    },
    async prepareOpenFile(caller, raw) {
      const a = parseFileArgs(raw);
      if (isFail(a)) return a;
      if (a.kind === 'many') {
        return prepared('open_file', caller, async (who) => {
          const abs = a.paths.map((p) => deps.resolvePath(who.home, p));
          const bad = await Promise.all(abs.map((p) => checkKind(p, 'file')));
          // Focus goes to the last file that will open, so a trailing bad path doesn't steal it.
          const lastGood = bad.reduce((last, b, i) => (b === null ? i : last), -1);
          return {
            summary: { tool: 'open_file', path: abs.join(', '), line: null },
            exec: async (token) => {
              const results: OpenFileResult[] = [];
              let opened = 0;
              for (let i = 0; i < abs.length; i++) {
                const path = abs[i];
                const refusal = bad[i];
                if (refusal) {
                  results.push({ path, opened: false, error: refusal.error });
                  continue;
                }
                try {
                  await deps.openFile({
                    callerSessionId: who.sessionId,
                    path,
                    line: undefined,
                    column: undefined,
                    focus: a.focus && i === lastGood,
                  });
                } catch (e) {
                  const err = failed('open_file', caller, e, path);
                  results.push({ path, opened: false, error: err.error });
                  continue;
                }
                opened++;
                results.push({ path, opened: true });
                deps.info('control open', {
                  tool: 'open_file',
                  caller: caller.handle,
                  path,
                });
              }
              if (opened > 0) token.keep();
              return { ok: true, value: { results } };
            },
          };
        });
      }
      return prepared('open_file', caller, async (who) => {
        const abs = deps.resolvePath(who.home, a.path);
        const bad = await checkKind(abs, 'file');
        if (bad) return bad;
        return {
          summary: { tool: 'open_file', path: abs, line: a.line ?? null },
          exec: async (token) => {
            let sessionId: string;
            try {
              ({ sessionId } = await deps.openFile({
                callerSessionId: who.sessionId,
                path: abs,
                line: a.line,
                column: a.column,
                focus: a.focus,
              }));
            } catch (e) {
              return failed('open_file', caller, e, abs);
            }
            token.keep();
            deps.info('control open', {
              tool: 'open_file',
              caller: caller.handle,
              sessionId,
              path: abs,
            });
            return { ok: true, value: { opened: abs, session_id: sessionId } };
          },
        };
      });
    },
  };
}
