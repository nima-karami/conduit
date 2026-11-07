// The seven app-control tools (spec 2026-10-30-conduit-mcp-app-control §2.1) on the shared
// prepared() pipeline. Node-free: git, folders, windows and the renderer step are deps.
import { extname } from 'node:path';
import { folderKey } from '../folder-key';
import type { RefEndpoint } from '../git-range';
import { decodePatchBytes, MAX_PATCH_BYTES, parsePatch, patchOverSizeCap } from '../patch-parse';
import type { CommitNode } from '../protocol';
import { normalizeUrl } from '../web-url';
import {
  type CallWho,
  type CheckResult,
  type ControlCallContext,
  type ControlDeps,
  type ControlHandlers,
  type ControlTool,
  type Fail,
  fail,
  isFail,
  type Prepared,
  parseKeys,
  parseObject,
  type TargetSession,
} from './control-tools';
import { classifyRef, lookupCommit, repoRootOf } from './git-refs';
import { isValidField, type Reach, windowNotReady } from './tool-policy';
import type { Caller } from './tools';
import type { Result, ToolErrorCode } from './types';
import type { CloseFilesOutcome, McpReviewScope, McpReviewSource, McpUiResult } from './ui-types';

interface CloseSessionOutput {
  closed: string;
}
/** One list-form entry: each target reports on its own, so one refusal never fails the call. */
type CloseSessionEntry =
  | { session: string; closed: true }
  | { session: string; closed: false; error: { code: ToolErrorCode; message: string } };
interface CloseSessionsOutput {
  results: CloseSessionEntry[];
}
interface CloseEntry {
  /** The handle when it resolves, else the name as given. */
  name: string;
  target: TargetSession | Fail;
}
/** The session that closed another: a live caller, never a null-sessionId human. */
type CloseOpener = { handle: Caller['handle']; sessionId: string };
interface FocusSessionOutput {
  focused: string;
}
interface AttachFolderOutput {
  attached: string;
  session_id: string;
  roots: string[];
}
type ReviewSourceOut =
  | { kind: 'working'; scope: McpReviewScope }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; base: RefEndpoint; head: RefEndpoint };
interface OpenReviewOutput {
  opened: 'review';
  source: ReviewSourceOut;
}
interface OpenDiffOutput {
  opened: 'review';
  source: { kind: 'patch' };
}
interface OpenGitHistoryOutput {
  opened: 'git-history';
  selected: string | null;
}
interface OpenUrlOutput {
  opened: string;
}
export const MAX_CLOSE_PATHS = 50;
export const MAX_URL_BYTES = 2048;
export const MAX_CLOSE_SESSIONS = 30;
/** The approval card names this many sessions, then the total. */
const MAX_CLOSE_SUMMARY_NAMES = 8;
const MAX_DIFF_TITLE_CHARS = 200;
const PATCH_FILE_EXTENSIONS = ['.diff', '.patch'] as const;
const isPatchExtension = (p: string): boolean =>
  PATCH_FILE_EXTENSIONS.some((e) => e === extname(p).toLowerCase());
const tooLong = (url: string): boolean => new TextEncoder().encode(url).length > MAX_URL_BYTES;
const urlTooLong = (): Fail =>
  fail('invalid_args', `url must be a string of up to ${MAX_URL_BYTES} bytes`);

type Prepare<T> = (
  caller: Caller,
  args: unknown,
  ctx: ControlCallContext,
) => Promise<Result<Prepared<T>>>;
export interface AppControlHandlers {
  /** close_session's routing, also used by closeWhenDone when a program exits on its own. */
  closeRouted(
    sessionId: string,
    closedBy: CloseOpener | undefined,
    ctx: ControlCallContext,
  ): Promise<Result<CloseSessionOutput>>;
  prepareCloseSession: Prepare<CloseSessionOutput | CloseSessionsOutput>;
  prepareFocusSession: Prepare<FocusSessionOutput>;
  prepareAttachFolder: Prepare<AttachFolderOutput>;
  prepareCloseFiles: Prepare<CloseFilesOutcome>;
  prepareOpenReview: Prepare<OpenReviewOutput>;
  prepareOpenDiff: Prepare<OpenDiffOutput>;
  prepareOpenGitHistory: Prepare<OpenGitHistoryOutput>;
  prepareOpenUrl: Prepare<OpenUrlOutput>;
}

const MAX_SESSION_CHARS = 128;
const MAX_PATH_CHARS = 4096;
const validSessionArg = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_SESSION_CHARS;

const CLOSE_KEYS = ['session', 'sessions', 'children'] as const;
type CloseForm =
  | { form: 'session'; session: unknown }
  | { form: 'sessions'; sessions: string[] }
  | { form: 'children' };

/** Exactly one form. The schema is flat (plan B5), so the host checks the combination. */
function closeFormOf(raw: unknown): CloseForm | Fail {
  const o = parseKeys(raw, CLOSE_KEYS);
  if (isFail(o)) return o;
  if (CLOSE_KEYS.filter((k) => o[k] !== undefined).length !== 1)
    return fail('invalid_args', 'give exactly one of session, sessions or children');
  if (o.children !== undefined)
    return o.children === true
      ? { form: 'children' }
      : fail('invalid_args', 'children must be true');
  if (o.sessions === undefined) return { form: 'session', session: o.session };
  const { sessions } = o;
  if (!Array.isArray(sessions) || sessions.length === 0 || sessions.length > MAX_CLOSE_SESSIONS)
    return fail('invalid_args', `sessions must be 1–${MAX_CLOSE_SESSIONS} handles or ids`);
  if (!sessions.every(validSessionArg))
    return fail(
      'invalid_args',
      `each session must be a handle or id of 1–${MAX_SESSION_CHARS} chars`,
    );
  return { form: 'sessions', sessions };
}
const REVIEW_SCOPES: readonly McpReviewScope[] = ['all', 'staged', 'unstaged'];
const SOURCE_KEYS = {
  working: ['kind', 'scope'],
  commit: ['kind', 'ref'],
  range: ['kind', 'base', 'head'],
} as const;
type ReachTool = 'close_session' | 'focus_session' | 'attach_folder';
const UNKNOWN_SESSION_HINT = 'use a handle from valid; list_sessions shows the current ones';
const REACH_REFUSAL: Record<Exclude<Reach, 'any'>, string> = {
  self: 'this tool may only act on your own session',
  opened: 'this tool may only act on your session and sessions you opened',
  window: 'this tool may only act on sessions in your window',
};

type Who = { sessionId: string; home: string };

export function createAppControlHandlers(
  deps: ControlDeps,
  prepared: ControlHandlers['prepared'],
): AppControlHandlers {
  /** `valid` is the handles this caller may name with this tool: the ones its reach admits. */
  const resolveTarget = (
    v: unknown,
    tool: ReachTool,
    callerId: string,
    reach: Reach | undefined,
  ): TargetSession | Fail => {
    if (!validSessionArg(v))
      return fail('invalid_args', `session must be a handle or id of 1–${MAX_SESSION_CHARS} chars`);
    const all = deps.targets();
    const t = all.find((x) => x.handle === v) ?? all.find((x) => x.sessionId === v);
    if (t) return t;
    return fail('unknown_session', `no session "${v}" in list_sessions`, {
      hint: UNKNOWN_SESSION_HINT,
      valid: all.filter((x) => inReach(tool, reach, callerId, x) === null).map((x) => x.handle),
    });
  };

  /** A reach the tool doesn't offer (absent, or attach_folder's 'any') counts as the narrowest. */
  const inReach = (
    tool: ReachTool,
    reach: Reach | undefined,
    callerId: string,
    t: TargetSession,
  ): Fail | null => {
    const r: Reach = reach !== undefined && isValidField(tool, 'reach', reach) ? reach : 'self';
    if (r === 'any' || t.sessionId === callerId) return null;
    if (r === 'opened' && t.openerSessionId === callerId) return null;
    if (r === 'window') {
      const w = deps.ownerWindowOf(t.sessionId);
      if (w !== null && w === deps.ownerWindowOf(callerId)) return null;
    }
    return fail('out_of_reach', REACH_REFUSAL[r], {
      hint: `widen ${tool}'s reach in Settings → MCP to act on this session`,
    });
  };

  const routeWindow = (sessionId: string): number | Fail => {
    const w = deps.ownerWindowOf(sessionId);
    return w === null || !deps.windowReady(w) ? { ok: false, error: windowNotReady() } : w;
  };

  /** An ask can wait up to 120 s: the target may have closed, moved or left reach by run. */
  const recheckTarget = (
    tool: 'close_session' | 'focus_session' | 'attach_folder',
    targetId: string,
    callerId: string,
    reach: Reach | undefined,
  ): Fail | null => {
    const t = deps.targets().find((x) => x.sessionId === targetId);
    if (!t) return fail('unknown_session', 'that session is no longer in list_sessions');
    return inReach(tool, reach, callerId, t);
  };

  /** The repo must be the caller's own folder: home or an attached root (plan B6). */
  const resolveRepo = async (who: Who, repo: unknown): Promise<Result<string>> => {
    if (repo !== undefined && (typeof repo !== 'string' || repo.length === 0))
      return fail('invalid_args', 'repo must be a non-empty string');
    const f = repo === undefined ? who.home : deps.resolvePath(who.home, repo);
    const folders = deps.foldersOf(who.sessionId);
    const mine = [who.home, ...(folders?.roots ?? [])].map(folderKey);
    if (!mine.includes(folderKey(f)))
      return fail('not_a_repo', 'repo must be your home folder or an attached folder');
    return repoRootOf(deps.git, f);
  };

  const wrongAnswer = (r: McpUiResult): Fail =>
    r.kind === 'unknownSession'
      ? fail('unknown_session', 'that session is not in its window any more')
      : fail(
          'open_failed',
          r.kind === 'failed' ? r.message : `Conduit's window answered ${r.kind}`,
        );

  const logged = (tool: ControlTool, caller: Caller, data: Record<string, unknown>) =>
    deps.info('control app', { tool, caller: caller.handle, ...data });

  /** The caller-routed open tools share their exec: re-route, ask the renderer, expect 'opened'. */
  const openExec =
    <T>(
      tool: ControlTool,
      caller: Caller,
      who: Who,
      ctx: ControlCallContext,
      action: Parameters<ControlCallContext['ui']>[2],
      value: T,
    ) =>
    async (token: { keep(): void }): Promise<Result<T>> => {
      const w = routeWindow(who.sessionId);
      if (isFail(w)) return w;
      const r = await ctx.ui(w, who.sessionId, action);
      if (!r.ok) return r;
      if (r.value.kind !== 'opened') return wrongAnswer(r.value);
      token.keep();
      logged(tool, caller, {});
      return { ok: true, value };
    };

  /**
   * The one close path for a session its program is done with: close_session's, and closeWhenDone's
   * on a program's own exit. A ready owner window runs the renderer's close, which keeps the
   * unsaved-changes guard; otherwise the domain closes it.
   */
  const closeRouted = async (
    sessionId: string,
    closedBy: CloseOpener | undefined,
    ctx: ControlCallContext,
  ): Promise<Result<CloseSessionOutput>> => {
    const currentWindow = deps.ownerWindowOf(sessionId);
    if (currentWindow === null || !deps.windowReady(currentWindow)) {
      const result = await deps.closeSession(sessionId, closedBy ? { closedBy } : {});
      if (!result.ok) return fail(result.code, result.message);
      return { ok: true, value: { closed: sessionId } };
    }
    const r = await ctx.ui(currentWindow, sessionId, { kind: 'closeSession', target: sessionId });
    if (!r.ok) return r;
    const v = r.value;
    if (v.kind !== 'closeSession') return wrongAnswer(v);
    if (!v.ok) return fail('unsaved_changes', `unsaved changes in:\n${v.unsaved.join('\n')}`);
    return { ok: true, value: { closed: sessionId } };
  };

  const windowReadyOf = (sessionId: string): boolean => {
    const w = deps.ownerWindowOf(sessionId);
    return w !== null && deps.windowReady(w);
  };

  /** Reach and existence are checked at the entry's turn, not at prepare: earlier closes may move things. */
  const closeEntry = async (
    caller: Caller,
    who: CallWho,
    e: CloseEntry,
    ctx: ControlCallContext,
  ): Promise<CloseSessionEntry> => {
    const refused = (f: Fail): CloseSessionEntry => ({
      session: e.name,
      closed: false,
      error: { code: f.error.code, message: f.error.message },
    });
    if (isFail(e.target)) return refused(e.target);
    const t = e.target;
    const again = recheckTarget('close_session', t.sessionId, who.sessionId, ctx.reach);
    if (again) return refused(again);
    const charge = who.spend();
    if (isFail(charge)) return refused(charge);
    try {
      const r = await closeRouted(
        t.sessionId,
        { handle: caller.handle, sessionId: who.sessionId },
        ctx,
      );
      // A failed close refunds its token, as a single close does.
      if (!r.ok) {
        charge.refund();
        return refused(r);
      }
      logged('close_session', caller, { target: t.sessionId });
      return { session: e.name, closed: true };
    } catch (err) {
      charge.refund();
      // Reported on this entry: a throw out of the call would hide the entries already closed.
      const message = err instanceof Error ? err.message : String(err);
      deps.info('control call failed', {
        tool: 'close_session',
        caller: caller.handle,
        target: t.sessionId,
        error: message,
      });
      return refused(fail('open_failed', message));
    }
  };

  const closeMany = (
    caller: Caller,
    who: CallWho,
    form: Exclude<CloseForm, { form: 'session' }>,
    ctx: ControlCallContext,
  ): CheckResult<CloseSessionsOutput> => {
    const listed: CloseEntry[] =
      form.form === 'children'
        ? deps
            .targets()
            .filter((t) => t.openerSessionId === who.sessionId && t.sessionId !== who.sessionId)
            .map((t) => ({ name: t.handle, target: t }))
        : form.sessions.map((raw) => {
            const t = resolveTarget(raw, 'close_session', who.sessionId, ctx.reach);
            return { name: isFail(t) ? raw : t.handle, target: t };
          });
    // A session named twice (handle and id, say) closes once; unknown names have no session to match.
    const seen = new Set<string>();
    const entries = listed.filter((e) => {
      if (isFail(e.target)) return true;
      if (seen.has(e.target.sessionId)) return false;
      seen.add(e.target.sessionId);
      return true;
    });
    // Nothing to close is known at prepare: no card, no token spent.
    if (entries.length === 0) return { done: { ok: true, value: { results: [] } } };
    const routesUi = entries.some((e) => !isFail(e.target) && windowReadyOf(e.target.sessionId));
    return {
      summary: {
        tool: 'close_session',
        targets: entries.slice(0, MAX_CLOSE_SUMMARY_NAMES).map((e) => e.name),
        total: entries.length,
      },
      ...(routesUi ? { routesUi: true as const } : {}),
      exec: async (token) => {
        // The call's own token gives way to one per target attempted.
        token.refund();
        const results: CloseSessionEntry[] = [];
        for (const e of entries) results.push(await closeEntry(caller, who, e, ctx));
        return { ok: true, value: { results } };
      },
    };
  };

  return {
    closeRouted,
    prepareCloseSession: (caller, raw, ctx) =>
      prepared<CloseSessionOutput | CloseSessionsOutput>('close_session', caller, async (who) => {
        const form = closeFormOf(raw);
        if (isFail(form)) return form;
        if (form.form !== 'session') return closeMany(caller, who, form, ctx);
        const t = resolveTarget(form.session, 'close_session', who.sessionId, ctx.reach);
        if (isFail(t)) return t;
        const out = inReach('close_session', ctx.reach, who.sessionId, t);
        if (out) return out;
        const ownerWindow = deps.ownerWindowOf(t.sessionId);
        const windowReady = ownerWindow !== null && deps.windowReady(ownerWindow);
        return {
          summary: { tool: 'close_session', target: t.handle },
          ...(windowReady ? { routesUi: true as const } : {}),
          exec: async (token) => {
            const again = recheckTarget('close_session', t.sessionId, who.sessionId, ctx.reach);
            if (again) return again;
            const r = await closeRouted(
              t.sessionId,
              { handle: caller.handle, sessionId: who.sessionId },
              ctx,
            );
            if (!r.ok) return r;
            token.keep();
            logged('close_session', caller, { target: t.sessionId });
            return r;
          },
        };
      }),

    prepareFocusSession: (caller, raw, ctx) =>
      prepared('focus_session', caller, async (who) => {
        const o = parseKeys(raw, ['session']);
        if (isFail(o)) return o;
        const t = resolveTarget(o.session, 'focus_session', who.sessionId, ctx.reach);
        if (isFail(t)) return t;
        const out = inReach('focus_session', ctx.reach, who.sessionId, t);
        if (out) return out;
        if (ctx.move === 'no')
          return fail('move_not_allowed', "focus_session is set to never switch the human's view");
        const w = routeWindow(t.sessionId);
        if (isFail(w)) return w;
        return {
          summary: { tool: 'focus_session', target: t.handle },
          exec: async (token) => {
            const again = recheckTarget('focus_session', t.sessionId, who.sessionId, ctx.reach);
            if (again) return again;
            const w2 = routeWindow(t.sessionId);
            if (isFail(w2)) return w2;
            // A target in another window would switch out of sight: raise it (plan B12).
            deps.activateSession(t.sessionId, w2 !== deps.ownerWindowOf(who.sessionId));
            token.keep();
            logged('focus_session', caller, { target: t.sessionId });
            return { ok: true, value: { focused: t.sessionId } };
          },
        };
      }),

    prepareAttachFolder: (caller, raw, ctx) =>
      prepared('attach_folder', caller, async (who) => {
        const o = parseObject(raw, ['path', 'session']);
        if (isFail(o)) return o;
        // Relative to the caller's home, whichever session it attaches to (spec §2.1).
        const abs = deps.resolvePath(who.home, o.path as string);
        const named = o.session !== undefined;
        let target: { sessionId: string; handle: string } = {
          sessionId: who.sessionId,
          handle: caller.handle,
        };
        if (named) {
          const t = resolveTarget(o.session, 'attach_folder', who.sessionId, ctx.reach);
          if (isFail(t)) return t;
          const out = inReach('attach_folder', ctx.reach, who.sessionId, t);
          if (out) return out;
          target = t;
        }
        return {
          summary: { tool: 'attach_folder', path: abs, target: target.handle },
          exec: async (token) => {
            if (named) {
              const again = recheckTarget(
                'attach_folder',
                target.sessionId,
                who.sessionId,
                ctx.reach,
              );
              if (again) return again;
            }
            const r = await deps.addRoot(target.sessionId, abs);
            // Already home or already attached is the state the agent asked for (plan B3).
            if (!r.ok && r.reason !== 'is-home' && r.reason !== 'duplicate') {
              switch (r.reason) {
                case 'not-found':
                  return fail('path_missing', `no such path: ${abs}`);
                case 'not-a-directory':
                  return fail('not_a_directory', `not a folder: ${abs}`);
                case 'invalid-path':
                  return fail('invalid_args', `not a valid folder path: ${abs}`);
                case 'unknown-session':
                  return fail('unknown_session', 'that session is no longer open');
                default:
                  return fail('attach_refused', `can't attach ${abs}: ${r.reason}`);
              }
            }
            token.keep();
            logged('attach_folder', caller, { target: target.sessionId, path: abs });
            return {
              ok: true,
              value: {
                attached: abs,
                session_id: target.sessionId,
                roots: deps.foldersOf(target.sessionId)?.roots ?? [],
              },
            };
          },
        };
      }),

    prepareCloseFiles: (caller, raw, ctx) =>
      prepared('close_files', caller, async (who) => {
        const o = parseKeys(raw, ['paths', 'all']);
        if (isFail(o)) return o;
        if ((o.paths === undefined) === (o.all === undefined))
          return fail('invalid_args', 'pass exactly one of paths or all');
        let paths: string[] | 'all';
        if (o.all !== undefined) {
          if (o.all !== true) return fail('invalid_args', 'all must be true');
          paths = 'all';
        } else {
          const p = o.paths;
          if (
            !Array.isArray(p) ||
            p.length === 0 ||
            p.length > MAX_CLOSE_PATHS ||
            !p.every((x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_PATH_CHARS)
          )
            return fail(
              'invalid_args',
              `paths must be 1–${MAX_CLOSE_PATHS} non-empty strings of up to ${MAX_PATH_CHARS} chars`,
            );
          paths = p.map((x: string) => deps.resolvePath(who.home, x));
        }
        const w = routeWindow(who.sessionId);
        if (isFail(w)) return w;
        return {
          summary: {
            tool: 'close_files',
            count: paths === 'all' ? 0 : paths.length,
            all: paths === 'all',
          },
          routesUi: true,
          exec: async (token) => {
            const w2 = routeWindow(who.sessionId);
            if (isFail(w2)) return w2;
            const r = await ctx.ui(w2, who.sessionId, { kind: 'closeFiles', paths });
            if (!r.ok) return r;
            const v = r.value;
            if (v.kind !== 'closeFiles') return wrongAnswer(v);
            token.keep();
            logged('close_files', caller, { closed: v.closed.length });
            return {
              ok: true,
              value: {
                closed: v.closed,
                skipped: v.skipped,
                ...(v.truncated ? { truncated: true as const } : {}),
              },
            };
          },
        };
      }),

    prepareOpenReview: (caller, raw, ctx) =>
      prepared('open_review', caller, async (who) => {
        const o = parseKeys(raw, ['source', 'repo']);
        if (isFail(o)) return o;
        const any = parseKeys(o.source, ['kind', 'scope', 'ref', 'base', 'head']);
        if (isFail(any)) return any;
        const kind = any.kind;
        if (kind !== 'working' && kind !== 'commit' && kind !== 'range')
          return fail('invalid_args', 'source.kind must be working, commit or range');
        const s = parseKeys(any, SOURCE_KEYS[kind]);
        if (isFail(s)) return s;
        const str = (k: string): string | Fail => {
          const v = s[k];
          return typeof v === 'string' ? v : fail('invalid_args', `source.${k} must be a string`);
        };
        let scope: McpReviewScope = 'all';
        let ref = '';
        let base = '';
        let head = '';
        if (kind === 'working') {
          if (s.scope !== undefined) {
            const sc = REVIEW_SCOPES.find((x) => x === s.scope);
            if (!sc) return fail('invalid_args', 'source.scope must be all, staged or unstaged');
            scope = sc;
          }
        } else if (kind === 'commit') {
          const r = str('ref');
          if (isFail(r)) return r;
          ref = r;
        } else {
          const b = str('base');
          if (isFail(b)) return b;
          const hd = str('head');
          if (isFail(hd)) return hd;
          base = b;
          head = hd;
        }
        const w = routeWindow(who.sessionId);
        if (isFail(w)) return w;
        const repo = await resolveRepo(who, o.repo);
        if (!repo.ok) return repo;
        const repoRoot = repo.value;
        let source: McpReviewSource;
        let out: ReviewSourceOut;
        let what: string;
        if (kind === 'working') {
          source = { kind: 'working', scope, repoRoot };
          out = { kind: 'working', scope };
          what = 'working';
        } else if (kind === 'commit') {
          const c = await lookupCommit(deps.git, repoRoot, ref);
          if (!c.ok) return c;
          source = { kind: 'commit', sha: c.value.sha, subject: c.value.subject, repoRoot };
          out = { kind: 'commit', sha: c.value.sha };
          what = c.value.sha.slice(0, 7);
        } else {
          if (base === 'working')
            return fail('bad_ref', '"working" is only allowed as a range head');
          const b = await classifyRef(deps.git, repoRoot, base);
          if (!b.ok) return b;
          const hd: Result<RefEndpoint> =
            head === 'working'
              ? { ok: true, value: { kind: 'working' } }
              : await classifyRef(deps.git, repoRoot, head);
          if (!hd.ok) return hd;
          source = { kind: 'range', base: b.value, head: hd.value, repoRoot };
          out = { kind: 'range', base: b.value, head: hd.value };
          what = `${base}…${head}`;
        }
        return {
          summary: { tool: 'open_review', what },
          routesUi: true,
          exec: openExec(
            'open_review',
            caller,
            who,
            ctx,
            { kind: 'openReview', source, focus: true },
            {
              opened: 'review' as const,
              source: out,
            },
          ),
        };
      }),

    prepareOpenDiff: (caller, raw, ctx) =>
      prepared('open_diff', caller, async (who) => {
        const o = parseKeys(raw, ['patch', 'patch_file', 'title', 'focus']);
        if (isFail(o)) return o;
        if ((o.patch === undefined) === (o.patch_file === undefined)) {
          return fail('invalid_args', 'pass exactly one of patch or patch_file');
        }
        if (o.patch !== undefined && typeof o.patch !== 'string') {
          return fail('invalid_args', 'patch must be a string');
        }
        if (o.patch_file !== undefined && typeof o.patch_file !== 'string') {
          return fail('invalid_args', 'patch_file must be a string');
        }
        if (o.title !== undefined && typeof o.title !== 'string') {
          return fail('invalid_args', 'title must be a string');
        }
        if (o.title !== undefined && o.title.length === 0) {
          return fail('invalid_args', 'title must be a non-empty string');
        }
        if (o.title !== undefined && o.title.length > MAX_DIFF_TITLE_CHARS) {
          return fail('invalid_args', `title must be ${MAX_DIFF_TITLE_CHARS} characters or fewer`);
        }
        if (o.focus !== undefined && typeof o.focus !== 'boolean') {
          return fail('invalid_args', 'focus must be a boolean');
        }
        let patchText: string;
        let patchFilePath: string | undefined;
        if (o.patch !== undefined) {
          patchText = o.patch;
        } else {
          const filePath = deps.resolvePath(who.home, o.patch_file as string);
          if (!isPatchExtension(filePath)) {
            return fail('invalid_args', 'patch_file must have a .diff or .patch extension');
          }
          const real = await deps.realPath(filePath);
          if (real === null) return fail('path_missing', `no such file: ${filePath}`);
          if (!isPatchExtension(real)) {
            return fail('invalid_args', 'patch_file must have a .diff or .patch extension');
          }
          // A FIFO named *.patch blocks a libuv thread forever on Mac/Linux, before approval.
          const kind = await deps.kindOf(real);
          if (kind !== 'file') {
            return fail('invalid_args', 'patch_file is not a regular file');
          }
          const bytes = await deps.readBytes(real, MAX_PATCH_BYTES + 1);
          if (bytes === null) return fail('path_missing', `could not read: ${real}`);
          if (bytes.length > MAX_PATCH_BYTES) {
            return fail('invalid_args', 'patch exceeds 5 MB size cap');
          }
          patchFilePath = real;
          patchText = decodePatchBytes(bytes);
        }
        if (patchOverSizeCap(patchText)) {
          return fail('invalid_args', 'patch exceeds 5 MB size cap');
        }
        const parsed = parsePatch(patchText);
        if (!parsed.ok) return fail('invalid_args', parsed.reason);
        const files = parsed.files;
        const title = typeof o.title === 'string' ? o.title : undefined;
        const summaryTitle = title ?? files[0]?.path ?? 'diff';
        const w = routeWindow(who.sessionId);
        if (isFail(w)) return w;
        const focus = o.focus !== false;
        return {
          summary: {
            tool: 'open_diff',
            title: summaryTitle,
            ...(patchFilePath !== undefined ? { path: patchFilePath } : {}),
          },
          routesUi: true,
          exec: openExec(
            'open_diff',
            caller,
            who,
            ctx,
            {
              kind: 'openReview',
              source: { kind: 'patch', files, title, handle: caller.handle },
              focus,
            },
            { opened: 'review' as const, source: { kind: 'patch' } },
          ),
        };
      }),

    prepareOpenGitHistory: (caller, raw, ctx) =>
      prepared('open_git_history', caller, async (who) => {
        const o = parseKeys(raw, ['repo', 'ref']);
        if (isFail(o)) return o;
        if (o.ref !== undefined && typeof o.ref !== 'string')
          return fail('invalid_args', 'ref must be a string');
        const w = routeWindow(who.sessionId);
        if (isFail(w)) return w;
        const repo = await resolveRepo(who, o.repo);
        if (!repo.ok) return repo;
        let commit: CommitNode | null = null;
        if (typeof o.ref === 'string') {
          const c = await lookupCommit(deps.git, repo.value, o.ref);
          if (!c.ok) return c;
          commit = c.value;
        }
        return {
          summary: { tool: 'open_git_history', ref: typeof o.ref === 'string' ? o.ref : null },
          routesUi: true,
          exec: openExec(
            'open_git_history',
            caller,
            who,
            ctx,
            { kind: 'openGitHistory', repoRoot: repo.value, commit },
            { opened: 'git-history' as const, selected: commit?.sha ?? null },
          ),
        };
      }),

    prepareOpenUrl: (caller, raw, ctx) =>
      prepared('open_url', caller, async (who) => {
        const o = parseKeys(raw, ['url', 'focus']);
        if (isFail(o)) return o;
        if (typeof o.url !== 'string' || tooLong(o.url)) return urlTooLong();
        if (o.focus !== undefined && typeof o.focus !== 'boolean')
          return fail('invalid_args', 'focus must be a boolean');
        // The renderer's own validator, so the host never hands it a URL it would refuse.
        const url = normalizeUrl(o.url);
        if (url === null) return fail('bad_url', 'only http and https URLs can be opened');
        // Normalizing percent-encodes, which can triple a URL's bytes.
        if (tooLong(url)) return urlTooLong();
        const w = routeWindow(who.sessionId);
        if (isFail(w)) return w;
        return {
          summary: { tool: 'open_url', url },
          routesUi: true,
          exec: openExec(
            'open_url',
            caller,
            who,
            ctx,
            { kind: 'openUrl', url, focus: o.focus !== false },
            { opened: url },
          ),
        };
      }),
  };
}
