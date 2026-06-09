import * as fs from 'fs';
import { AgentDefinition } from './types';

/**
 * Built-in default *agent* set. Empty by design: the New menu offers the
 * terminals/shells auto-detected at runtime ({@link detectShells}). Custom agents
 * (e.g. Claude Code, Aider) are opt-in via the user's agents.json — run them by
 * typing the command inside any shell otherwise.
 */
export const DEFAULT_AGENTS: AgentDefinition[] = [];

/**
 * Load agent definitions from a JSON file (an array of {@link AgentDefinition}),
 * falling back to {@link DEFAULT_AGENTS} when the file is missing or invalid.
 */
export function loadAgents(file: string): AgentDefinition[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw) && raw.length > 0) return raw as AgentDefinition[];
  } catch {
    /* missing or malformed — use defaults */
  }
  return DEFAULT_AGENTS;
}

/** Read the persisted sessions blob, or undefined if none exists. */
export function readBlob(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
