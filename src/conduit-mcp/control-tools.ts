// The three control tools (spec 2026-10-27-conduit-mcp-control-tools §3.1). No IO here: stat,
// registry, command resolution and session creation are deps, so tests run on POSIX fakes.
import { coerceSessionCommand, commandLabel } from '../session-command';
import type { SessionCommand, SessionOpener } from '../types';
import type { Caller } from './tools';
import { type Handle, type Result, type ToolErrorCode, toolError } from './types';

export const OPEN_RATE_PER_CALLER = 10;
export const OPEN_RATE_GLOBAL = 20;
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
}
export interface ControlHandlers {
  openSession(caller: Caller, args: unknown): Promise<Result<OpenSessionOutput>>;
  openTerminal(caller: Caller, args: unknown): Promise<Result<OpenSessionOutput>>;
  openFile(caller: Caller, args: unknown): Promise<Result<OpenFileOutput>>;
}

type Fail = { ok: false; error: ReturnType<typeof toolError> };
const fail = (code: ToolErrorCode, message: string): Fail => ({
  ok: false,
  error: toolError(code, message),
});
const isFail = (v: unknown): v is Fail =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface Common {
  path: string;
  label: string | undefined;
  focus: boolean;
}

function parseObject(raw: unknown, allowed: readonly string[]): Record<string, unknown> | Fail {
  if (!isRecord(raw)) return fail('invalid_args', 'arguments must be an object');
  const extra = Object.keys(raw).find((k) => !allowed.includes(k));
  if (extra !== undefined) return fail('invalid_args', `unknown argument: ${extra}`);
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
  const command = coerceSessionCommand({ command: o.command, args: o.args ?? [] });
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

/** Times of reserved or completed opens, oldest first. */
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

export function createControlHandlers(deps: ControlDeps): ControlHandlers {
  const global = new Window();
  const perCaller = new Map<Handle, Window>();

  /**
   * Reserves a slot synchronously, before any await, so concurrent calls can't all pass the
   * check; the returned release undoes it when the open then fails (only successes are charged).
   */
  function reserve(caller: Caller): (() => void) | Fail {
    const now = deps.now();
    let mine = perCaller.get(caller.handle);
    if (!mine) {
      mine = new Window();
      perCaller.set(caller.handle, mine);
    }
    if (mine.count(now) >= OPEN_RATE_PER_CALLER)
      return fail('rate_limited', `more than ${OPEN_RATE_PER_CALLER} opens in a minute`);
    if (global.count(now) >= OPEN_RATE_GLOBAL)
      return fail('rate_limited', 'too many opens in Conduit this minute');
    mine.add(now);
    global.add(now);
    const w = mine;
    return () => {
      w.release(now);
      global.release(now);
    };
  }

  function home(caller: Caller): { sessionId: string; home: string } | Fail {
    const home = caller.sessionId === null ? undefined : deps.homeOf(caller.sessionId);
    if (caller.sessionId === null || home === undefined)
      return fail('not_in_session', 'this MCP connection is not a Conduit session');
    return { sessionId: caller.sessionId, home };
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

  async function open(
    tool: 'open_session' | 'open_terminal',
    caller: Caller,
    a: Common,
    launch: McpLaunch,
    agent: string,
  ): Promise<Result<OpenSessionOutput>> {
    const release = reserve(caller);
    if (isFail(release)) return release;
    let opened = false;
    try {
      const who = home(caller);
      if (isFail(who)) return who;
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
      const outcome = await deps.openSession({
        callerSessionId: who.sessionId,
        openedBy: { handle: caller.handle, sessionId: who.sessionId },
        home: abs,
        label: a.label,
        focus: a.focus,
        launch,
      });
      if (!outcome.ok) return fail(outcome.code, outcome.message);
      opened = true;
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
    } finally {
      if (!opened) release();
    }
  }

  return {
    async openSession(caller, raw) {
      const a = parseSessionArgs(raw);
      if (isFail(a)) return a;
      return open('open_session', caller, a, { kind: 'agent', agentId: a.agent }, a.agent);
    },
    async openTerminal(caller, raw) {
      const a = parseTerminalArgs(raw);
      if (isFail(a)) return a;
      return open(
        'open_terminal',
        caller,
        a,
        { kind: 'command', command: a.command },
        commandLabel(a.command),
      );
    },
    async openFile(caller, raw) {
      const a = parseFileArgs(raw);
      if (isFail(a)) return a;
      const who = home(caller);
      if (isFail(who)) return who;
      const abs = deps.resolvePath(who.home, a.path);
      const bad = await checkKind(abs, 'file');
      if (bad) return bad;
      const { sessionId } = await deps.openFile({
        callerSessionId: who.sessionId,
        path: abs,
        line: a.line,
        column: a.column,
        focus: a.focus,
      });
      deps.info('control open', { tool: 'open_file', caller: caller.handle, sessionId, path: abs });
      return { ok: true, value: { opened: abs, session_id: sessionId } };
    },
  };
}
