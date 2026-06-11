import type { ArchDoc } from './architecture';
import type { BoardData, Stage } from './board';
import type { PipelineConfig } from './pipeline';
import type { AppSettings } from './settings';
import type { AgentDefinition, Session } from './types';

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

export interface CustomizationCount {
  id: string;
  count: number;
}

/** A previously-opened repository/folder, with the terminal last used in it. */
export interface RepoDTO {
  path: string;
  name: string;
  lastAgentId?: string;
  lastOpened: number;
}

export interface DirEntryDTO {
  name: string;
  kind: 'dir' | 'file';
}

export interface FileContentDTO {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  binary: boolean;
  error?: string;
}

export interface FileDiffDTO {
  path: string;
  head: string;
  work: string;
  binary: boolean;
}

export interface SearchHit {
  rel: string; // path relative to the searched root, forward slashes
  abs: string; // absolute path
}

export type HostToWebview =
  | {
      type: 'state';
      agents: AgentDefinition[];
      groups: ProjectGroupDTO[];
      sessions: Session[];
      repos: RepoDTO[];
      settings: AppSettings;
    }
  | {
      type: 'project';
      path: string;
      changes: ChangeDTO[];
      files: FileNodeDTO[];
      customizations: CustomizationCount[];
    }
  | { type: 'error'; message: string }
  // Terminal output streamed from the PTY in the extension host.
  | { type: 'term:data'; sessionId: string; data: string }
  | { type: 'term:exit'; sessionId: string; code: number }
  | { type: 'dirEntries'; path: string; entries: DirEntryDTO[] }
  | { type: 'fileContent'; doc: FileContentDTO }
  | { type: 'fileDiff'; doc: FileDiffDTO }
  | { type: 'searchResults'; root: string; results: SearchHit[] }
  | { type: 'board'; path: string; board: BoardData }
  // A card's spec markdown (G3). `exists` distinguishes a real saved spec from an absent
  // one (content empty), so the renderer can seed a heading + label it as new.
  | { type: 'spec'; path: string; cardId: string; content: string; exists: boolean }
  // The set of card ids that have a spec, sent alongside `board` so cards render the
  // has-spec indicator without one round-trip per card.
  | { type: 'specsList'; path: string; cardIds: string[] }
  | { type: 'architecture'; path: string; doc: ArchDoc | null }
  // The per-project pipeline config (G4): which skill runs on each column transition.
  | { type: 'pipeline'; path: string; config: PipelineConfig }
  | {
      type: 'projectFiles';
      root: string;
      files: { path: string; content: string; language: string }[];
    };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'log'; message: string }
  | { type: 'openRepo'; path: string; agentId: string } // open a known folder in the chosen terminal
  | { type: 'browseRepo'; agentId: string } // host shows a folder dialog, then opens it in the chosen terminal
  | { type: 'requestProject'; path: string } // ask host for git changes + file tree
  | { type: 'readDir'; path: string }
  | { type: 'readFile'; path: string }
  | { type: 'readDiff'; path: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'relaunch'; id: string }
  | { type: 'kill'; id: string }
  | { type: 'duplicate'; id: string } // clone a session (same agent + folder)
  | { type: 'reorderSessions'; order: string[] } // new global session id order
  | { type: 'focus'; id: string } // renderer's active session changed (clears needs-attention)
  | { type: 'updateSettings'; settings: AppSettings }
  | { type: 'searchFiles'; root: string; query: string } // recursive file search under root
  | { type: 'revealInExplorer'; path: string } // open the OS file manager at path
  | { type: 'requestBoard'; path: string } // load <path>/.conduit/board.json (per-project)
  | { type: 'updateBoard'; path: string; board: BoardData }
  | { type: 'requestSpec'; path: string; cardId: string } // load <path>/.conduit/specs/<id>.md
  | { type: 'saveSpec'; path: string; cardId: string; content: string } // persist a card's spec
  | { type: 'requestArchitecture'; path: string } // load <path>/architecture.json
  | { type: 'updateArchitecture'; path: string; doc: ArchDoc }
  | { type: 'requestPipeline'; path: string } // load <path>/.conduit/pipeline.json (G4)
  | { type: 'updatePipeline'; path: string; config: PipelineConfig } // persist the skill mapping
  // Record a surfaced transition to <path>/.conduit/pipeline-queue.json for an agent to
  // run. Conduit does NOT execute the skill — this is the consumable hook only (G4).
  | {
      type: 'queueTransition';
      path: string;
      cardId: string;
      cardTitle: string;
      from: Stage;
      to: Stage;
      skill: string;
    }
  | { type: 'indexProject'; root: string } // read project source files for cross-file go-to-def
  // Terminal lifecycle + input from the xterm.js instance in the webview.
  // agentId/cwd let the host launch the session's configured agent in its folder
  // (transitional: once sessions are host-owned, the host looks these up itself).
  | {
      type: 'term:start';
      sessionId: string;
      cols: number;
      rows: number;
      agentId?: string;
      cwd?: string;
    }
  | { type: 'term:input'; sessionId: string; data: string }
  | { type: 'term:resize'; sessionId: string; cols: number; rows: number }
  | { type: 'term:dispose'; sessionId: string };
