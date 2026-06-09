import { AgentDefinition, Session } from './types';

export interface ProjectGroupDTO {
  projectPath: string;
  sessions: Session[];
}

export type ChangeKind = 'M' | 'A' | 'D' | 'U';

export interface ChangeDTO {
  path: string;
  added: number;
  removed: number;
  kind: ChangeKind;
}

export interface FileNodeDTO {
  name: string;
  kind: 'dir' | 'file';
  status?: ChangeKind;
  depth: number;
}

export type HostToWebview =
  | { type: 'state'; agents: AgentDefinition[]; groups: ProjectGroupDTO[] }
  | { type: 'project'; path: string; changes: ChangeDTO[]; files: FileNodeDTO[] }
  | { type: 'error'; message: string }
  // Terminal output streamed from the PTY in the extension host.
  | { type: 'term:data'; sessionId: string; data: string }
  | { type: 'term:exit'; sessionId: string; code: number };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'log'; message: string }
  | { type: 'newSession' } // host runs an agent + folder picker
  | { type: 'requestProject'; path: string } // ask host for git changes + file tree
  | { type: 'rename'; id: string; name: string }
  | { type: 'relaunch'; id: string }
  | { type: 'kill'; id: string }
  // Terminal lifecycle + input from the xterm.js instance in the webview.
  // agentId/cwd let the host launch the session's configured agent in its folder
  // (transitional: once sessions are host-owned, the host looks these up itself).
  | { type: 'term:start'; sessionId: string; cols: number; rows: number; agentId?: string; cwd?: string }
  | { type: 'term:input'; sessionId: string; data: string }
  | { type: 'term:resize'; sessionId: string; cols: number; rows: number }
  | { type: 'term:dispose'; sessionId: string };
