import { POST_TOOL_USE_MATCHER } from './claude-hook-settings';

export interface MatchedToolUseCount {
  count: number;
  lastUuid: string | null;
}

const MATCHER = new RegExp(POST_TOOL_USE_MATCHER);

interface TranscriptEntry {
  uuid: string | null;
  toolNames: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseEntry(line: string): TranscriptEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const isMainSessionCall = value.type === 'assistant' && value.isSidechain !== true;
  const message = isRecord(value.message) ? value.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolNames: string[] = [];
  if (isMainSessionCall) {
    for (const block of content) {
      if (isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string') {
        toolNames.push(block.name);
      }
    }
  }
  return { uuid: typeof value.uuid === 'string' ? value.uuid : null, toolNames };
}

export function countMatchedToolUses(jsonl: string, sinceUuid: string | null): MatchedToolUseCount {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    const entry = parseEntry(line);
    if (entry !== null) entries.push(entry);
  }
  const at = sinceUuid === null ? -1 : entries.findIndex((e) => e.uuid === sinceUuid);
  let count = 0;
  for (const entry of entries.slice(at + 1)) {
    for (const name of entry.toolNames) if (MATCHER.test(name)) count += 1;
  }
  const lastUuid = [...entries].reverse().find((e) => e.uuid !== null)?.uuid ?? null;
  return { count, lastUuid };
}
