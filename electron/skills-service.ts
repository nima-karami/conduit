// Host side of the skill installer (spec docs/specs/2026-07-06-skill-installer.md): enumerate the
// skills bundled with the app and copy one into a project's or the user's `.claude/skills`. Pure
// frontmatter/version/status logic lives in ../src/skills; this file is the I/O + electron glue.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import {
  deriveStatus,
  parseSkillFrontmatter,
  SKILL_ID_RE,
  type SkillDestination,
  type SkillInfo,
  type SkillInstallResult,
} from '../src/skills';

/** The bundled skills dir: `extraResources` puts it next to the app when packaged; the repo's
 *  `resources/skills` in dev (`__dirname` is `out/`, so `../resources/skills` is the repo copy). */
function bundledSkillsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(__dirname, '..', 'resources', 'skills');
}

/** `~/.claude/skills`. `CONDUIT_HOME` overrides `os.homedir()` — the test seam (spec §Test seam);
 *  inert in production, where the env var is never set. */
function globalSkillsRoot(): string {
  return path.join(process.env.CONDUIT_HOME || os.homedir(), '.claude', 'skills');
}

function projectSkillsRoot(projectRoot: string): string {
  return path.join(projectRoot, '.claude', 'skills');
}

function destRoot(dest: SkillDestination, projectRoot: string | null): string | null {
  if (dest === 'global') return globalSkillsRoot();
  return projectRoot ? projectSkillsRoot(projectRoot) : null;
}

/** Version installed at `<root>/<id>/SKILL.md`, or null if absent/unreadable/malformed. */
function installedVersionAt(root: string, id: string): string | null {
  try {
    const md = fs.readFileSync(path.join(root, id, 'SKILL.md'), 'utf8');
    return parseSkillFrontmatter(md)?.version ?? null;
  } catch {
    return null;
  }
}

/** Bundled skill folder ids (each must contain a SKILL.md and have a valid id). */
function bundledIds(): string[] {
  const dir = bundledSkillsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && SKILL_ID_RE.test(e.name))
    .filter((e) => fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** List every bundled skill with its per-destination install status. */
export function listSkills(projectRoot: string | null): SkillInfo[] {
  const dir = bundledSkillsDir();
  const globalRoot = globalSkillsRoot();
  const out: SkillInfo[] = [];
  for (const id of bundledIds()) {
    const fm = parseSkillFrontmatter(fs.readFileSync(path.join(dir, id, 'SKILL.md'), 'utf8'));
    if (!fm) continue; // malformed bundled skill — skip, don't break the list
    const projectVersion = projectRoot
      ? installedVersionAt(projectSkillsRoot(projectRoot), id)
      : null;
    const globalVersion = installedVersionAt(globalRoot, id);
    out.push({
      id,
      name: fm.name,
      description: fm.description,
      version: fm.version,
      project: {
        installedVersion: projectVersion,
        status: deriveStatus(fm.version, projectVersion),
      },
      global: { installedVersion: globalVersion, status: deriveStatus(fm.version, globalVersion) },
    });
  }
  return out;
}

/** Copy a bundled skill into a destination, overwriting any existing copy of that same skill. */
export function installSkill(
  id: string,
  dest: SkillDestination,
  projectRoot: string | null,
): SkillInstallResult {
  if (!SKILL_ID_RE.test(id) || !bundledIds().includes(id)) {
    return { ok: false, error: `Unknown skill: ${id}` };
  }
  const root = destRoot(dest, projectRoot);
  if (!root) return { ok: false, error: 'Open a folder to install into this project.' };
  const from = path.join(bundledSkillsDir(), id);
  // `id` is validated above, so `target` can only ever be `<root>/.claude/skills/<known-skill>`.
  const target = path.join(root, id);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(from, target, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
