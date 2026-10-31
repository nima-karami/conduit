// The three open tools (spec 2026-10-27-conduit-mcp-control-tools §3.1) and the pipeline every
// control tool shares; the app-control tools live in app-control-tools.ts. No IO here: stat,
// registry, command resolution, session creation and git are deps, so tests run on POSIX fakes.
import { coerceSessionCommand, commandLabel } from '../session-command';
import type { SessionOpResult } from '../session-ops';
import type { SessionCommand, SessionOpener } from '../types';
import type { GitCall } from './git-refs';
import {
  type MESSAGING_TOOL_NAMES,
  type Move,
  type Reach,
  TOOL_SPECS,
  type ToolName,
} from './tool-policy';
import type { Caller } from './tools';
import { type Handle, type Result, type ToolError, type ToolErrorCode, toolError } from './types';
import type { AskSummary, McpUiAction, McpUiResult } from './ui-types';

// spec 2026-10-30-conduit-mcp-tool-policy §3.3 "Rate"
export const ACT_RATE_PER_CALLER = 10;
export const ACT_RATE_GLOBAL = 20;
export const SHOW_RATE_PER_CALLER = 30;
export const MAX_LABEL_CHARS = 80;
const RATE_WINDOW_MS = 60_000;

export interface OpenSessionOutput {
  session_id: string;
  handle: Handle | null;
  label: string;
  agent: string;
}
export interface OpenFileOutput {
  opened: string;
  session_id: string;
}
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
}
export type McpOpenOutcome =
  | { ok: true; sessionId: string; label: string }
  | { ok: false; code: 'unknown_agent' | 'brief_unavailable'; message: string };
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
  /** Persisted home of a live session; undefined ⇒ not_in_session. */
  homeOf(sessionId: string): string | undefined;
  resolvePath(home: string, p: string): string;
  kindOf(absPath: string): Promise<PathKind>;
  agentIds(): string[];
  resolveCommand(command: string): string | undefined;
  openSession(req: McpOpenRequest): Promise<McpOpenOutcome>;
  openFile(req: McpFileRequest): Promise<{ sessionId: string }>;
  claimHandle(sessionId: string): Handle | null;
  now(): number;
  info(message: string, data: Record<string, unknown>): void;
  foldersOf(sessionId: string): { home: string; roots: string[] } | undefined;
  addRoot(sessionId: string, path: string): Promise<SessionOpResult>;
  /** raise: the target's window isn't the caller's (show + focus it, as moveSessionToWindow does). */
  activateSession(sessionId: string, raise: boolean): void;
  git: GitCall;
  /** list_sessions' sessions: the only ones a tool may target (tool-policy spec A7). */
  targets(): readonly TargetSession[];
  ownerWindowOf(sessionId: string): number | null;
  windowReady(windowId: number): boolean;
}
export interface TargetSession {
  sessionId: string;
  handle: Handle;
  openerSessionId: string | null;
}
export interface PreparedCall<T> {
  summary: AskSummary;
  /** Its run waits on a renderer (mcp:ui): the ask budget shrinks by UI_TIMEOUT_MS. */
  routesUi: boolean;
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
  ): Promise<Result<PreparedCall<OpenSessionOutput>>>;
  prepareOpenTerminal(
    caller: Caller,
    args: unknown,
    ctx: ControlCallContext,
  ): Promise<Result<PreparedCall<OpenSessionOutput>>>;
  prepareOpenFile(
    caller: Caller,
    args: unknown,
    ctx: ControlCallContext,
  ): Promise<Result<PreparedCall<OpenFileOutput>>>;
  /** reserve → home → check → refund unless the exec kept the token. */
  prepared<T>(
    tool: ControlTool,
    caller: Caller,
    check: (who: { sessionId: string; home: string }) => Promise<CheckResult<T>>,
  ): Promise<Result<PreparedCall<T>>>;
}

export type Fail = { ok: false; error: ToolError };
export const fail = (code: ToolErrorCode, message: string): Fail => ({
  ok: false,
  error: toolError(code, message),
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

function common(o: Record<string, unknown>, label: string | undefined): Common {
  return { path: o.path as string, label, focus: o.focus !== false };
}

function parseSessionArgs(raw: unknown): (Common & { agent: string }) | Fail {
  const o = parseObject(raw, ['path', 'agent', 'label', 'focus']);
  if (isFail(o)) return o;
  if (typeof o.agent !== 'string') return fail('invalid_args', 'agent must be a string');
  const label = parseLabel(o.label);
  if (isFail(label)) return label;
  return { ...common(o, label), agent: o.agent };
}

function parseTerminalArgs(raw: unknown): (Common & { command: SessionCommand }) | Fail {
  const o = parseObject(raw, ['path', 'command', 'args', 'label', 'focus']);
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
  return { ...common(o, label), command };
}

const position = (v: unknown): v is number | undefined =>
  v === undefined || (Number.isInteger(v) && (v as number) >= 1);

function parseFileArgs(
  raw: unknown,
): (Common & { line: number | undefined; column: number | undefined }) | Fail {
  const o = parseObject(raw, ['path', 'line', 'column', 'focus']);
  if (isFail(o)) return o;
  if (!position(o.line) || !position(o.column))
    return fail('invalid_args', 'line and column must be integers ≥ 1');
  return { ...common(o, undefined), line: o.line, column: o.column };
}

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
type CheckResult<T> =
  | Fail
  | { summary: AskSummary; routesUi?: true; exec: (token: Token) => Promise<Result<T>> };

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
      return fail('not_in_session', 'this MCP connection is not a Conduit session');
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
    check: (who: { sessionId: string; home: string }) => Promise<CheckResult<T>>,
  ): Promise<Result<PreparedCall<T>>> {
    const token = reserve(tool, caller);
    if (isFail(token)) return token;
    let handed = false;
    try {
      const who = home(caller);
      if (isFail(who)) return who;
      let c: CheckResult<T>;
      try {
        c = await check(who);
      } catch (e) {
        return failed(tool, caller, e);
      }
      if (isFail(c)) return c;
      const exec = c.exec;
      handed = true;
      return {
        ok: true,
        value: {
          summary: c.summary,
          routesUi: c.routesUi === true,
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

  function prepareOpen(
    tool: 'open_session' | 'open_terminal',
    caller: Caller,
    a: Common,
    launch: McpLaunch,
    agent: string,
  ): Promise<Result<PreparedCall<OpenSessionOutput>>> {
    return prepared(tool, caller, async (who) => {
      const abs = deps.resolvePath(who.home, a.path);
      const bad = await checkKind(abs, 'dir');
      if (bad) return bad;
      if (launch.kind === 'agent') {
        const ids = deps.agentIds();
        if (!ids.includes(launch.agentId))
          return fail(
            'unknown_agent',
            `unknown agent "${launch.agentId}"; registered: ${ids.join(', ')}`,
          );
      } else if (deps.resolveCommand(launch.command.command) === undefined) {
        return fail('command_not_found', `command not found: ${launch.command.command}`);
      }
      const summary: AskSummary =
        launch.kind === 'agent'
          ? { tool: 'open_session', path: abs, agent, focus: a.focus }
          : {
              tool: 'open_terminal',
              path: abs,
              command: [launch.command.command, ...launch.command.args].join(' '),
              focus: a.focus,
            };
      return {
        summary,
        exec: async (token) => {
          let outcome: McpOpenOutcome;
          try {
            outcome = await deps.openSession({
              callerSessionId: who.sessionId,
              openedBy: { handle: caller.handle, sessionId: who.sessionId },
              home: abs,
              label: a.label,
              focus: a.focus,
              launch,
            });
          } catch (e) {
            return failed(tool, caller, e, abs);
          }
          if (!outcome.ok) return fail(outcome.code, outcome.message);
          token.keep();
          deps.info('control open', {
            tool,
            caller: caller.handle,
            sessionId: outcome.sessionId,
            path: abs,
          });
          return {
            ok: true,
            value: {
              session_id: outcome.sessionId,
              handle: deps.claimHandle(outcome.sessionId),
              label: outcome.label,
              agent,
            },
          };
        },
      };
    });
  }

  // spec 2026-10-30-conduit-mcp-tool-policy §3.2: move:no runs a focus:true open as focus:false.
  const focusFor = (a: Common, ctx: ControlCallContext): Common =>
    ctx.move === 'no' ? { ...a, focus: false } : a;

  return {
    prepared,
    async prepareOpenSession(caller, raw, ctx) {
      const a = parseSessionArgs(raw);
      if (isFail(a)) return a;
      return prepareOpen(
        'open_session',
        caller,
        focusFor(a, ctx),
        { kind: 'agent', agentId: a.agent },
        a.agent,
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
        { kind: 'command', command: a.command },
        leaf,
      );
    },
    async prepareOpenFile(caller, raw) {
      const a = parseFileArgs(raw);
      if (isFail(a)) return a;
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
