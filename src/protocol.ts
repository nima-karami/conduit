import type { ArchDoc } from './architecture';
import type { BoardData, Stage } from './board';
import type { SearchFileResult, SearchQuery } from './content-search';
import type { PipelineConfig } from './pipeline';
import type { QueueSummary } from './queue-summary';
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
  /**
   * True when this entry represents the STAGED (index) side of the change, false
   * for the unstaged worktree side (or an untracked file). A file modified in both
   * the index and the worktree (porcelain `MM`) produces two entries — one of each.
   */
  staged: boolean;
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

/** Static app metadata sent once on startup, populated from package.json + process.versions. */
export interface AboutInfo {
  /** App version from package.json (e.g. "0.1.0"). */
  version: string;
  /** Author field from package.json. */
  author: string;
  /** Electron runtime version string (e.g. "42.4.0"). */
  electronVersion: string;
  /** Node.js version string (e.g. "22.0.0"). */
  nodeVersion: string;
  /** Chromium version string. */
  chromeVersion: string;
}

export type HostToWebview =
  | {
      type: 'state';
      agents: AgentDefinition[];
      groups: ProjectGroupDTO[];
      sessions: Session[];
      repos: RepoDTO[];
      settings: AppSettings;
      about: AboutInfo;
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
  // Project-wide content (find-in-files) results (L5). `requestId` lets the renderer
  // drop a stale response when a newer query has superseded it (isStaleResponse).
  | {
      type: 'contentSearchResults';
      requestId: number;
      root: string;
      results: SearchFileResult[];
      truncated: boolean;
      error?: string;
    }
  | { type: 'board'; path: string; board: BoardData }
  // A card's spec markdown (G3). `exists` distinguishes a real saved spec from an absent
  // one (content empty), so the renderer can seed a heading + label it as new.
  | { type: 'spec'; path: string; cardId: string; content: string; exists: boolean }
  // The set of card ids that have a spec, sent alongside `board` so cards render the
  // has-spec indicator without one round-trip per card.
  | { type: 'specsList'; path: string; cardIds: string[] }
  | { type: 'architecture'; path: string; doc: ArchDoc | null }
  // An agent's pending proposal for a canonical artifact (N1), or `null` when none
  // (absent / just accepted / just rejected). The renderer diffs `proposed` against the
  // canonical doc it already holds and shows an accept/reject banner. `kind` selects the
  // surface (board vs. architecture canvas).
  | {
      type: 'proposal';
      path: string;
      kind: 'board';
      proposed: BoardData | null;
    }
  | {
      type: 'proposal';
      path: string;
      kind: 'architecture';
      proposed: ArchDoc | null;
    }
  // The per-project pipeline config (G4): which skill runs on each column transition.
  | { type: 'pipeline'; path: string; config: PipelineConfig }
  // The pipeline queue summary (N3): depth + recent entries so the board header shows a
  // queue-depth badge and a popover listing pending transitions without per-card IPC.
  | { type: 'pipelineQueue'; path: string; summary: QueueSummary }
  | {
      type: 'projectFiles';
      root: string;
      files: { path: string; content: string; language: string }[];
    }
  // Host requests the renderer to activate (focus) a specific session — sent when the
  // user clicks an OS notification for a backgrounded session (T1A).
  | { type: 'activateSession'; sessionId: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'log'; message: string }
  // Open a known folder in the chosen terminal. Optional `cardId` (N2) stamps the
  // created session with the feature-board card it was started for, linking the two.
  | { type: 'openRepo'; path: string; agentId: string; cardId?: string }
  | { type: 'browseRepo'; agentId: string } // host shows a folder dialog, then opens it in the chosen terminal
  | { type: 'requestProject'; path: string } // ask host for git changes + file tree
  | { type: 'readDir'; path: string }
  | { type: 'readFile'; path: string }
  | { type: 'readDiff'; path: string }
  | { type: 'rename'; id: string; name: string }
  // Set (or clear) a user-chosen Lucide icon override for a session (D3).
  // `icon` is a Lucide icon name in kebab-case (e.g. "rocket"); null clears the
  // override so the session falls back to its appIcon / agent-derived icon.
  | { type: 'setSessionIcon'; id: string; icon: string | null }
  // The terminal's window title changed (OSC 0/2, via xterm onTitleChange). The host
  // adopts it as the session name while the session is still auto-tracking — this is
  // how an app inside the terminal (e.g. Claude Code, incl. /rename) names the session.
  | { type: 'term:title'; sessionId: string; title: string }
  | { type: 'relaunch'; id: string }
  | { type: 'kill'; id: string }
  | { type: 'duplicate'; id: string } // clone a session (same agent + folder)
  | { type: 'reorderSessions'; order: string[] } // new global session id order
  | { type: 'focus'; id: string } // renderer's active session changed (clears needs-attention)
  | { type: 'updateSettings'; settings: AppSettings }
  | { type: 'searchFiles'; root: string; query: string } // recursive file search under root
  // Project-wide content search (find-in-files, L5). `requestId` monotonically increases
  // per renderer query so the host can echo it back and the renderer can drop stale replies.
  | { type: 'contentSearch'; requestId: number; root: string; query: SearchQuery }
  | { type: 'revealInExplorer'; path: string } // open the OS file manager at path
  | { type: 'requestBoard'; path: string } // load <path>/.conduit/board.json (per-project)
  | { type: 'updateBoard'; path: string; board: BoardData }
  | { type: 'requestSpec'; path: string; cardId: string } // load <path>/.conduit/specs/<id>.md
  | { type: 'saveSpec'; path: string; cardId: string; content: string } // persist a card's spec
  | { type: 'requestArchitecture'; path: string } // load <path>/architecture.json
  | { type: 'updateArchitecture'; path: string; doc: ArchDoc }
  // Ask the host whether a `<kind>.proposed.json` sibling exists (N1); the host replies
  // with a `proposal` message. Sent on board/canvas open alongside the canonical request.
  | { type: 'requestProposal'; path: string; kind: 'board' | 'architecture' }
  // Human accepts the proposal: apply the proposed whole document to the canonical file,
  // then delete the proposal. Rejects it: just delete the proposal (canonical untouched).
  | { type: 'acceptProposal'; path: string; kind: 'board' | 'architecture' }
  | { type: 'rejectProposal'; path: string; kind: 'board' | 'architecture' }
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
  // Drag-and-drop move/copy (D5). Both paths are validated by the host path-guard before
  // any disk mutation runs; the response is a typed ok/error (same shape as fsMutate).
  | { type: 'fsMove'; from: string; to: string }
  | { type: 'fsCopy'; from: string; to: string }
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
