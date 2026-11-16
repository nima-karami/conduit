// see POL §4.1
import * as path from 'node:path';
import { isSshTarget } from '../network/ssh-argv';
import type { SessionOpener } from '../types';
import type { PolicyTarget } from './policy-types';
import type { ToolName } from './tool-policy';
import { HUMAN_HANDLE } from './types';

export interface PolicyTargetSession {
  id: string;
  cwd: string | null;
  projectId: string | null;
}

export interface TargetDeps {
  // Resolves a handle or a session id.
  sessionByHandle(h: string): PolicyTargetSession | null;
  childrenOf(sessionId: string): PolicyTargetSession[];
  realPath(p: string): string | null;
}

export interface TargetCaller {
  /** Null for a remote lead, which has no session here (plan decision 4). */
  sessionId: string | null;
  home: string | null;
}

type Args = Record<string, unknown>;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const oneString = (v: unknown): string[] => (typeof v === 'string' ? [v] : []);

const sessionTarget = (s: PolicyTargetSession): PolicyTarget => ({
  sessionId: s.id,
  path: null,
  folder: s.cwd,
  projectId: s.projectId,
});

function sessionTargets(sessions: readonly PolicyTargetSession[]): PolicyTarget[] {
  const seen = new Set<string>();
  const out: PolicyTarget[] = [];
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(sessionTarget(s));
  }
  return out;
}

function handleRefs(handles: readonly string[], deps: TargetDeps): PolicyTargetSession[] {
  const found: PolicyTargetSession[] = [];
  for (const h of handles) {
    const s = deps.sessionByHandle(h);
    if (s !== null) found.push(s);
  }
  return found;
}

function absolutePath(raw: string, caller: TargetCaller): string | null {
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return caller.home === null ? null : path.resolve(caller.home, raw);
}

function realOf(raw: string, caller: TargetCaller, deps: TargetDeps): string | null {
  const abs = absolutePath(raw, caller);
  return abs === null ? null : (deps.realPath(abs) ?? abs);
}

function folderTargets(
  raw: readonly string[],
  caller: TargetCaller,
  deps: TargetDeps,
): PolicyTarget[] {
  const out: PolicyTarget[] = [];
  for (const p of raw) {
    const real = realOf(p, caller, deps);
    if (real !== null) out.push({ sessionId: null, path: real, folder: real, projectId: null });
  }
  return out;
}

function fileTargets(
  raw: readonly string[],
  caller: TargetCaller,
  deps: TargetDeps,
): PolicyTarget[] {
  const out: PolicyTarget[] = [];
  for (const p of raw) {
    const real = realOf(p, caller, deps);
    if (real !== null) {
      out.push({ sessionId: null, path: real, folder: path.dirname(real), projectId: null });
    }
  }
  return out;
}

/**
 * A remote principal reaches a session only when it opened it (reach `opened`). A remote lead's
 * handle is only unique on its own machine, so the machine must match too.
 */
export function openedByRemote(
  opener: SessionOpener | null | undefined,
  principal: { handle: string; machineId: string },
): boolean {
  return opener?.machineId === principal.machineId && opener.handle === principal.handle;
}

/**
 * True when a connect_machine names an ssh target this side has never added (spec 4.6, RS-D6): the
 * owner must see it whatever the profile says. A value that is no target can't dial, so it isn't
 * asked about; it fails as machine_unknown instead.
 */
export function forcesAsk(
  tool: ToolName,
  args: Args,
  machineKnown: (ref: string) => boolean,
): boolean {
  if (tool !== 'connect_machine') return false;
  const machine = args.machine;
  if (typeof machine !== 'string' || machine.length === 0) return false;
  return isSshTarget(machine) && !machineKnown(machine);
}

export function resolveTargets(
  tool: ToolName,
  args: Args,
  caller: TargetCaller,
  deps: TargetDeps,
): PolicyTarget[] {
  switch (tool) {
    case 'close_session': {
      const children =
        args.children === true && caller.sessionId !== null
          ? deps.childrenOf(caller.sessionId)
          : [];
      const explicit = handleRefs([...oneString(args.session), ...strings(args.sessions)], deps);
      return sessionTargets([...children, ...explicit]);
    }
    case 'send_input':
    case 'read_screen':
    case 'focus_session':
      return sessionTargets(handleRefs(oneString(args.session), deps));
    case 'send_message':
      return sessionTargets(
        handleRefs(
          strings(args.to).filter((h) => h !== HUMAN_HANDLE),
          deps,
        ),
      );
    case 'attach_folder':
      return [
        ...sessionTargets(handleRefs(oneString(args.session), deps)),
        ...folderTargets(oneString(args.path), caller, deps),
      ];
    case 'open_session':
    case 'open_terminal':
      // A path on another machine is no folder of mine, so it names no folder target (CON-40 S3).
      return args.machine === undefined ? folderTargets(oneString(args.path), caller, deps) : [];
    case 'open_review':
    case 'open_git_history':
      return folderTargets(oneString(args.repo), caller, deps);
    case 'open_file':
      return fileTargets([...oneString(args.path), ...strings(args.paths)], caller, deps);
    case 'close_files':
      return fileTargets(strings(args.paths), caller, deps);
    case 'open_diff':
      return fileTargets(oneString(args.patch_file), caller, deps);
    default:
      return [];
  }
}
