import * as fs from 'node:fs';
import * as path from 'node:path';
import { adapterFor } from './conduit-mcp/adapters';
import { parseBriefField } from './role-brief';
import type { AgentBriefSource, AgentDefinition } from './types';

/**
 * Built-in default *agent* set. Empty by design: the New menu offers the
 * terminals/shells auto-detected at runtime ({@link detectShells}). Custom agents
 * (e.g. Claude Code, Aider) are opt-in via the user's agents.json — run them by
 * typing the command inside any shell otherwise.
 */
const DEFAULT_AGENTS: AgentDefinition[] = [];

export interface AgentsConfig {
  defs: AgentDefinition[];
  briefs: Map<string, AgentBriefSource>;
}

/**
 * Load agent definitions from a JSON file (an array of {@link AgentDefinition}),
 * falling back to {@link DEFAULT_AGENTS} when the file is missing or invalid.
 * `brief` is split off into a host-side map so its text never rides `state.agents`
 * (docs/plans/2026-10-26-conduit-role-brief.plan.md, Spec staleness §3.4).
 */
export function loadAgentsConfig(
  file: string,
  opts: {
    homeDir: string;
    e2e: boolean;
    warn: (message: string, data?: Record<string, unknown>) => void;
  },
): AgentsConfig {
  const empty = (): AgentsConfig => ({ defs: [...DEFAULT_AGENTS], briefs: new Map() });
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing or malformed agents.json is the normal first-run state.
    return empty();
  }
  if (!Array.isArray(raw) || raw.length === 0) return empty();

  const defs: AgentDefinition[] = [];
  const briefs = new Map<string, AgentBriefSource>();
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      defs.push(entry as AgentDefinition);
      continue;
    }
    const { brief, ...rest } = entry as Record<string, unknown>;
    const def = rest as unknown as AgentDefinition;
    defs.push(def);
    const source = parseBriefField(brief, {
      agentsDir: path.dirname(file),
      homeDir: opts.homeDir,
      resolve: path.resolve,
    });
    if (source === undefined) continue;
    if (source === 'invalid') {
      opts.warn('agent brief ignored: invalid shape', { id: def.id });
      continue;
    }
    if (!adapterFor(def, { e2e: opts.e2e })?.brief) {
      opts.warn('agent brief ignored: launcher takes no brief', { id: def.id });
      continue;
    }
    briefs.set(def.id, source);
  }
  return { defs, briefs };
}

/** Read the persisted sessions blob, or undefined if none exists. */
export function readBlob(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export type FileRead =
  | { kind: 'absent' }
  | { kind: 'text'; text: string }
  | { kind: 'unreadable'; code: string };

/** 'absent' ONLY for ENOENT — unlike readBlob; see mf-model spec §2.3 (B2). */
export function readFileState(file: string): FileRead {
  try {
    return { kind: 'text', text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', code };
  }
}
