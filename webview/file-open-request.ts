import type { HostToWebview } from '../src/protocol';
import type { OpenMode } from './docs';
import type { CursorPos } from './editor-nav';

export type FileOpenRequest = Extract<HostToWebview, { type: 'openFileInEditor' }>;

export interface FileOpenPlan {
  showEditor: boolean;
  mode: OpenMode;
  reveal?: CursorPos;
}

export function planFileOpen(r: FileOpenRequest): FileOpenPlan {
  // An OS "Open with" is a deliberate "work on this" act, so its tab is permanent. Keyed on 'mcp'
  // so a sender that predates `source` (IPC is untyped at runtime) keeps the OS behaviour.
  if (r.source !== 'mcp') return { showEditor: true, mode: 'permanent' };
  const reveal = r.line === undefined ? undefined : { line: r.line, column: r.column ?? 1 };
  // An MCP open lands in the caller's session and never switches the shown one (spec
  // 2026-10-30-conduit-mcp-app-control §2.1); unfocused, it also leaves the center view alone.
  const plan: FileOpenPlan = r.focus
    ? { showEditor: true, mode: 'preview' }
    : { showEditor: false, mode: 'background' };
  return reveal ? { ...plan, reveal } : plan;
}
