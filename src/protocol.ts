import type { ArchDoc } from './architecture';
import type { BoardData, Stage } from './board';
import type { SearchFileResult, SearchQuery } from './content-search';
import type { LogLevel } from './logging';
import type { TokenResolution } from './path-resolve';
import type { PipelineConfig } from './pipeline';
import type { QueueSummary } from './queue-summary';
import type { AppSettings } from './settings';
import type { AgentDefinition, Session } from './types';

export type { RepoInfo } from './repo-scan';

export interface ProjectGroupDTO {
  projectPath: string;
  sessions: Session[];
}

/**
 * A persisted editor tab, round-tripped renderer → host → docs.json → renderer to restore the
 * open tabs across a restart (gated by the `restoreSessions` setting). File-only for MVP
 * (diff/commit-diff/web/review/git-history are NOT restored — they depend on transient git/page
 * state). `active` marks the owning session's remembered active doc; `preview` restores the VS
 * Code-style preview tab as a preview. See docs/specs/2026-06-27-editor-tab-behavior.md §3.2.
 */
export interface PersistedDoc {
  kind: 'file';
  path: string;
  sessionId: string;
  preview?: boolean;
  active?: boolean;
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
  /** True when git ignores this entry (.gitignore / excludes). The Explorer dims it. */
  ignored?: boolean;
}

export interface FileContentDTO {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  binary: boolean;
  error?: string;
  /** Present when the file is an image within the size cap. The data URL is
   *  ready to use as an `<img src>` without any further processing. */
  image?: { mime: string; dataUrl: string; bytes: number };
  /** Present when the file is a PDF within the size cap. The renderer decodes the
   *  base64 data URL to a `Uint8Array` for pdf.js (`getDocument({ data })`). Over-cap
   *  returns the `error` notice instead, mirroring the image branch. */
  pdf?: { dataUrl: string; bytes: number };
}

export interface FileDiffDTO {
  path: string;
  head: string;
  work: string;
  binary: boolean;
  /** Present when the changed file is an image (per `mediaKindForPath`) and at least
   *  one side fits the cap. `head`/`work` stay empty here (they carry utf8 text); image
   *  bytes ride in this branch as base64 data URLs. `status` is derived HOST-side from
   *  which sides exist — the renderer never re-derives it. */
  image?: {
    head?: { dataUrl: string; bytes: number }; // absent ⇒ added
    work?: { dataUrl: string; bytes: number }; // absent ⇒ deleted
    status: 'modified' | 'added' | 'deleted';
    overCap?: boolean; // either side > cap ⇒ fall back to the no-preview notice
  };
}

/**
 * A single commit in the history graph. Produced by `parseCommits` (src/git-history.ts)
 * and serialized to the renderer via `git:historyResult`. Lives here (not in
 * git-history.ts) so the renderer can import it as a TYPE without pulling
 * node:child_process. `date` is unix seconds (NOT ms) — the `%at` author timestamp.
 */
export interface CommitNode {
  sha: string;
  parents: string[];
  /**
   * Human ref labels for this commit's tips, parsed from `%D` (`--decorate=full`).
   * Branch/remote/tag prefixes are stripped (`refs/heads/`, `refs/remotes/`,
   * `refs/tags/`); each label keeps a `kind` so the renderer can badge it. `HEAD` is
   * the symbolic HEAD pointer (kind `head`); the branch HEAD points at is a separate
   * `branch` label. A detached HEAD yields a lone `head` label with name `HEAD`.
   */
  refs: GitRef[];
  author: string;
  email?: string;
  /** Author timestamp in unix SECONDS (`%at`). */
  date: number;
  subject: string;
  body?: string;
}

export type GitRefKind = 'head' | 'branch' | 'remote' | 'tag';

export interface GitRef {
  kind: GitRefKind;
  /** The stripped, human-readable label (e.g. `main`, `origin/main`, `v1.0`, `HEAD`). */
  name: string;
}

/** A commit's position in the rendered graph: which lane its node sits in. */
export interface GraphRow {
  sha: string;
  lane: number;
}

/**
 * An edge from a commit to one of its parents, carrying both lane indices so the
 * renderer can draw straight/diagonal links and merges (a merge commit emits ≥2 edges
 * with distinct `toLane`s).
 */
export interface GraphEdge {
  fromSha: string;
  toSha: string;
  fromLane: number;
  toLane: number;
}

/** The pure lane-layout for a commit list, produced by `assignLanes`. Serializable. */
export interface GraphLayout {
  rows: GraphRow[];
  edges: GraphEdge[];
  /** Total number of lanes used (max lane index + 1); the renderer sizes the gutter. */
  laneCount: number;
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
  /** True for an unpacked dev build (!app.isPackaged) — drives the visible DEV badge. */
  isDev: boolean;
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
      // The id of the window receiving this state (multi-window Slice B). The renderer
      // uses it to exclude itself from the "Move to window…" picker (win:list).
      windowId: number;
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
  // A whole commit's per-file diffs in one reply (sha-tagged), so several open
  // commit/commit-diff tabs can't cross-attribute streamed files and no settle-timer
  // guess is needed. `files` is the complete set for `sha` (empty = no file changes).
  | { type: 'git:commitDiffResult'; sessionId: string; sha: string; files: FileDiffDTO[] }
  // The active repo's commit history + computed lane layout (git-history Slice A).
  | {
      type: 'git:historyResult';
      sessionId: string;
      commits: CommitNode[];
      layout: GraphLayout;
      hasMore: boolean;
      // Echoes the originating `git:history` requestId (when set) so the renderer can drop a
      // stale response — newest interrogation wins (Slice B concurrent-refresh guard).
      requestId?: number;
    }
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
  | { type: 'activateSession'; sessionId: string }
  // One-shot tab restore (editor-tabs-persist): the persisted open file docs, sent once after
  // sessions are restored so the renderer can re-seed `docState` attached to its (stale)
  // sessions. Only sent when `restoreSessions` is on; absent/older docs.json ⇒ no message ⇒ no
  // tabs. The renderer consumes it once (orphan docs whose session is unknown are dropped). See
  // docs/specs/2026-06-27-editor-tab-behavior.md §3.3 (D5).
  | { type: 'restoreDocs'; docs: PersistedDoc[] }
  // Host routes an OS "Open with Conduit" file launch: open `path` as a doc in `sessionId`
  // (the host already created/reused the owning session). The renderer opens it via the
  // existing open-file flow; if the session isn't in state yet (just created), it defers
  // until that session's `state` arrives. See electron/main.ts openFileFromOS.
  | { type: 'openFileInEditor'; path: string; sessionId: string }
  // A file currently open in an editor/markdown tab changed on disk (external editor,
  // agent, or terminal command). The renderer re-reads it (dirty-buffer protection in
  // app.tsx still withholds clobbering an unsaved buffer). See electron/open-file-watcher.ts.
  | { type: 'fileChanged'; path: string }
  // Live working-tree change for an open project root (debounced, noise-filtered). The
  // renderer re-reads git changes + the file tree without waiting for a window focus.
  // See electron/project-watcher.ts.
  | { type: 'fsChanged'; root: string }
  | {
      type: 'updateStatus';
      status: 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
      version?: string;
      releaseNotes?: string;
      percent?: number;
      message?: string;
    }
  // Main asks the renderer to confirm a quit/close/update-relaunch when running
  // sessions are active (W2). `running` / `busy` are counts for display copy.
  | { type: 'confirmQuit'; reason: 'quit' | 'update'; running: number; busy: number }
  // D11: reply to `pathExists` — tells the renderer whether a terminal-printed path token
  // points at a real entry, and whether it is a directory (affects the click action).
  | { type: 'pathExistsResult'; path: string; exists: boolean; isDir: boolean }
  // path-links v1: reply to `resolvePathToken` — per-token candidate files (0 = plain text,
  // 1 = open directly, >1 = disambiguation dropdown). `sessionId` lets a pane ignore replies
  // for other sessions. An unknown session / failure replies with empty `results`.
  | { type: 'resolvePathTokenResult'; sessionId: string; results: TokenResolution[] }
  // terminal-commit-link: reply to `validateCommits` — per candidate token its resolved full
  // 40-char sha when it names a real commit in the session's active repo, else null. Renderer
  // links only the resolved ones. Unknown session → empty `results`. See spec §3.2.
  | {
      type: 'validateCommitsResult';
      sessionId: string;
      results: { token: string; commit: string | null }[];
    }
  // Multi-window (Slice B): the set of open windows for the "Move to window…" picker.
  // Broadcast on window open/close/focus change and after a session move. Each window
  // excludes its own id (from `state.windowId`) when listing move targets.
  | { type: 'win:list'; windows: { id: number; title: string; sessionCount: number }[] }
  // The branch switcher's dropdown source (git-indicator Slice B): local branches for the
  // session's activeCwd, with the checked-out branch marked. Replied to the requesting
  // window only (request/response), not broadcast.
  | { type: 'git:refsResult'; sessionId: string; branches: string[]; current: string | null }
  // Outcome of a `git:switch`. `ok:true` → the host scheduled a git refresh; the new branch
  // arrives on the next `state`. A refusal/failure carries a reason + pre-localized message
  // (the `failed` path is the one case where `message` is git's raw stderr summary).
  | {
      type: 'git:switchResult';
      sessionId: string;
      ok: boolean;
      reason?: 'busy' | 'dirty' | 'failed';
      message?: string;
    };

export type WebviewToHost =
  | { type: 'ready' }
  // Renderer→host log line, routed through the host's leveled file logger. Back-compatible:
  // a bare `{ type: 'log', message }` defaults to level `info`, scope `'renderer'`.
  | {
      type: 'log';
      message: string;
      level?: LogLevel;
      scope?: string;
      data?: Record<string, unknown>;
    }
  // Open the host logs folder in the OS file manager (shell.openPath).
  | { type: 'revealLogs' }
  // Open a known folder in the chosen terminal. Optional `cardId` (N2) stamps the
  // created session with the feature-board card it was started for, linking the two.
  | { type: 'openRepo'; path: string; agentId: string; cardId?: string }
  | { type: 'browseRepo'; agentId: string } // host shows a folder dialog, then opens it in the chosen terminal
  // Ask host for git changes (scoped to `changesRoot`, the active repo) + file tree (from `path`).
  | { type: 'requestProject'; path: string; changesRoot?: string }
  | { type: 'readDir'; path: string }
  | { type: 'readFile'; path: string }
  // The full set of files currently open in editor/markdown tabs. The host watches them
  // and emits `fileChanged` when one changes on disk. Sent (and re-sent) whenever the set
  // changes; an empty array clears all watches. See electron/open-file-watcher.ts.
  | { type: 'watchFiles'; paths: string[] }
  // The current set of persisted-relevant editor tabs (editor-tabs-persist). Sent DEBOUNCED
  // whenever the persisted slice of docState changes; the host stores the payload and atomic-
  // writes docs.json (and re-writes it in the before-quit sync flush). See spec §3.3.
  | { type: 'persistDocs'; docs: PersistedDoc[] }
  | { type: 'readDiff'; path: string }
  // Load the active session's repo commit history (all refs), paged. `before` is a sha
  // to page from (older than it); host replies with `git:historyResult`. `requestId`
  // monotonically increases per interrogation so the renderer can drop a stale response
  // when a newer refresh has superseded it (Slice B concurrent-refresh guard).
  | { type: 'git:history'; sessionId: string; limit?: number; before?: string; requestId?: number }
  // Inspect one commit's diff; host replies with a single sha-tagged `git:commitDiffResult`
  // carrying every changed file. `path` is reserved for a future single-file request.
  | { type: 'git:commitDiff'; sessionId: string; sha: string; path?: string }
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
  | { type: 'openExternalPath'; path: string } // open a file with its OS-default app (shell.openPath)
  | { type: 'openWith'; path: string } // open the OS "Open with…" application chooser for a file
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
  | { type: 'term:dispose'; sessionId: string }
  | { type: 'updateCheck' }
  | { type: 'updateRelaunch' }
  // Renderer's reply to `confirmQuit` (W2): proceed = user confirmed the destructive action.
  | { type: 'quitDecision'; proceed: boolean }
  // Renderer ACK that the quit confirm dialog is now on screen (W2). Disarms the host's
  // wedged-renderer timeout so a dialog the user is reading never auto-dismisses.
  | { type: 'quitDialogShown' }
  // D11: cheap existence check for terminal path-link validation. The host replies with
  // `pathExistsResult`. This is a read-only check (no write surface); the host uses
  // fs.existsSync without workspace-containment validation because the renderer can
  // already open any path via readFile (which is unguarded by workspace roots).
  | { type: 'pathExists'; path: string }
  // path-links v1: resolve terminal path tokens (batched per rendered line) to candidate
  // files against the session's cwd/project-root + file index. Host replies with
  // `resolvePathTokenResult`. Read-only, like `pathExists`.
  | { type: 'resolvePathToken'; sessionId: string; tokens: string[] }
  // terminal-commit-link: validate terminal commit-hash candidates (batched per rendered line)
  // as real commit objects in the session's active repo. Host replies with
  // `validateCommitsResult`. Read-only (cat-file/rev-parse), like `resolvePathToken`. Spec §3.2.
  | { type: 'validateCommits'; sessionId: string; tokens: string[] }
  // Multi-window (Slice A): open a new, empty Conduit window. The host owns the window
  // registry; the new window owns no sessions until the user starts one in it.
  | { type: 'win:new' }
  // Multi-window (Slice B): move a live session to another window WITHOUT restarting its
  // PTY. The host reassigns ownership (the sessionId/React key never changes, so no remount
  // kills the ConPTY child); `kind:'new'` spawns a fresh window as the target.
  | {
      type: 'session:move';
      sessionId: string;
      target: { kind: 'new' } | { kind: 'window'; windowId: number };
    }
  // Multi-window (Slice C): a session tab's drag ended at global SCREEN coords. HTML5 DnD
  // doesn't cross BrowserWindow bounds, so the renderer reports the drop point and the host
  // hit-tests it: over another window → move there (reuses session:move's effects); over no
  // window (empty desktop) → tear out a new window at the point; over the SOURCE window →
  // no-op (an in-strip reorder already handled it). The host resolves the source window from
  // e.sender — no windowId in the payload.
  | { type: 'session:dragEnd'; sessionId: string; screenX: number; screenY: number }
  // Branch switcher (git-indicator Slice B). Fetch the dropdown's branch list for a
  // session's activeCwd; the host replies with `git:refsResult` to the requesting window.
  | { type: 'git:refs'; sessionId: string }
  // Request an in-place branch switch. `target` is a discriminated union so a future
  // `worktree` kind slots in without a breaking change (only `branch` is implemented). The
  // host validates `ref` against its own enumerated branch set, refuses if the session is
  // busy or the tree is dirty, else runs `git checkout` out-of-band. Replies `git:switchResult`.
  | {
      type: 'git:switch';
      sessionId: string;
      target: { kind: 'branch'; ref: string };
    }
  // Multi-repo picker: pin the active repo to `repoRoot` (host validates against the detected
  // set), clear the pin, or report a context path so the host auto-follows the containing repo.
  | { type: 'repo:pin'; sessionId: string; repoRoot: string }
  | { type: 'repo:unpin'; sessionId: string }
  | { type: 'repo:context'; sessionId: string; path: string };
