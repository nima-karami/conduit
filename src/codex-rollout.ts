import type { LimitSignal } from './contracts/auto-resume';

// see spec 2026-11-13-scheduler-auto-resume §3 "Codex adapter" and docs/runs/2026-11-13-con-11/spike.md S3
const BIND_SLACK_MS = 5000;

export interface RolloutMeta {
  id: string;
  cwd: string;
  timestamp: number;
  isSubThread: boolean;
}

type Doc = Record<string, unknown>;

const asRecord = (v: unknown): Doc | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Doc) : null;

/** A torn or foreign line is data, not an error: it carries no signal. */
function parseLine(line: string): Doc | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

export function parseRolloutMeta(firstLine: string): RolloutMeta | null {
  const doc = parseLine(firstLine);
  if (doc?.type !== 'session_meta') return null;
  const payload = asRecord(doc.payload);
  if (!payload) return null;
  const { id, cwd, timestamp } = payload;
  if (typeof id !== 'string' || typeof cwd !== 'string' || typeof timestamp !== 'string')
    return null;
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return null;
  const source = asRecord(payload.source);
  const isSubThread = payload.parent_thread_id != null || (source !== null && 'subagent' in source);
  return { id, cwd, timestamp: at, isSubThread };
}

export function bindsTo(
  meta: RolloutMeta,
  s: { cwd: string; launchAt: number },
  samePath: (a: string, b: string) => boolean,
): boolean {
  return (
    !meta.isSubThread && samePath(meta.cwd, s.cwd) && meta.timestamp >= s.launchAt - BIND_SLACK_MS
  );
}

function tokenCountSignals(sessionId: string, payload: Doc, now: number): LimitSignal[] {
  const rates = asRecord(payload.rate_limits);
  if (!rates) return [];
  const windows: { name: string; usedPct?: number; resetAt: number }[] = [];
  for (const name of ['primary', 'secondary'] as const) {
    const window = asRecord(rates[name]);
    if (!window || typeof window.resets_at !== 'number') continue;
    windows.push({
      name,
      ...(typeof window.used_percent === 'number' ? { usedPct: window.used_percent } : {}),
      resetAt: window.resets_at * 1000,
    });
  }
  const signals: LimitSignal[] = [];
  if (windows.length > 0) {
    signals.push({ kind: 'reset-info', sessionId, at: now, windows, source: 'codex-rollout' });
  }
  if (rates.rate_limit_reached_type != null) {
    signals.push({ kind: 'limited', sessionId, at: now, source: 'codex-rollout' });
  }
  return signals;
}

export function rolloutSignals(
  sessionId: string,
  line: string,
  episodeOpen: boolean,
  now: number,
): LimitSignal[] {
  const doc = parseLine(line);
  if (doc?.type !== 'event_msg') return [];
  const payload = asRecord(doc.payload);
  if (!payload) return [];
  switch (payload.type) {
    case 'task_complete':
    case 'turn_complete': {
      const error = asRecord(payload.error);
      if (error?.codex_error_info !== 'usage_limit_exceeded') return [];
      const detail = typeof error.message === 'string' ? { detail: error.message } : {};
      return [{ kind: 'limited', sessionId, at: now, source: 'codex-rollout', ...detail }];
    }
    case 'token_count':
      return tokenCountSignals(sessionId, payload, now);
    case 'task_started':
    case 'turn_started':
      return episodeOpen
        ? [{ kind: 'resumed', sessionId, at: now, by: 'turn', source: 'codex-rollout' }]
        : [];
    default:
      return [];
  }
}

export class LineSplitter {
  private tail = '';

  push(chunk: string): string[] {
    const parts = (this.tail + chunk).split('\n');
    this.tail = parts.pop() ?? '';
    return parts
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .filter((line) => line !== '');
  }
}

export type CodexAction =
  | {
      kind: 'command';
      command: string;
      cwd: string;
      exitCode: number | null;
      durationMs: number | null;
    }
  | { kind: 'file-change'; paths: string[] }
  | { kind: 'mcp'; server: string; tool: string; durationMs: number | null };

const commandText = (argv: unknown): string | null => {
  if (typeof argv === 'string') return argv;
  if (!Array.isArray(argv) || !argv.every((part) => typeof part === 'string')) return null;
  const parts = argv as string[];
  if (parts.length === 3 && (parts[1] === '-c' || parts[1] === '-lc')) return parts[2] ?? null;
  return parts.join(' ');
};

const durationMs = (d: unknown): number | null => {
  const duration = asRecord(d);
  if (typeof duration?.secs !== 'number' || typeof duration.nanos !== 'number') return null;
  return Math.round(duration.secs * 1000 + duration.nanos / 1e6);
};

/** see spec 2026-11-14-policy-and-permissions §4.6 */
export function rolloutActions(line: unknown): CodexAction[] {
  const doc = typeof line === 'string' ? parseLine(line) : asRecord(line);
  if (doc?.type !== 'event_msg') return [];
  const payload = asRecord(doc.payload);
  if (payload?.type !== 'item_completed') return [];
  const item = asRecord(payload.item);
  if (!item) return [];
  switch (item.type) {
    case 'CommandExecution': {
      const command = commandText(item.command);
      if (command === null || typeof item.cwd !== 'string') return [];
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
      return [
        {
          kind: 'command',
          command,
          cwd: item.cwd,
          exitCode,
          durationMs: durationMs(item.duration),
        },
      ];
    }
    case 'FileChange': {
      const changes = asRecord(item.changes);
      if (!changes) return [];
      return [{ kind: 'file-change', paths: Object.keys(changes) }];
    }
    case 'McpToolCall': {
      if (typeof item.server !== 'string' || typeof item.tool !== 'string') return [];
      // Conduit's own calls already get an activity row (see claude-tool-actions.ts).
      if (item.server === 'conduit') return [];
      return [
        {
          kind: 'mcp',
          server: item.server,
          tool: item.tool,
          durationMs: durationMs(item.duration),
        },
      ];
    }
    default:
      return [];
  }
}
