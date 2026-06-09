import * as fs from 'fs';
import { AgentDefinition } from './types';

/** Built-in default agent set when the user has no agents.json yet. */
export const DEFAULT_AGENTS: AgentDefinition[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    args: [],
    icon: 'sparkle',
    color: 'magenta',
    cwdStrategy: 'workspaceFolder',
  },
  {
    id: 'shell',
    label: 'Shell',
    command: 'shell',
    args: [],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  },
];

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
