import type { HostToWebview } from '../src/protocol';
import type { OpenMode } from './docs';
import type { CursorPos } from './editor-nav';

export type FileOpenRequest = Extract<HostToWebview, { type: 'openFileInEditor' }>;

export interface FileOpenPlan {
  activate: boolean;
  showEditor: boolean;
  mode: OpenMode;
  reveal?: CursorPos;
}

export function planFileOpen(r: FileOpenRequest): FileOpenPlan {
  // An OS "Open with" is a deliberate "work on this" act, so its tab is permanent. Keyed on 'mcp'
  // so a sender that predates `source` (IPC is untyped at runtime) keeps the OS behaviour.
  if (r.source !== 'mcp') return { activate: false, showEditor: true, mode: 'permanent' };
  const reveal = r.line === undefined ? undefined : { line: r.line, column: r.column ?? 1 };
  // A focused MCP open behaves like a clicked terminal path link; an unfocused one must not
  // pull the user away from what they are looking at (spec 2026-10-27-conduit-mcp-control-tools §3.1).
  const plan: FileOpenPlan = r.focus
    ? { activate: true, showEditor: true, mode: 'preview' }
    : { activate: false, showEditor: false, mode: 'background' };
  return reveal ? { ...plan, reveal } : plan;
}
