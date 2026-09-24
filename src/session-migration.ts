import { createHash } from 'node:crypto';
import { folderKey } from './folder-key';
import type { SessionsParse } from './persistence';
import type { ProjectsLoad } from './project-store';
import { sessionNameFromPath } from './session-name';
import type { Project, Session } from './types';

export interface StartupBackup {
  from: 'sessions.json' | 'projects.json';
  to: string;
  overwrite: boolean;
}

export interface StartupModel {
  sessions: Session[];
  projects: Project[];
  projectsWritable: boolean;
  backups: StartupBackup[];
  writeProjects: boolean;
  writeSessions: boolean;
  warnings: string[];
}

const projectIdForKey = (key: string) =>
  `p-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;

const DRIVE_ROOT = /^[a-zA-Z]:[\\/]?$/;

const projectNameForHome = (home: string) =>
  DRIVE_ROOT.test(home) ? home : sessionNameFromPath(home);

/** Pure startup migration; the rules are mf-model plan "Contracts › session-migration". */
export function buildStartupModel(input: {
  sessions: SessionsParse | null;
  projects: ProjectsLoad;
}): StartupModel {
  const load = input.projects;
  const cleanIds = load.kind === 'absent' || load.kind === 'ok';
  const projectsWritable = cleanIds || load.kind === 'corrupt';
  const loaded = load.kind === 'ok' ? load.projects : [];
  const projects = [...loaded];
  const known = new Set(projects.map((p) => p.id));

  const ensureProject = (id: string, home: string) => {
    if (known.has(id) || !projectsWritable) return;
    const order = projects.reduce((max, p) => Math.max(max, p.order), -1) + 1;
    projects.push({ id, name: projectNameForHome(home), order });
    known.add(id);
  };

  const parsed = input.sessions?.kind === 'ok' ? input.sessions : null;
  const legacy = new Set(parsed?.legacyIds ?? []);
  const sessions = (parsed?.sessions ?? []).map((original): Session => {
    const s = { ...original };
    const ownId = projectIdForKey(folderKey(s.home));
    if (legacy.has(s.id)) {
      ensureProject(ownId, s.home);
      s.projectId = ownId;
    } else if (s.projectId !== undefined && !known.has(s.projectId) && cleanIds) {
      if (s.projectId === ownId) ensureProject(ownId, s.home);
      else delete s.projectId;
    }
    return s;
  });

  const backups: StartupBackup[] = [];
  const warnings: string[] = [];
  if (legacy.size > 0)
    backups.push({ from: 'sessions.json', to: 'sessions.pre-mf.bak.json', overwrite: false });
  if (load.kind === 'corrupt') {
    backups.push({ from: 'projects.json', to: 'projects.corrupt.json', overwrite: true });
    warnings.push('projects.json is corrupt: backed up to projects.corrupt.json, loaded empty');
  } else if (load.kind === 'unreadable') {
    warnings.push(`projects.json unreadable (${load.code}): project writes blocked this run`);
  } else if (load.kind === 'future') {
    warnings.push(
      `projects.json version ${load.version} is newer than this build: left untouched, project writes blocked this run`,
    );
  }

  return {
    sessions,
    projects,
    projectsWritable,
    backups,
    writeProjects: projectsWritable && projects.length !== loaded.length,
    writeSessions: legacy.size > 0,
    warnings,
  };
}
