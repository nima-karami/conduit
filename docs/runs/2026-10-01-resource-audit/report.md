# Session resource audit

Date: 2026-10-01. Baseline: v0.45.2, commit `a0ec1e7`.

## Findings

Background sessions retain substantially more supporting work than they need. Visibility currently drives activity tracking, but does not govern Git refresh, repository discovery, editor corpora, or terminal resource ownership. Shared repositories are often treated as separate resources for each session.

This audit inspected resource creation, teardown, caches, timers, watchers, cancellation, and process spawning across the host and renderer. It also ran an isolated application experiment and controlled reproductions against the real source. It did not change production behavior. The earlier asynchronous discovery fix remains useful, but does not address these other resource paths.

## What runs where

| Resource | Ownership today | Consequence |
| --- | --- | --- |
| Agent or shell | Persistent PTY per running session | Must keep running and drain output in the background. |
| Git | Short-lived subprocesses; HEAD watcher handles per session | Shared roots can trigger duplicate subprocess waves. Watchers are handles, not separate processes. |
| Repository discovery | Main-process asynchronous work, scheduled per session | Same root can be scanned for several sessions. |
| Project tree | Synchronous main-process traversal | Large directories can still block the application. |
| Terminal | Mounted xterm instance and WebGL resources per running session | Hidden panes retain buffers and graphics resources. |
| TypeScript/JavaScript | Monaco workers and project source corpora per window | Historical roots retain source text without a total byte budget. |
| Go language server | Process shared by language and canonical root | Already shares across sessions, but document references keep it alive. |
| Web tabs | Mounted Electron guests | Actual process allocation and background CPU depend on Chromium and page behavior. |

## Measured evidence

The application experiment used an isolated profile, a tiny committed repository, and shell sessions. One session was logically visible. The user's running application and agents were not used or terminated.

| Measurement | One session | Eight sessions sharing the repository |
| --- | ---: | ---: |
| HEAD watcher handles | 1 | 8 |
| Git commands after one HEAD event | 7 | 35 |
| Renderer working set at settled snapshot | 266 MiB | 331 MiB |
| Main-process working set at settled snapshot | 170 MiB | 220 MiB |

A focus refresh with eight sessions issued four Git commands: that path correctly deduplicates a shared root within one refresh wave. HEAD events use separate session waves and lose that benefit. After the event, Git subprocess concurrency reached six; the existing limit of four governs metadata interrogation, not every Git operation.

Memory readings are snapshots, affected by startup, garbage collection, and retained application state. They are indicative growth, not a precise per-session budget. This experiment does not establish steady-state CPU percentages or forecast savings.

Controlled reproductions used the actual source with bounded fixture inputs or injected filesystem/process adapters:

| Path | Result | Interpretation |
| --- | --- | --- |
| Eight overlapping Git refreshes, twenty roots | 160 interrogations; one result applied; peak concurrency four | Generation checks discard stale results after doing the work. |
| Eight separate refreshes of one shared root | Eight interrogations; one batched wave needs one | Dedupe is limited to a wave. |
| One hundred deleted files in Git status | One hundred simultaneous `git show` calls | Deleted-file content retrieval bypasses a bounded worker pool. |
| Broad project tree | 1,101 synchronous directory reads and 11,100 visited entries to return 400 nodes | The output limit is applied after traversal. |
| Forty concurrent atomic snapshots | Thirty-six `ENOENT` callbacks; final snapshot valid | Writers collide on the same temporary filename. No corruption was observed in this reproduction. |
| `(a+)+$` against an 81-character input, ten-millisecond search budget | Still executing after 250 milliseconds; isolated worker terminated | A single synchronous regex evaluation cannot honor the search deadline. |
| Due timer with 120-millisecond delivery | Eleven scheduled callbacks, ten executed, one delivery | An in-flight due message repeatedly schedules zero-delay checks. |

The Git storm reproduction counted injected process calls; it did not launch one hundred real Git processes. The regex reproduction ran outside the main application to avoid freezing it.

## Fix first: bounded work and lifecycle correctness

1. **Bound deleted-file Git reads globally.** `src/project-info.ts:179` starts all deleted-file HEAD reads with `Promise.all`. Each subprocess can buffer megabytes. Apply a shared Git concurrency budget, cancellation between files, and an aggregate content budget. Preserve deleted-file diffs and line-count behavior.

2. **Serialize persistence per destination.** `src/atomic-write.ts:44` uses the same process-specific temporary filename for concurrent writes. Session changes request full snapshots in `electron/main.ts:1822`. Use one writer per destination, coalesce superseded pending snapshots, and make shutdown wait for or safely quiesce earlier writes before the final flush. Verify ordering and failure recovery, not merely valid JSON.

3. **Move regex evaluation behind an enforceable deadline.** `src/content-search.ts:205` executes user regex synchronously. Asynchronous walking and result caps cannot interrupt catastrophic backtracking. Isolate evaluation while preserving supported JavaScript regex semantics, cancellation, and error reporting.

4. **Reject retired LSP clients after asynchronous root resolution.** `src/lsp-manager.ts:413` awaits root resolution before installing document references, but does not revalidate that the admitted client is still current. A reload or destroyed client during that wait can leave a reference that pins a server. Add a deferred-resolution lifecycle test. Also put a deadline around server initialization (`src/lsp-server.ts:203`).

5. **Exclude in-flight deliveries from timer wake calculations.** `src/timer-scheduler.ts:241` skips their delivery, while `:334` still treats them as immediately actionable. Completion already rearms the scheduler. Fixing wake selection preserves exactly-once delivery and removes needless callbacks.

These changes are independently testable and do not require suspending background agents.

## Share repository work and subscribe by visibility

The renderer reports active and split session IDs (`webview/app.tsx:1503`). The host's visible-message handler (`electron/main.ts:3440`) only updates activity tracking. Repository services do not consume that demand.

- HEAD watches are installed per session, capped at sixteen per session (`electron/main.ts:1304`, `src/repo-git-refresh.ts:6`). Share them by canonical repository root. Keep cheap invalidation signals for background roots, and run expensive interrogation for roots with visible consumers or an explicit action requiring fresh data.
- `src/repo-git-refresh.ts:71` needs cancellation before queued work starts and between roots. The current generation mechanism protects the result, but not the resource budget. Shared single-flight refresh should merge demand and let the latest necessary refresh win.
- Repository scanning is coalesced per session (`electron/main.ts:1267`), not per root. Folder events rescan every owning session (`electron/session-folder-runtime.ts:123`). Share scan results and in-flight scans by canonical root, with explicit invalidation and bounded concurrency.
- Project refresh computes changes for every detected repository (`electron/main.ts:2439`). Subscribe to expensive change details when the relevant view or operation needs them. Keep lightweight badges consistent with cached or explicitly stale metadata.
- The project watcher currently follows the latest project request globally (`electron/session-folder-runtime.ts:78`). A visibility policy must watch the union of roots needed by all visible windows and split panes. Replacing this with only the focused window would introduce a functional regression.
- `src/project-info.ts:250` builds a synchronous tree and truncates afterward. No current renderer consumer of the legacy project `files` payload was found; the Explorer uses directory requests. Verify the bridge contract and remove unused work, or make the remaining traversal asynchronous and stop at its budget.

## Bound retained memory

**Project source corpora.** `webview/ts-project.ts:51` retains indexed source strings and installs them into both TS and JS language services. Per-root file and per-file size caps do not form a total memory budget. Activation indexes roots, but dropping the indexing marker does not remove the corpus. Use root reference ownership and a total byte budget; pin roots needed by visible editors, unsaved models, and navigation. Avoid eagerly warming the TS worker for terminal-only use (`:152`).

**Files, diffs, and models.** Window-lifetime maps (`webview/app.tsx:421`) retain full DTOs, including image/PDF payloads. Closing a clean tab does not necessarily evict its content. Monaco model reuse is intentional and must preserve dirty buffers. Introduce byte-bounded retention for clean, unused content and dispose detached clean models according to an explicit policy.

**Host caches.** File-index and commit-validation TTLs are checked on lookup (`electron/main.ts:453`, `:711`); expiry alone does not remove historical entries. Evict expired entries and release roots when their last owner disappears. The project index retains root path sets as well. Module-resolution caching already has entry and byte bounds; retain that safeguard.

**Terminal links and requests.** Path and commit link caches are unbounded (`webview/components/terminal-pane.tsx:309`). Pending reply entries can outlive the UI timeout. Add bounded caches and remove waiters on timeout, disposal, and cancellation.

**LSP location responses.** `src/lsp-manager.ts:924` can read up to two hundred location targets, with a per-file cap but no aggregate request budget. Cancellation should stop between reads, and total bytes plus cross-request concurrency need bounds. Go servers are already shared by root; do not replace that with a process per session.

## Reduce presentation work without stopping useful work

- Hidden running terminals remain mounted (`webview/components/center-pane.tsx:321`) with 10,000-line buffers and WebGL resources. Visibility already gates fitting, but output still enters the terminal. First separate terminal presentation lifetime from PTY lifetime: unmount currently posts `term:dispose` and kills the PTY (`terminal-pane.tsx:670`). A low-risk first step is releasing hidden WebGL addons while retaining parsing and bounded replay state.
- Timer chips tick every second for some armed timers even in hidden session panes (`webview/components/timer-chip.tsx:84`). Gate the display countdown by pane visibility; keep host delivery running.
- Shader cleanup cancels animation but does not release programs and buffers on effect reruns (`webview/components/shader-bg.tsx:160`). Release graphics resources, including failure paths. Initialize animation state from document visibility (`webview/render-loop.ts:9`). GPU memory growth was not measured here.
- Scroll diagnostics perform layout reads and host logging on ordinary terminal interaction (`webview/terminal-scroll-diagnostics.ts:78`). Make diagnostics opt-in and ensure queued frames cancel on teardown.
- Scrollback persistence checkpoints the full bounded buffer every 250 milliseconds during sustained output (`electron/main.ts:1532`). Background sessions can use a longer checkpoint interval while preserving capture, crash-recovery expectations, and final exit/quit flush. The nominal byte cap is implemented in string characters, which matters when budgeting encoded output.
- Hidden web guests remain mounted. Measure CPU by guest before selecting a suspension policy. Unloading can lose forms, media, downloads, and page state, so it requires different handling from Git metadata.
- PDF documents are already destroyed on switch, rendering is viewport-bounded, and the worker is lazy and shared. Search text extraction still needs cancellation between pages to avoid parallel scans after rapid reopening.
- Missing directory watches retry every two seconds (`electron/watch-dir.ts:114`); folder-health recovery has a shared five-second poll only while roots are missing. Preserve reconnect detection; use shared ancestor observation or slower adaptive background retries instead of removing recovery.
- Plan changes eagerly read and broadcast bodies to windows. Keep background invalidation, but defer body loading until a consumer needs it. Preserve last-owner watcher cleanup.

Window-wide `backgroundThrottling: false` has an existing restoration workaround (`electron/main.ts:1003`). Do not blindly flip it or remove the required GPU switches. Explicitly pausing presentation work is easier to verify without breaking restore behavior.

## Proposed resource policy

| State | Supporting work | Work that stays live |
| --- | --- | --- |
| Visible active or split pane in any visible window | Fresh subscribed Git/tree data, editor services needed by visible documents, terminal rendering | PTY and agent execution, output capture, activity, timers, dirty buffers |
| Background session | Cached metadata, cheap invalidation, deferred/coalesced refresh; release optional graphics resources | The same essential work, notifications and attention detection |
| Background after a grace period | Evict unused clean content and inactive source corpora; idle unused language servers | Unsaved content, running processes, bounded replay and recovery state |

Visibility must be the union across windows and split panes. OS focus alone is insufficient: two windows can be visible on different monitors. Minimized or hidden windows can reduce presentation demand. Shared roots remain warm while any consumer needs them.

On return, refresh invalidated metadata promptly and mark stale data where an action depends on it. Explicit Git operations, file operations, and navigation must acquire fresh required data even from a background session. Root trust and path-containment checks remain mandatory. No user agent or shell should be killed to reclaim supporting resources.

## Implementation and verification order

1. Fix bounded Git reads, persistence ordering, regex isolation, timer wake selection, and the retired-client LSP race.
2. Introduce shared root ownership, single-flight cancellable refresh, and visibility subscriptions across windows. Remove verified-unused project traversal.
3. Add byte budgets and release rules for clean files, models, indices, and source corpora. Then add a grace period for unused language services.
4. Separate PTY lifetime from terminal presentation before reducing hidden terminal memory. Treat web-guest suspension as a separate measured feature.

Regression coverage must include one, eight, and thirty-two sessions; shared and distinct roots; nested repositories; file churn; large deletion sets; active and split panes; multiple visible windows; minimize/restore; rapid session switching; teardown during queued work; and reopening roots until memory reaches a bounded plateau.

Behavioral guards must verify background agent progress, output replay and terminal modes, attention notifications, exactly-once scheduled delivery, dirty-buffer retention, navigation after wake, trust revocation, missing-folder recovery, and shutdown during an in-flight persistence write. Run `npm run verify` and the relevant remote host/PTY/IPC scenarios before shipping changes.

All temporary application profiles and fixture directories from this audit were removed. No production resource-management changes or new release were made by the audit.

Baseline verification completed with exit code zero: `npm run verify`, including 450 test files and 6,597 passing tests (four skipped). Existing lint warnings and three moderate dependency advisories remain. Semgrep was skipped locally because neither Semgrep nor Docker was available; its full scan remains a CI requirement.

## Follow-up implementation

The authorized patch implements visible-session Git batching across windows, shared HEAD watches and in-flight root discovery, deferred hidden discovery/project/index refresh, stale queued-work rejection, and refresh on return. Minimized windows reduce demand; split panes and other visible windows retain it. PTY teardown preserves visibility for relaunch, while actual session removal releases demand.

It also bounds deleted-file Git reads across requests and retains only their counts, makes the project tree asynchronous with an early output cap, bounds and expires host file/commit caches, serializes/coalesces persistence with a protected final sync flush, and isolates regex content search in at most two workers with eight queued jobs and a 2.5-second wall deadline. Timer delivery excludes in-flight messages from wake selection. LSP fixes reject retired clients after root resolution, impose a 90-second initialization deadline, honor navigation cancellation, and cap target text at 16 MiB. Renderer fixes release shader objects, stop hidden countdowns/initial animation, and bound terminal link caches and reply waits.

The application regression exercises eight sessions sharing a root, two visible consumers, one HEAD watcher, deferred hidden Git work, continuing background shell output, and refresh on return. Review also caught and fixed global refresh starvation and wake/teardown edge cases.

Remaining follow-up work requires a separate lifecycle design: releasing editor corpora and clean models after their last session/tab owner disappears, detaching hidden terminal graphics while retaining PTYs and replay, idle language-service suspension with dirty-buffer replay, optional web-guest suspension, and lower-frequency scrollback checkpoints. These are not silently enabled by this patch; they can affect navigation, browser state, and recovery guarantees. The patch addresses the reproduced failures and immediate background work without dropping those capabilities.

Patch verification: `npm run verify` completed with exit code zero on v0.45.4, 459 test files and 6,638 passing tests (four skipped). The isolated `background-resources` application scenario passed, including a regex search through the bundled worker. The release workflow additionally gates publication on the Linux verification/security checks and the full remote Windows end-to-end suite. The earlier v0.45.3 workflow was canceled before publication because the worker build configuration was omitted from staging; the corrected tag includes it.
