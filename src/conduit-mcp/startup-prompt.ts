import type { McpAdapter } from './adapters';
import { type ScreenSnapshot, screenVerdict } from './screen-verdict';

export function isStartupPrompt(
  adapter: McpAdapter | null,
  snap: ScreenSnapshot,
  stuck: boolean,
  busy = false,
): boolean {
  if (busy) return false;
  if (adapter?.screen && screenVerdict({ ...adapter.screen, blocking: [] }, snap) === 'empty-input')
    return false;
  return (
    stuck ||
    (adapter?.startupPrompts?.some((pattern) => snap.lines.some((line) => pattern.test(line))) ??
      false)
  );
}
