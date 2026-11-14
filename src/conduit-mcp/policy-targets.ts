// see POL §4.1
import * as path from 'node:path';
import type { PolicyTarget } from './policy-types';
import type { ToolName } from './tool-policy';

export interface TargetDeps {
  sessionByHandle(h: string): { id: string; cwd: string | null; projectId: string | null } | null;
  realPath(p: string): string | null;
}

type Args = Record<string, unknown>;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const oneString = (v: unknown): string[] => (typeof v === 'string' ? [v] : []);

function sessionTargets(handles: readonly string[], deps: TargetDeps): PolicyTarget[] {
  const out: PolicyTarget[] = [];
  for (const h of handles) {
    const s = deps.sessionByHandle(h);
    if (s === null) continue;
    out.push({ sessionId: s.id, path: null, folder: s.cwd, projectId: s.projectId });
  }
  return out;
}

function folderTargets(raw: readonly string[], deps: TargetDeps): PolicyTarget[] {
  return raw.map((p) => {
    const real = deps.realPath(p) ?? p;
    return { sessionId: null, path: real, folder: real, projectId: null };
  });
}

function fileTargets(raw: readonly string[], deps: TargetDeps): PolicyTarget[] {
  return raw.map((p) => {
    const real = deps.realPath(p) ?? p;
    return { sessionId: null, path: real, folder: path.dirname(real), projectId: null };
  });
}

export function resolveTargets(tool: ToolName, args: Args, deps: TargetDeps): PolicyTarget[] {
  switch (tool) {
    case 'close_session':
      return sessionTargets([...oneString(args.session), ...strings(args.sessions)], deps);
    case 'send_input':
    case 'read_screen':
    case 'focus_session':
      return sessionTargets(oneString(args.session), deps);
    case 'send_message':
      return sessionTargets(
        strings(args.to).filter((h) => h !== 'you'),
        deps,
      );
    case 'open_session':
    case 'open_terminal':
    case 'attach_folder':
      return folderTargets(oneString(args.path), deps);
    case 'open_review':
    case 'open_git_history':
      return folderTargets(oneString(args.repo), deps);
    case 'open_file':
      return fileTargets([...oneString(args.path), ...strings(args.paths)], deps);
    case 'close_files':
      return fileTargets(strings(args.paths), deps);
    case 'open_diff':
      return fileTargets(oneString(args.patch_file), deps);
    default:
      return [];
  }
}
