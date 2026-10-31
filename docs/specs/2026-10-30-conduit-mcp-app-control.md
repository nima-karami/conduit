---
status: draft
date: 2026-10-30
---

# Feature Spec: Conduit MCP app-control tools

Depends on [conduit-mcp-tool-policy](2026-10-30-conduit-mcp-tool-policy.md): every tool here is gated by its resolved policy (access/when/reach/move) and refusal codes there.

**Tier:** FULL   **Feature type:** non-UI (MCP tools, host↔renderer protocol). Its only UI is
what the tools open; the Settings rows live in the policy spec.
**Request:**
- "Add more tools to the MCP so the agent can control the app: open/close a session, open/close
  files, go to review mode, attach a folder, open a website, open a commit or branch."

Builds on [conduit-mcp-control-tools](2026-10-27-conduit-mcp-control-tools.md). This spec reuses
from it: the gate, the rate limiter, placement and `list_changed`. It **replaces** that spec's
boolean switches (`mcpTools`, `mcpToolOverrides`) with policies.

**Two parts, built in order.** Part A, the policy system, comes first, and the three existing
control tools move onto it. Part B, the seven new tools, is built on Part A.

## 1. Problem frame

- **Job:**
  - Then give agents enough tools to show and arrange things in the app when the human asks.
- **Actors:**
  - the human (sets policies, approves "ask" calls, views the result);
  - the caller (an agent CLI in a session, resolved from its token as today);
  - the MCP host (resolves the policy, gates, asks, executes);
  - the renderer of the caller's window (approval card, UI actions, outcome reports).
- **Success outcomes:**
  - the new tools do what the equivalent UI action does and return what actually happened.
- **Non-goals:**
  - agent communication surfaces: plan/architecture "show" tools, change map, guided walkthroughs
    (human: "skip for now");
  - GitHub PR review (human: it was only an example);
  - policies keyed on time of day, project, or argument patterns (e.g. URL allowlists);
  - per-project policy layers;
  - reading terminal output, renaming, settings changes over MCP.

## 2. Data / interface contract

### 2.1 New and changed tools

Paths are absolute or relative to the caller's persisted home. `session` takes a handle or id from
`list_sessions`.

| Tool | Input | Result |
|---|---|---|
| `close_session` | `session` (may be the caller) | `{closed: session_id}` |
| `focus_session` | `session` | `{focused: session_id}` |
| `attach_folder` | `path` (dir), `session?` (default caller) | `{attached, session_id, roots}` |
| `close_files` | `paths?: string[]` (≤ 50) **or** `all: true` | `{closed: string[], skipped: [{path, reason:'unsaved'\|'not_open'}]}` |
| `open_review` | `source`: `{kind:'working', scope?}` \| `{kind:'commit', ref}` \| `{kind:'range', base, head}` (`head` may be `"working"`); `repo?` | `{opened:'review', source}` (classified endpoints) |
| `open_git_history` | `repo?`, `ref?` | `{opened:'git-history', selected: sha \| null}` |
| `open_url` | `url` (≤ 2 KB), `focus?` (default true) | `{opened: normalisedUrl}` |

**Semantics**

- **Session/split rule.** Tools never change which sessions are active or split, except
  `focus_session` and a `focus:true` session open (both governed by `move`). Show tools act on
  the caller's own session through **session-explicit** renderer entry points, never `activeIdRef`.
  A split partner has no editor pane of its own (only its terminal), so for a split-partner caller
  the tab opens active in that session's own layout and shows when the human activates it. Review
  and History are singletons, so opening one there takes it off the human's screen. A file or URL
  open into a non-shown session never takes a tab off the shown session's screen: a tab the shown
  session already holds stays with its owner (only un-previewed), and the caller's layout gets nothing.
- **Focus.** A tool-driven open never moves DOM focus off an element it leaves visible: a split
  partner's open, a `focus:false` open, or an open while focus sits outside the caller's panes.
  When the caller is the shown session, the focused element was inside its center pane, and the
  open hides or removes it (the terminal's or the editor's caret, any focused pane), focus moves
  to the opened view's own focus target: the Review scroller, the History list, the editor, or a
  web tab's host (never into the guest page). The open is announced politely in the navigation
  live region: "<handle> opened <Review | History | web page | file>". Without this the keyboard
  is left on `body` and typed keys are lost (runtime QA, part B).
- **`close_session`.**
  - It runs as the renderer action `closeSession`: the renderer checks the target's dirty tabs and
    posts `kill` in the same synchronous turn, which is the UI's teardown minus the confirm.
  - Dirty tabs → `unsaved_changes` (up to 20 paths); nothing is closed. Dirty state is keyed by
    path (app.tsx:2205), so a buffer dirty in another session also blocks.
  - When the caller closes itself, the result is written before `kill`.
- **`focus_session`.** Sends `activateSession` to the target's window. When that isn't the caller's
  window, it also raises and focuses that window, as moving a session does. `{focused}` is returned
  once it is sent. A no-op if the session is already active.
- **`attach_folder`.**
  - It is `sessionOps.addRoot`, unchanged: checks, dedupe, persistence.
  - The home or an existing root gives success with `roots` unchanged.
  - It doesn't type `/add-dir` into the CLI.
- **`close_files`.**
  - It closes the caller's session's tabs for those paths in every group, diff tabs included.
  - Paths are normalised as doc paths are.
  - Dirty tabs: with auto-save on they are saved and then closed, like the UI. With auto-save off
    they are skipped as `unsaved`. They are never prompted and never force-closed.
  - Closed tabs go on the reopen stack.
  - `all:true` includes singleton tabs.
- **`open_review`.**
  - Replaces the session's Review source, as the picker does.
  - `repo` must be the home or a root (default home).
  - Always focuses the tab.
- **`open_git_history`.**
  - With `ref`, the host resolves one `CommitNode` (`git log -1`), and the renderer selects it
    the way a deep-search hit is selected (components/git-history-view.tsx:655-659), at any
    depth, with no paging. The renderer replies on dispatch.
  - The singleton moves to the caller's session, as the UI does (app.tsx:1010, docs.ts:351-357).
  - Always focuses the tab.
- **`open_url`.**
  - `normalizeUrl` moves from `webview/web-url.ts` to `src/`, so host and renderer share it:
    http(s) only, loopback → http. The host validates; the renderer opens an in-app tab.
  - Webview hardening and the popup gate are unchanged.
  - It never opens the OS browser.
- **`open_file` (changed).** Under policy it opens in the **caller's** session, not the path's
  owning session (today main.ts:2569 can land in an off-screen session or another window).
  Out-of-root files stay text-only.


### 2.2 Ref classification (host, `runGitBin`)

- **Inputs:**
  - A value starting with `-` → `bad_ref`, before git runs.
  - `git log` gets `--end-of-options` before the value. `rev-parse` doesn't (older git echoes it
    back); the leading-`-` check above already keeps options out.
- **Classification:** `rev-parse --symbolic-full-name` decides the kind:
  - `refs/heads/x` → `branch{ref:x}`;
  - `refs/remotes/o/x` → `branch{ref:'o/x', remote:true}`;
  - `refs/tags/x` → `tag{ref:x}`;
  - empty → `commit{sha}` via `rev-parse --verify <v>^{commit}`.
- **Failures:** git's "ambiguous" or a resolution failure → `bad_ref` (git's first stderr line,
  ≤ 200 chars).
- **`working`:** the literal `"working"` is allowed only as a range `head`.

### 2.3 Host↔renderer messages (new)

| Direction | Message |
|---|---|
| Host→renderer | `{type:'mcp:ui', requestId, sessionId, action}`. `action`: `closeSession{target} \| closeFiles \| openReview \| openGitHistory{repoRoot, commit?: CommitNode} \| openUrl` |

- **Routing:** everything goes to the caller's owner window, except `closeSession`, which goes to
  the target's owner window (only that renderer holds the target's docs and unsaved buffers). A window close or
  `did-start-loading` fails its pending UI requests with `window_not_ready` and cancels its asks.
- **Host-side tools:** `focus_session` and `attach_folder` need no UI reply.

### 2.4 Producers / consumers

policy spec §3.1 and §3.4, and §2.3 here, name both sides of every new flow. Only these rows need saying:

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Review / history / web opens | **new** session-explicit renderer entries | docs reducer (unchanged) | Yes. UI callers keep their `activeId` defaults |

## 3. Edge cases & failure modes

| Condition | Behaviour |
|---|---|
| A lead opens 3 sessions with `focus:true` and `when:viewing` | The 2nd and 3rd fail `caller_not_visible`. Documented: use `focus:false`, or set `when:always`. |
| `close_session` with no renderer reply | `ui_timeout`; the outcome is unknown. The host never closes without the renderer's dirty check. |
| `close_files` paths not open | Each goes in `skipped` as `not_open`. |
| `open_git_history` ref unreachable | `bad_ref`. |
| `open_url` with `javascript:`, `file:` or `conduit-preview:` | `bad_url`. |

## 4. Scope slicing

- **MVP, Part B:**
  - the seven tools, `mcp:ui`, ref classification, and `normalizeUrl` moved to `src/`;
  - one e2e per family: session close/focus/attach, `close_files`, review/history, web.
- **v1 (tools):** `detach_folder`, history `query`, an `open_file` range highlight, and an external-browser
  `open_url`.
- **Out of scope:** argument-pattern policies (URL/path allowlists), time-based policies, and PR
  review.

## 5. Acceptance criteria

**EARS**

- When `close_files` runs, every matching clean tab shall close and each dirty or unopened path
  shall be reported in `skipped`.
- When `open_review` or `open_git_history` runs for a split-partner caller, the tab shall open
  active in that session's own layout, with active and split unchanged.
- If a ref argument starts with `-`, then the host shall return `bad_ref` without running git.

## 6. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Everything a tool opens | Existing states | No new states | — |

Settings rows for these tools live in the policy spec.

## 7. Assumptions

- **A4 (amended after runtime QA):** Tool-driven tab activation keeps DOM focus where it was,
  unless the activation hid the focused element; then focus lands in the opened view (§2.1
  "Focus").
- **A5:** Branch names stay branch endpoints, tags stay tags, everything else becomes a SHA.
- **A6:** There is no path confinement for `attach_folder` or `open_file`; the policy is the trust
  decision.
- **A7:** Handle-less sessions are targetable by id only if `list_sessions` lists them (S0, policy spec §6).
- **A8:** `close_files` with auto-save on saves and then closes, matching the UI close.

## 8. Open questions

None blocking. The reviews (r1 on tools, r2 on policies) are logged in the run report.
