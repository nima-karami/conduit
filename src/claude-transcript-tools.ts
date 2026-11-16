import { POST_TOOL_USE_MATCHER } from './claude-hook-settings';

const MATCHER = new RegExp(POST_TOOL_USE_MATCHER);

interface ToolUse {
  name: string;
  id: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseToolUses(line: string): ToolUse[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(value) || value.type !== 'assistant' || value.isSidechain === true) return [];
  const message = isRecord(value.message) ? value.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolUses: ToolUse[] = [];
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
  return toolUses;
}

export function matchedToolUseIds(jsonl: string): string[] {
  const ids: string[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    for (const use of parseToolUses(line)) if (MATCHER.test(use.name)) ids.push(use.id);
  }
  return ids;
}
