// Pure helpers for the skill installer. No I/O — the host (electron/skills-service.ts) reads the
// bundled + installed SKILL.md files and feeds their text here. See
// docs/specs/2026-07-06-skill-installer.md.

export interface SkillFrontmatter {
  name: string;
  description: string;
  version: string;
}

export type SkillStatus = 'not-installed' | 'installed' | 'update';

/** Where a skill can be installed: the open project, or the machine-global `~/.claude/skills`. */
export type SkillDestination = 'project' | 'global';

export interface SkillDestStatus {
  installedVersion: string | null;
  status: SkillStatus;
}

/** One bundled skill plus its per-destination install state — the shape the Skills panel renders. */
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  version: string; // the bundled version
  project: SkillDestStatus;
  global: SkillDestStatus;
}

export type SkillInstallResult = { ok: true } | { ok: false; error: string };

/** A skill id is a folder name — constrain it so it can never escape the skills dir on copy. */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Read a SKILL.md's leading `---` frontmatter block. Returns the three fields the installer needs,
 * or null if the block is missing or has no `name`. A missing `version` defaults to `0.0.0` (so an
 * old skill authored without one always reads as older than a bundled one). Deliberately minimal —
 * it parses only flat `key: value` lines, which is all a SKILL.md header is.
 */
export function parseSkillFrontmatter(md: string): SkillFrontmatter | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  if (!fields.name) return null;
  return {
    name: fields.name,
    description: fields.description ?? '',
    version: fields.version || '0.0.0',
  };
}

/** Compare dotted-numeric versions. Missing trailing segments count as 0. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const nb = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/** Install status of one destination given the bundled version and what's installed there. */
export function deriveStatus(bundledVersion: string, installedVersion: string | null): SkillStatus {
  if (installedVersion === null) return 'not-installed';
  return compareVersions(bundledVersion, installedVersion) > 0 ? 'update' : 'installed';
}
