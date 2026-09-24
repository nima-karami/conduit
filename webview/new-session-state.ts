import { folderKey } from '../src/folder-key';
import { findFolderConflict, MAX_ROOTS } from '../src/folder-validation';
import { firstCmdMetachar } from '../src/launch-args';
import { agentForHome, type NewSessionSeed, type SeedContext } from '../src/new-session-seed';
import { normalizeProjectName } from '../src/project-store';
import type { FolderProbeResult, LaunchPreviewResult } from '../src/protocol';
import { sessionNameFromPath } from '../src/session-name';
import type { AgentDefinition } from '../src/types';

/** 32 folders including home (spec §2.3): one under the host's home + MAX_ROOTS roots. */
export const MAX_DIALOG_FOLDERS = MAX_ROOTS;
export interface FolderProbe {
  exists: boolean;
  branch?: string;
  detached?: boolean;
}
export interface NewSessionState {
  agentId: string;
  /** D13: once true, a home change no longer re-picks the launcher. */
  agentPicked: boolean;
  /** Picked from More; shown as an extra pill when it isn't in the row. */
  extraPillId?: string;
  projectId: string | null;
  /** D7: created at Start. */
  pendingProjectName?: string;
  /** [home, ...roots] in add order. */
  folders: string[];
  /** Keyed by folderKey. */
  probes: Record<string, FolderProbe>;
  flashKey?: string;
  hint?: string;
  phase: 'editing' | 'starting';
  startError?: string;
  projectError?: boolean;
  announce?: string;
}
export type NewSessionAction =
  | { type: 'pickAgent'; id: string; fromMore: boolean }
  | { type: 'addFolder'; path: string }
  | { type: 'removeFolder'; path: string }
  | { type: 'makeHome'; path: string }
  | { type: 'setProject'; projectId: string | null }
  | { type: 'newProject'; name: string }
  | { type: 'probed'; results: FolderProbeResult[] }
  | { type: 'revalidate' }
  | { type: 'start' }
  | { type: 'startFailed'; reason: string; project: boolean };

export interface LaunchPreviewView {
  result?: LaunchPreviewResult;
  loading: boolean;
}
export interface StartBlock {
  reason: string;
}

export function initialNewSessionState(seed: NewSessionSeed): NewSessionState {
  return {
    agentId: seed.agentId,
    agentPicked: false,
    projectId: seed.projectId,
    folders: seed.home === undefined ? [] : [seed.home, ...seed.roots],
    probes: {},
    phase: 'editing',
  };
}

const nameOf = sessionNameFromPath;

/** An edit clears the last add's transient feedback and any failed-start copy. */
const edited = (s: NewSessionState): NewSessionState => ({
  ...s,
  flashKey: undefined,
  hint: undefined,
  startError: undefined,
});

function withHome(s: NewSessionState, folders: string[], ctx: SeedContext): NewSessionState {
  const homeChanged = folders[0] !== s.folders[0];
  const agentId =
    homeChanged && !s.agentPicked ? agentForHome(folders[0], ctx) || s.agentId : s.agentId;
  return { ...s, folders, agentId };
}

export function reduceNewSession(
  s: NewSessionState,
  a: NewSessionAction,
  ctx: SeedContext,
): NewSessionState {
  switch (a.type) {
    case 'pickAgent':
      return {
        ...edited(s),
        agentId: a.id,
        agentPicked: true,
        extraPillId: a.fromMore ? a.id : s.extraPillId,
      };
    case 'addFolder': {
      if (s.folders.length >= MAX_DIALOG_FOLDERS) return s;
      const keys = s.folders.map(folderKey);
      const conflict = findFolderConflict(folderKey(a.path), keys);
      if (conflict?.kind === 'duplicate') {
        return { ...edited(s), flashKey: keys[conflict.index] };
      }
      if (conflict) {
        const other = nameOf(s.folders[conflict.index]);
        const hint =
          conflict.kind === 'inside' ? `Already covered by ${other}` : `Contains ${other}`;
        return { ...edited(s), hint };
      }
      const next = withHome(edited(s), [...s.folders, a.path], ctx);
      return { ...next, announce: `Added ${nameOf(a.path)}` };
    }
    case 'removeFolder': {
      const i = s.folders.findIndex((f) => folderKey(f) === folderKey(a.path));
      // D5: home leaves only as the last folder.
      if (i < 0 || (i === 0 && s.folders.length > 1)) return s;
      const folders = s.folders.filter((_, j) => j !== i);
      return { ...edited(s), folders, announce: `Removed ${nameOf(s.folders[i])}` };
    }
    case 'makeHome': {
      const key = folderKey(a.path);
      const i = s.folders.findIndex((f) => folderKey(f) === key);
      if (i <= 0 || s.probes[key]?.exists === false) return s;
      const [home, ...rest] = s.folders;
      const moved = s.folders[i];
      const folders = [moved, home, ...rest.filter((f) => f !== moved)];
      return { ...withHome(edited(s), folders, ctx), announce: `${nameOf(moved)} is now home` };
    }
    case 'setProject':
      return {
        ...s,
        projectId: a.projectId,
        pendingProjectName: undefined,
        projectError: false,
      };
    case 'newProject': {
      const clean = normalizeProjectName(a.name);
      if (clean === null) return s;
      const match = ctx.projects.find((p) => p.name.toLowerCase() === clean.toLowerCase());
      if (match) return reduceNewSession(s, { type: 'setProject', projectId: match.id }, ctx);
      return { ...s, projectId: null, pendingProjectName: clean, projectError: false };
    }
    case 'probed': {
      const probes = { ...s.probes };
      for (const r of a.results) {
        probes[folderKey(r.path)] = {
          exists: r.exists,
          ...(r.branch === undefined ? {} : { branch: r.branch }),
          ...(r.detached ? { detached: true } : {}),
        };
      }
      return { ...s, probes };
    }
    case 'revalidate': {
      const registered = (id: string | undefined) =>
        id !== undefined && ctx.agents.some((ag) => ag.id === id);
      const projectOk = s.projectId === null || ctx.projects.some((p) => p.id === s.projectId);
      const agentOk = registered(s.agentId);
      const extraOk = s.extraPillId === undefined || registered(s.extraPillId);
      if (projectOk && agentOk && extraOk) return s;
      return {
        ...s,
        projectId: projectOk ? s.projectId : null,
        agentId: agentOk ? s.agentId : agentForHome(s.folders[0], ctx),
        extraPillId: extraOk ? s.extraPillId : undefined,
      };
    }
    case 'start':
      if (s.phase === 'starting') return s;
      return { ...s, phase: 'starting', startError: undefined, projectError: false };
    case 'startFailed':
      return a.project
        ? { ...s, phase: 'editing', projectError: true, announce: "Couldn't create project" }
        : {
            ...s,
            phase: 'editing',
            startError: `Couldn't start session: ${a.reason}`,
            announce: `Couldn't start session: ${a.reason}`,
          };
  }
}

/** Disabled-Start copy, first reason wins; the metachar case is locked L12 S10. */
export function startBlock(
  s: NewSessionState,
  preview: LaunchPreviewView,
  agents: readonly AgentDefinition[],
): StartBlock | null {
  if (agents.length === 0) return { reason: 'No terminals found' };
  if (s.folders.length === 0) return { reason: 'Add a folder to start' };
  if (s.probes[folderKey(s.folders[0])]?.exists === false) {
    return { reason: 'Home folder not found' };
  }
  const skipped = preview.result?.skippedAddDirRoots[0];
  if (skipped !== undefined) {
    const label = agents.find((ag) => ag.id === s.agentId)?.label ?? s.agentId;
    const ext = /\.bat$/i.test(preview.result?.command ?? '') ? '.bat' : '.cmd';
    return {
      reason: `${label} is a ${ext} shim and can't take "${nameOf(skipped)}" (contains ${firstCmdMetachar(skipped)}). Rename the folder or use an .exe install.`,
    };
  }
  return null;
}
