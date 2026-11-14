// see POL §4.1
import * as path from 'node:path';
import type { PolicyTarget } from './policy-types';
import type { ToolName } from './tool-policy';
import { HUMAN_HANDLE } from './types';

export interface SessionRef {
  id: string;
  cwd: string | null;
  projectId: string | null;
}

export interface TargetDeps {
  sessionByHandle(h: string): SessionRef | null;
  childrenOf(sessionId: string): SessionRef[];
  realPath(p: string): string | null;
}

export interface TargetCaller {
  sessionId: string;
  home: string | null;
}

type Args = Record<string, unknown>;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const oneString = (v: unknown): string[] => (typeof v === 'string' ? [v] : []);

const sessionTarget = (s: SessionRef): PolicyTarget => ({
  sessionId: s.id,
  path: null,
  folder: s.cwd,
  projectId: s.projectId,
});

function sessionTargets(sessions: readonly SessionRef[]): PolicyTarget[] {
  const seen = new Set<string>();
  const out: PolicyTarget[] = [];
  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(sessionTarget(s));
  }
  return out;
}

function handleRefs(handles: readonly string[], deps: TargetDeps): SessionRef[] {
  const found: SessionRef[] = [];
  for (const h of handles) {
    const s = deps.sessionByHandle(h);
    if (s !== null) found.push(s);
  }
  return found;
}

// A relative path is relative to the caller's home, as the tool descriptions state. A relative
// path with no home cannot be placed, so it yields no target: the engine then uses the home.
function absolutePath(raw: string, caller: TargetCaller): string | null {
  if (path.isAbsolute(raw)) return raw;
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

export function resolveTargets(
  tool: ToolName,
  args: Args,
  caller: TargetCaller,
  deps: TargetDeps,
): PolicyTarget[] {
  switch (tool) {
    case 'close_session': {
      const children = args.children === true ? deps.childrenOf(caller.sessionId) : [];
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
      return folderTargets(oneString(args.path), caller, deps);
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
