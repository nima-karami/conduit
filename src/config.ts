import * as fs from 'node:fs';
import * as path from 'node:path';
import { adapterFor } from './conduit-mcp/adapters';
import { parseBriefField } from './role-brief';
import type { AgentBriefSource, AgentCapabilities, AgentDefinition } from './types';

export interface AgentsConfig {
  defs: AgentDefinition[];
  briefs: Map<string, AgentBriefSource>;
}

/** The most agents.json entries Conduit reads; the rest are dropped with one warning. */
export const MAX_AGENTS = 200;
/** capabilities.model_flag: one dash-led flag, as one argv entry (flexible-agent-contracts §4.4). */
const MODEL_FLAG_SHAPE = /^--?[A-Za-z][A-Za-z0-9-]{0,30}$/;
const RESERVED_ID_PREFIXES = ['cli:', 'shell:', 'conduit:'];

type Warn = (message: string, data?: Record<string, unknown>) => void;

export interface AgentsConfigOpts {
  homeDir: string;
  e2e: boolean;
  warn: Warn;
  error: Warn;
  /** The set loaded last time: kept when this file can't be parsed. */
  last?: AgentsConfig;
}

type Parsed = { ok: true; def: AgentDefinition; brief: unknown } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A capabilities field that fails its shape is dropped with a warning; the entry keeps the rest. */
function parseCapabilities(raw: unknown, id: string, warn: Warn): AgentCapabilities | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warn('agent capabilities dropped: not an object', { id });
    return undefined;
  }
  const flag = raw.model_flag;
  if (flag === undefined) return {};
  if (typeof flag === 'string' && MODEL_FLAG_SHAPE.test(flag)) return { model_flag: flag };
  warn('agent capabilities.model_flag dropped: not a single dash-led flag', { id });
  return {};
}

function parseEntry(entry: unknown, warn: Warn): Parsed {
  if (!isRecord(entry)) return { ok: false, reason: 'not an object' };
  const { brief, capabilities, ...rest } = entry;
  const { id } = rest;
  if (typeof id !== 'string' || id.length === 0)
    return { ok: false, reason: 'id must be a non-empty string' };
  if (RESERVED_ID_PREFIXES.some((p) => id.startsWith(p)))
    return { ok: false, reason: `id ${id} is in a reserved namespace` };
  const { command } = rest;
  if (
    typeof command !== 'string' ||
    command.trim() === '' ||
    command.includes('\0') ||
    command.startsWith('-')
  )
    return {
      ok: false,
      reason: 'command must be a non-empty string with no NUL and no leading dash',
    };
  const args = rest.args === undefined ? [] : rest.args;
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))
    return { ok: false, reason: 'args must be an array of strings' };
  const label = rest.label === undefined ? id : rest.label;
  if (typeof label !== 'string') return { ok: false, reason: 'label must be a string' };
  const def = { ...rest, id, label, command, args } as AgentDefinition;
  const caps = parseCapabilities(capabilities, id, warn);
  if (caps !== undefined) def.capabilities = caps;
  return { ok: true, def, brief };
}

/**
 * Load agent definitions from agents.json (an array of {@link AgentDefinition}). Each entry is
 * checked on its own: a bad one is dropped with one warning and the rest load. A missing file is
 * the first-run state; a file that doesn't parse keeps the last good set (flexible-agent-contracts §4.4).
 * `brief` is split off into a host-side map so its text never rides `state.agents`
 * (docs/plans/2026-10-26-conduit-role-brief.plan.md, Spec staleness §3.4).
 */
export function loadAgentsConfig(file: string, opts: AgentsConfigOpts): AgentsConfig {
  const fallback = (): AgentsConfig => opts.last ?? { defs: [], briefs: new Map() };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { defs: [], briefs: new Map() };
    opts.error('agents.json unreadable; keeping the last good set', { err: String(err) });
    return fallback();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    opts.error('agents.json is not valid JSON; keeping the last good set', { err: String(err) });
    return fallback();
  }
  if (!Array.isArray(raw)) {
    opts.error('agents.json must be an array of agent entries; keeping the last good set');
    return fallback();
  }
  if (raw.length > MAX_AGENTS)
    opts.warn(`agents.json has ${raw.length} entries; only the first ${MAX_AGENTS} are read`);

  const defs: AgentDefinition[] = [];
  const briefs = new Map<string, AgentBriefSource>();
  const seen = new Set<string>();
  for (const [index, entry] of raw.slice(0, MAX_AGENTS).entries()) {
    const parsed = parseEntry(entry, opts.warn);
    if (!parsed.ok) {
      opts.warn(`agent entry ${index} dropped: ${parsed.reason}`);
      continue;
    }
    const { def } = parsed;
    if (seen.has(def.id)) {
      opts.warn('agent entry dropped: duplicate id, the first one wins', { id: def.id });
      continue;
    }
    seen.add(def.id);
    defs.push(def);
    const source = parseBriefField(parsed.brief, {
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
