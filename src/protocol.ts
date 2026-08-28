import type { ArchDoc } from './architecture';
import type { BoardData, Stage } from './board';
import type { SearchFileResult, SearchQuery } from './content-search';
import type { RefEndpoint } from './git-range';
import type { LogLevel } from './logging';
import type { TokenResolution } from './path-resolve';
import type { PipelineConfig } from './pipeline';
import type { QueueSummary } from './queue-summary';
import type { RangePreset } from './range-preset';
import type { ReviewMark, ReviewMarksRepo } from './review-marks';
import type { AppSettings } from './settings';
import type { TsconfigDTO } from './tsconfig-map';
import type { AgentDefinition, Session } from './types';

export type { RepoInfo } from './repo-scan';

export interface ProjectGroupDTO {
  projectPath: string;
  sessions: Session[];
}

/**
 * A persisted editor tab, round-tripped renderer → host → docs.json → renderer to restore the
 * open tabs across a restart (gated by the `restoreSessions` setting). Every deterministically-
 * reopenable kind restores: `file`/`diff` (by path), `commit-diff` (a real `<sha> <file>`; a
 * transient `@preview` slot with no pinned target is NOT persisted), `review`/`git-history`
 * (singletons, sentinel path), and `web` (by URL). Caveats: a restored `review` reopens in
 * working-tree mode (`reviewSource` is transient — refs may be gone next launch); a `commit-diff`
 * whose sha no longer exists degrades to the diff view's empty/notice state; a `web` tab reopens
 * its URL without prior page state; no scroll/cursor/view-state is restored (deferred — see
 * docs/plans/2026-06-30-tab-scroll-state-memory.plan.md). `active` marks the owning session's
 * remembered active doc; `preview` restores the VS Code-style preview tab as a preview.
 * See docs/specs/2026-06-27-editor-tab-behavior.md §3.2.
 */
export interface PersistedDoc {
  kind: 'file' | 'diff' | 'commit-diff' | 'review' | 'git-history' | 'web';
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

/** Which blob each side of a diff is read from. `base:'head'` + `side:'worktree'` (the
 *  defaults) is the whole-working-tree diff Review has always shown; the other two pairs are
 *  Review's Staged / Unstaged scopes. See spec 2026-08-27-review-supercharge §2 Lane D. */
export type DiffBase = 'head' | 'index';
export type DiffSide = 'index' | 'worktree';

export interface DiffScope {
  base?: DiffBase;
  side?: DiffSide;
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
  /** Present when a text side exceeds the 2 MB diff cap: the content is NOT read/shipped
   *  (`head`/`work` stay empty). The renderer shows a placeholder + "Open file", never a
   *  partial/misleading diff. See docs/specs/2026-07-07-git-host-robustness.md. */
  oversize?: { bytes: number };
  /** Host-computed per-file line counts (`diff-tree --numstat`); absent for binary/
   *  image records. Lets the renderer badge files without diffing them — see
   *  docs/specs/2026-08-20-commit-review-memory-bounds.md. */
  counts?: { added: number; removed: number };
  /** The path is UNMERGED (a conflict): it has no stage-0 index blob, so neither narrowed
   *  scope has a side to diff against. `head`/`work` stay empty and the renderer shows a
   *  notice — without this, "no index blob" is indistinguishable from an empty blob and the
   *  file renders as a whole-file deletion. Only ever set for a narrowed scope; All (HEAD→
   *  worktree) reads a conflicted file fine. */
  unmerged?: boolean;
}

/** A multi-file diff (commit/range) truncated to a file-count cap: `shown` of `total` files were
 *  produced. The renderer shows a "Showing N of M files" banner. */
export interface DiffTruncation {
  shown: number;
  total: number;
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

/**
 * One line's blame attribution, produced by `parseBlamePorcelain` (src/git-blame.ts) and
 * sent to the renderer via `git:blameResult`. `authorTime` is unix SECONDS (matching
 * `CommitNode.date`). `uncommitted` marks a line with no commit yet (the all-zero sha /
 * "Not Committed Yet" author) — never linkable to a Review. Lives here so the renderer
 * imports it type-only without pulling node.
 */
export interface BlameLine {
  /** 1-based final-file line number. */
  line: number;
  /** Full 40-char commit oid (all-zero for an uncommitted line). */
  sha: string;
  author: string;
  /** Author timestamp in unix SECONDS. */
  authorTime: number;
  summary: string;
  uncommitted?: boolean;
}

// The reviewed-mark and range-preset shapes live with their models because the disk shape and the
// wire shape are the same object; re-exported here so renderer code that only talks protocol
// doesn't have to reach past it. See spec 2026-08-27-review-supercharge §2 Lane B.
export type { RangePreset } from './range-preset';
export type { ReviewMark, ReviewMarksRepo } from './review-marks';

/**
 * Why `git:headBlobResult` carries no text. `untracked` (incl. an unborn HEAD) is the only
 * non-error one — the renderer renders the whole file as added for it. Every other value
 * means "no markers, no UI error, one host log line" (spec 2026-08-27-review-supercharge §2).
 */
export type HeadBlobReason = 'untracked' | 'binary' | 'oversize' | 'notRepo' | 'error';

/**
 * Outcome of a history read, carried on `git:historyResult`: `ok` (valid repo, ≥1 commit),
 * `empty` (valid repo, zero commits — a fresh `git init`), or `error` (git missing /
 * not-a-repo / timeout / non-zero exit). Lets the renderer show a retry on a transient
 * failure instead of a misleading empty state. Classified by `classifyHistory` (git-history.ts).
 */
export type HistoryState = 'ok' | 'empty' | 'error';

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
  /** Repository URL, derived from the same `build.publish` config electron-updater uses. */
  repoUrl: string;
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
  // `base`/`side` echo the request so the renderer can key its cache per scope — a Staged
  // read and the diff tab's HEAD→worktree read are two different diffs of one path.
  | ({ type: 'fileDiff'; doc: FileDiffDTO } & DiffScope)
  // A whole commit's per-file diffs in one reply (sha-tagged), so several open
  // commit/commit-diff tabs can't cross-attribute streamed files and no settle-timer
  // guess is needed. `files` is the complete set for `sha` (empty = no file changes).
  // `error` set ⇒ a read failure (missing session, git failure/timeout), distinct from a
  // legitimately empty commit; `requestId` echoes the request for latest-wins.
  | {
      type: 'git:commitDiffResult';
      sessionId: string;
      sha: string;
      files: FileDiffDTO[];
      truncated?: DiffTruncation;
      root?: string;
      error?: string;
      requestId: number;
    }
  // A comparison of two refs (commit/branch/working tree). `key` echoes the request's
  // `rangeKey(base,head)` so the loader matches the reply; `requestId` (required) drives
  // latest-wins. `error` set ⇒ a resolution failure (unknown ref); an empty `files` with no
  // `error` is the legitimate "no differences" state. See spec item 4.
  | {
      type: 'git:rangeDiffResult';
      sessionId: string;
      key: string;
      files: FileDiffDTO[];
      truncated?: DiffTruncation;
      error?: string;
      requestId: number;
    }
  // The active repo's commit history + computed lane layout (git-history Slice A).
  | {
      type: 'git:historyResult';
      sessionId: string;
      commits: CommitNode[];
      layout: GraphLayout;
      hasMore: boolean;
      // 3-state read outcome so the renderer can distinguish a valid-but-empty repo from a
      // transient failure (git missing / not-a-repo / timeout) and offer a retry on the latter.
      state: HistoryState;
      // Echoes the originating `git:history` requestId (when set) so the renderer can drop a
      // stale response — newest interrogation wins (Slice B concurrent-refresh guard).
      requestId?: number;
      // Echoes a non-empty search `query` so the renderer routes this as a full-history search
      // result (a separate slice, latest-wins) rather than the base paged read.
      query?: string;
    }
  // Per-line blame for one open file (git-blame). `path` echoes the request so the viewer
  // matches the reply to its doc; `error` set ⇒ a resolution failure (not a repo / read
  // failed) the viewer toasts; empty `lines` with no error = untracked/new/binary (no-op).
  // `root` is the file's OWN repo top-level (not the session's pinned repo) so a lens click
  // opens Review scoped to that repo in a split/multi-repo workspace.
  | {
      type: 'git:blameResult';
      sessionId: string;
      path: string;
      lines: BlameLine[];
      root?: string;
      error?: string;
    }
  // Reviewed marks from userData/review-marks.json. A LIST of per-repo slices: every repo on the
  // first push after load — including none at all, which is what opens the renderer's mark
  // controls — and just the changed repo on every push after that (§2 Lane B).
  | { type: 'review:marks'; repos: ReviewMarksRepo[] }
  // Endpoints for a Review source quick-pick, as shas. `error` set => the picker hides the row.
  | {
      type: 'git:resolveRangeResult';
      sessionId: string;
      preset: RangePreset;
      requestId: number;
      base?: RefEndpoint;
      head?: RefEndpoint;
      error?: string;
    }
  // A file's HEAD blob, for the editor's change decorations. `headSha` pins the cache key
  // (path + sha) so split panes and re-mounts don't refetch; `requestId` is latest-wins.
  | {
      type: 'git:headBlobResult';
      requestId: number;
      path: string;
      headSha: string | null;
      text: string | null;
      reason?: HeadBlobReason;
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
  // One chunk of the project's source index, streamed so the renderer never blocks a frame
  // building it (navigation-parity spec §3b). Chunk 0 carries the project's compilerOptions
  // and leads with the import closure of the file being opened, so the first go-to-definition
  // of a session doesn't wait for the whole tree.
  | {
      type: 'projectFiles';
      root: string;
      files: { path: string; content: string; language: string }[];
      /** 0-based chunk ordinal. */
      seq: number;
      /** Total source files selected for this root (across all chunks). On a `supplemental`
       *  chunk this is the size of THAT batch, which the renderer adds to the root's running
       *  total rather than replacing it. */
      total: number;
      /** True on the final chunk — the index is complete for this root. */
      done: boolean;
      /** Source files the index refused to read because they exceed
       *  `INDEX_MAX_FILE_BYTES` — counted, not truncated (contract 5, row 17). */
      skipped: number;
      /** Source files the `INDEX_FILE_CAP` left out of this root's selection (row 34). */
      capped: number;
      /** A follow-up batch of files that appeared after the root's full index finished
       *  (the `fsChanged` path). Never `seq === 0`: chunk 0 owns the compiler options, and
       *  re-applying them restarts the worker and drops everything already pushed. */
      supplemental?: true;
      /** Present on `seq === 0` only; absent when the project has no readable tsconfig. */
      tsconfig?: TsconfigDTO;
    }
  // Reply to `resolveModule`: the module's entry file plus its bounded relative closure, in
  // the same `{ path, content, language }` shape `projectFiles` uses so the renderer feeds it
  // through one extraLib path. See docs/specs/2026-08-21-goto-definition-flows.md §1.
  | {
      type: 'resolveModuleResult';
      requestId: number;
      ok: boolean;
      /** The resolved entry file, when ok. */
      entry?: string;
      files?: { path: string; content: string; language: string }[];
      /** Why it failed — surfaced in the log, never as the user-facing copy. */
      reason?: string;
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
  // 40-char sha when it names a real commit in the repo the terminal's cwd sits in, else null.
  // Renderer links only the resolved ones. `root` is that cwd repo (absent on an unknown/failed
  // session), so a click can scope the opened Review to it. Unknown session → empty `results`.
  // See spec §3.2.
  | {
      type: 'validateCommitsResult';
      sessionId: string;
      results: { token: string; commit: string | null }[];
      root?: string;
    }
  // Multi-window (Slice B): the set of open windows for the "Move to window…" picker.
  // Broadcast on window open/close/focus change and after a session move. Each window
  // excludes its own id (from `state.windowId`) when listing move targets.
  | { type: 'win:list'; windows: { id: number; title: string; sessionCount: number }[] }
  // The branch switcher's dropdown source (git-indicator Slice B): local branches for the
  // session's activeCwd, with the checked-out branch marked. Replied to the requesting
  // window only (request/response), not broadcast. `remotes`/`tags` are ADDITIVE for the
  // Compare dialog (spec 2026-06-30-review-compare-dialog §3) — existing consumers read only
  // branches/current. These lists are display-capped; the host validates picked refs exactly.
  | {
      type: 'git:refsResult';
      sessionId: string;
      branches: string[];
      current: string | null;
      remotes: string[];
      tags: string[];
    }
  // Outcome of a `git:switch`. `ok:true` → the host scheduled a git refresh; the new branch
  // arrives on the next `state`. A refusal/failure carries a reason + pre-localized message
  // (the `failed` path is the one case where `message` is git's raw stderr summary).
  | {
      type: 'git:switchResult';
      sessionId: string;
      ok: boolean;
      reason?: 'busy' | 'dirty' | 'failed';
      message?: string;
    }
  // Windows delivers the mouse thumb buttons as the per-window `app-command` OS event
  // (browser-backward/forward), not as DOM button 3/4. The host forwards them here so the
  // renderer drives the existing goBack/goForward. On Windows this is the authoritative
  // source (the DOM thumb-button path is gated off) → one press, one navigation. See
  // docs/specs/2026-06-30-mouse-nav-buttons.md §3.2-3.3.
  | { type: 'appCommand'; command: 'back' | 'forward' }
  // Reply to `md:image` — the local image's bytes as a ready-to-use `<img src>` data URL,
  // or `error` (missing / not an image / over the size cap). `requestId` lets the requesting
  // MarkdownImage drop a stale reply (doc switch / re-src). Runs host-side `readFile`, so it
  // rides the same size caps + read boundary as any other served file.
  | {
      type: 'md:imageResult';
      requestId: number;
      dataUrl?: string;
      error?: string;
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
  // `base`/`side` scope the diff (Review's Staged / Unstaged); omitted ⇒ HEAD→worktree.
  | ({ type: 'readDiff'; path: string } & DiffScope)
  // Load the active session's repo commit history (all refs), paged. `before` is a sha
  // to page from (older than it); host replies with `git:historyResult`. `requestId`
  // monotonically increases per interrogation so the renderer can drop a stale response
  // when a newer refresh has superseded it (Slice B concurrent-refresh guard).
  // A non-empty `query` switches the host from the paged tip read to a FULL-history search
  // (message/author/diff-content, `searchHistory`), so a match from beyond the loaded window
  // surfaces directly. `before` is ignored when searching. The reply echoes the query.
  | {
      type: 'git:history';
      sessionId: string;
      limit?: number;
      before?: string;
      requestId?: number;
      query?: string;
    }
  // Inspect one commit's diff; host replies with a single sha-tagged `git:commitDiffResult`
  // carrying every changed file. `path` is reserved for a future single-file request. `root`
  // scopes the diff to a specific repo (a terminal-originated review passes its cwd repo); when
  // omitted the host uses the session's pinned repo.
  // `requestId` (monotonic, latest-wins) lets a Retry re-issue without a stale earlier reply
  // clobbering it — see docs/specs/2026-08-20-commit-review-memory-bounds.md §4.
  | {
      type: 'git:commitDiff';
      sessionId: string;
      sha: string;
      path?: string;
      root?: string;
      requestId: number;
    }
  // Blame one open file (absolute `path`). The host resolves the session's git root, asserts
  // the path is inside it + tracked, then replies with a single `git:blameResult`.
  | { type: 'git:blame'; sessionId: string; path: string }
  // The HEAD version of one open file (absolute `path`). The host resolves the repo from the
  // FILE's own directory (like git:blame), asserts containment, caps at 2 MB and LF-normalises.
  | { type: 'git:headBlob'; path: string; requestId: number }
  // Compare two refs (commit/branch/working tree); host replies with a single key-tagged
  // `git:rangeDiffResult`. The host validates both endpoints against its own ref set. See spec item 4.
  | {
      type: 'git:rangeDiff';
      sessionId: string;
      base: RefEndpoint;
      head: RefEndpoint;
      requestId: number;
    }
  // Set or clear ONE reviewed mark. The host owns the file and echoes the repo's new list to
  // every window, so two windows on one repo converge on the last writer (§4).
  | { type: 'review:setMark'; root: string; mark: ReviewMark; on: boolean }
  // Resolve `unpushed` / `branchPoint` to sha endpoints for the picker's pinned rows.
  // `requestId` is latest-wins: the picker fires both presets when it opens.
  | { type: 'git:resolveRange'; sessionId: string; preset: RangePreset; requestId: number }
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
  // Sessions this window currently has on screen (active + split). The host exempts them
  // from "needs you" and treats seeing one as acknowledgment; the sets are per sender
  // window. See docs/specs/2026-08-21-attention-signal-quality.md §4.
  | { type: 'visible'; ids: string[] }
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
  // Read the project's source files for cross-file navigation. `seeds` (typically the file
  // being opened) orders the reply so their import closure streams first.
  | {
      type: 'indexProject';
      root: string;
      seeds?: string[];
      /** Index only the files the host has not already sent for this root — the `fsChanged`
       *  path. Falls back to a full index when the host holds no record of the root. */
      incremental?: boolean;
    }
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
  | { type: 'repo:context'; sessionId: string; path: string }
  // Fetch a local image referenced by an open markdown doc, resolved renderer-side to an
  // absolute `path` (see webview/md-links.ts resolveMdImage). The host reads it via the same
  // `readFile` path as any served file (image branch → data URL, size-capped) and replies with
  // a `md:imageResult` tagged by `requestId`. Read-only, like `pathExists`/`resolvePathToken`.
  | { type: 'md:image'; requestId: number; path: string }
  // Resolve one module specifier the way Node/TS would, from the file that imports it, and
  // index what it finds on demand. Sent only when a navigation MISSED — see
  // docs/specs/2026-08-21-goto-definition-flows.md §1-2.
  | {
      type: 'resolveModule';
      requestId: number;
      sessionId: string;
      /** Absolute path of the importing file (forward slashes). */
      fromFile: string;
      specifier: string;
    };
