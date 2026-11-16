import { POST_TOOL_USE_MATCHER } from './claude-hook-settings';

export interface MatchedToolUses {
  ids: string[];
  lastUuid: string | null;
}

const MATCHER = new RegExp(POST_TOOL_USE_MATCHER);

interface ToolUse {
  name: string;
  id: string;
}

interface TranscriptEntry {
  uuid: string | null;
  toolUses: ToolUse[];
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
  const toolUses: ToolUse[] = [];
  if (isMainSessionCall) {
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === 'tool_use' &&
        typeof block.name === 'string' &&
        typeof block.id === 'string'
      ) {
        toolUses.push({ name: block.name, id: block.id });
      }
    }
  }
  return { uuid: typeof value.uuid === 'string' ? value.uuid : null, toolUses };
}

export function matchedToolUseIds(jsonl: string, sinceUuid: string | null): MatchedToolUses {
  const entries: TranscriptEntry[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    const entry = parseEntry(line);
    if (entry !== null) entries.push(entry);
  }
  const at = sinceUuid === null ? -1 : entries.findIndex((e) => e.uuid === sinceUuid);
  // An unknown sinceUuid yields no ids, so a caller that has lost its place starts over here.
  const ids: string[] = [];
  if (sinceUuid === null || at >= 0) {
    for (const entry of entries.slice(at + 1)) {
      for (const use of entry.toolUses) if (MATCHER.test(use.name)) ids.push(use.id);
    }
  }
  const lastUuid = [...entries].reverse().find((e) => e.uuid !== null)?.uuid ?? null;
  return { ids, lastUuid };
}
