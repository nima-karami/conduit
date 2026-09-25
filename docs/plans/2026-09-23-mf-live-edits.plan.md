# mf-live-edits — implementation plan

**Spec:** `docs/specs/archive/2026-09-23-mf-live-edits.md`  **Tier:** FULL

Tier reason: a new host subsystem (scope tracking + typed delivery), a producer change in `PtyHost`
exit bookkeeping (R1), three new protocol messages, a new session state consumed by four renderer
surfaces, two new components and a real-app e2e.

## Goal

A running claude session shows one banner when its folders drift from what the process can see,
and fixes it in place (typed `/add-dir`) or by restart; a session whose home is gone never spawns,
reads "Can't start" and offers Locate… / Use {name} as home.

## Architecture

Everything that decides is pure and lives in `src/`: scope capture from the final spawn args and
drift (`src/agent-scope.ts`), and idle-gated delivery (`src/add-dir-delivery.ts`). One host class,
`AgentScopeTracker` (`electron/agent-scope-tracker.ts`), owns per-session scope, dismissals and the
published view in host memory; it is fed by the cold `term:start`, mf-model's single
`SessionFolderRuntime.onFoldersChanged` hook, exit and dispose. The view reaches the renderer as a
postState **decoration** (like `lastLine`), never through `SessionManager`, so nothing new is
persisted. Restart retires the live child in `PtyHost` (generation-checked exits, R1) and bumps a
runtime `restartSeq` that the terminal pane is keyed on (R2), so the fresh spawn goes through the
ordinary cold `term:start` (R3).

## Data flow

```
term:start (cold) ─► buildLaunchSpec (mf-model) ─ok─► cwdReportingAugmentation ─► pty.start
                                                        │ plan.addDir && alive
                                                        ▼
                                  scopes.captured(id, scopeFromSpawnArgs(spec.cwd, spec.args, …))
folders.onFoldersChanged(id) (L3 edits, Locate, health) ─► scopes.recompute(id)
                                                        │ async stat of stillSeen candidates, latest-wins
                                                        ▼
                                     agentScopeDrift ─► view changed? ─► postState()
postState ─► activity.apply(owned, runtimeFields) ─► Session.{lastLine, agentScope?, restartSeq?}
renderer: CenterPane ─► AgentScopeBanner (s.agentScope, s.busy)
   Run /add-dir ─► session:addDirsToAgent{sessionId,requestId} ─► runAddDirs(gen-bound) ─► pty.input ×2/path
                                                                 └► scopes.delivered(id,p) ─► recompute
                    ◄── agentScope:result{requestId,sessionId,ok,reason?}
   Restart ─► session:restart ─► pty.retire(id) + endProcessEpisode + scopes.ended + restartSeq++ ─► postState
               TerminalPane key `${id}:${restartSeq}` remounts ─► term:dispose (no-op) ─► term:start cold
   × ─► session:dismissAgentScope ─► scopes.dismiss(id)
old child's onExit ─► PtyHost: retired → silent (no term:exit) ; data from a non-current child dropped
homeMissing (mf-model health) ─► sessionIconState 'cantStart' ─► card / palette / centre MissingHomeState
   Locate… ─► mf-files session:locateFolder   Use {name} as home ─► session:setHome (mf-model)
relaunch / session:restart / autoRelaunchStale ─► refused when homeMissing (host + renderer)
```

## Settled decisions — do not re-litigate

- `.autoloop/locked.md` L1–L12; spec §13 picks D1–D20 stand. Accepted highs (`.autoloop/blockers.md`):
  **D3/D5** type `/add-dir <path>` + Enter via the host, refused while `busy`, no queue; **D11** a
  `homeMissing` session never spawns.
- **L11:** one picker seam (`folder:pick` + `global.__pickDirHook`, mf-new-session), no
  `__folderPickerQueue`; one Locate handler `session:locateFolder` **built by mf-files**; this item
  only calls it.
- **L12 S7:** no `launchedRoots`/`skippedAddDirRoots` on the session. Claude's visible scope is
  derived here from the final spawn args at each cold claude start; "claude adapter" = mf-model's
  `LaunchPlan.addDir === true` (no second basename matcher).
- mf-model already built the spawn half of D11: `buildLaunchSpec` returns
  `{ok:false, reason:'home-missing'}` and the cold `term:start` spawns nothing; the 5 s poll covers
  `homeMissing` (D20 holds).
- Tokens: `--amber` (banner, dot, primary), `--danger`, `--success`, `--accent`; no hex.
- Build order is serial (`.autoloop/tasks.yaml`): model > changes > new-session > files > sidebar >
  review > **live-edits** > board. Every upstream export below exists when this item builds.

## Spec staleness

- Spec header / §7 / D15: "`__folderPickerQueue` e2e seam" — superseded by L11; the e2e uses
  `global.__pickDirHook.queue([...])` via `app.evaluate`.
- mf-files spec §2.5/§3.2 calls the Locate message `folder:locate` "owned by mf-live-edits" —
  superseded by L11 (`session:locateFolder`, owned and built by mf-files).
- §0 row "ASSUMED → D12": measured true by source read — busy window 1500 ms
  (`src/session-activity.ts:109`), `deliverTimedMessage` alive → text → `SUBMIT_GAP_MS` → alive → `\r`
  (`electron/main.ts:1432`), `relaunch` only flips status + marker (`electron/main.ts:2731`),
  `PtyHost.dispose` kills and deletes the entry before `onExit` (`src/pty-host.ts` `dispose`),
  `sanitizeMessage` in `src/timed-messages.ts:103`.
- §2.4 "keep its PtyHost entry until its own `onExit`": keeping the dying child in `procs` would make
  the remounted pane's `term:start` take the ATTACH branch (`pty.isAlive` true, `electron/main.ts:3108`)
  and never spawn. The plan detaches it into a `retired` set instead: still tracked (quit kills it,
  its exit is logged) but no longer "alive". Same intent (R1), workable mechanics.
- §2.1 signature `agentScopeDrift(session, scope, dismissed, exists, samePath)`: path identity uses
  mf-model's `folderKey` (string-only, drive-letter folding, posix case-sensitive — no
  `process.platform`), so no `samePath` parameter.
- §2.1 `stillSeen` taken literally flags a user's own `agents.json --add-dir C:\shared` on every
  claude start, and no restart can clear it. The scope records `external` (entries not covered by
  the session's folders at spawn); those never enter `stillSeen` (Decisions Needed).
- AC-6 "extends `resolve-launch-spec.test.ts`": the cwd rule now lives in mf-model's
  `buildLaunchSpec` (`test/unit/launch-spec.test.ts`); AC-6 is verified there (T2.3).
- §3.1 payloads gain `requestId` so the renderer uses mf-new-session's `requestHost`.
- §2.4 R2 needs a renderer-visible generation; the spec names no field. Added: runtime-only
  `Session.restartSeq?: number` (host decoration).

## Global constraints

- Gate: `npm run verify`. Never disable, narrow or skip a check. Per task: `npx vitest run <file>`
  (red first). `npm run typecheck` runs both tsconfigs.
- **This machine is shared with another agent's PTY e2e:** no `npm run build`/e2e/verify while it
  runs; e2e only serially, `node test/e2e/run-smoke.mjs <name>`, re-run a PTY-echo failure alone on a
  quiet machine before believing it. Never kill processes by name.
- Renderer-safe (no `node:*`, no DOM): `src/agent-scope.ts`, `src/add-dir-delivery.ts`,
  `src/session-icon.ts`, `src/stale-sessions.ts`. Host-only: `src/pty-host.ts`, `electron/*`.
- Unit tests never depend on `process.platform` or native `path`; inject `path.win32.resolve` /
  `path.posix.resolve`; paths as strings with explicit separators.
- Every new export has an importer (production module or `test/unit/*.test.ts`) by the end of its
  slice (fallow).
- Naming: kebab-case files; components PascalCase; tests `test/unit/<module>.test.ts`; jsdom tests
  start `// @vitest-environment jsdom` and use `createElement` + `createRoot` + `act` as
  `test/unit/middle-click-menus.test.ts` does. e2e `test/e2e/<name>.e2e.mjs` on
  `test/e2e/harness.mjs`, Windows-only skip, hidden.
- Comments: WHY only; point at the spec section (`// see mf-live-edits spec §2.4 R1`).
- The host types into the PTY with raw `pty.input` (like timed messages), never xterm `paste()`.
- Upstream line numbers have shifted; locate every edit site **by symbol**.
- CSS: no hex, no `!important`, no specificity escalation; extend selector lists / add modifiers.

## Upstream exports this plan depends on (confirm before Slice 1; a mismatch is stop-and-report)

- mf-model: `Session.home/roots/missingRoots?/homeMissing?` (`src/types.ts`); `folderKey(p)`
  (`src/folder-key.ts`); `isAncestorOf(root, child)` (`src/owning-session.ts`); `presentRoots(s)`
  (`src/session-folders.ts`); `buildLaunchSpec(req): LaunchPlan` with `LaunchPlan.addDir`
  (`src/launch-spec.ts`); `SessionFolderRuntime.onFoldersChanged(cb): {dispose()}` and
  `.pending(id)` (`electron/session-folder-runtime.ts`, instance `folders` in `electron/main.ts`);
  `session:setHome {sessionId, path, requestId?}` → `session:opResult {requestId, ok, reason?}`;
  `session:addRoot` (same reply).
- mf-new-session: `requestHost(send, types, timeoutMs)` (`webview/host-request.ts`);
  `global.__pickDirHook` (`electron/folder-picker.ts`).
- mf-files: `session:locateFolder` message + reply, and the renderer call its missing-folder box uses
  (see T4.3).
- mf-sidebar: the card pill renders `SESSION_STATE_WORD[sessionIconState(s)]`; card keeps ↻
  (`.session__relaunch`).
- Existing: `requestTerminalFocus(id)` (`webview/terminal-bus.ts`), `pushToast` (`webview/toast-store.ts`),
  `plural` (`src/plural.ts`), `SUBMIT_GAP_MS` (`src/timed-messages.ts`), `IconClose` (`webview/icons.tsx`).

## Out of scope

Files-tab missing box and Locate itself (mf-files); existence detection and the poll (mf-model);
`--add-dir` equivalents for codex/cursor-agent (L5); `--continue`; learning manual `/add-dir`s from
output; auto-spawn when a home returns; fake-shell (`webview/bridge.ts`) and `webview/mock.ts`
handling of the new messages (the banner never shows in preview: mock sessions carry no
`agentScope`); QA-1/QA-2 (runtime QA, outside the gate).

## Contracts

### `src/types.ts`
```ts
export interface AgentScopeView { unseen: string[]; stillSeen: string[]; typeable: string[] } // typeable ⊆ unseen, unseen order
export interface Session {
  // …existing
  agentScope?: AgentScopeView;  // runtime-only: postState decoration; absent when unseen and stillSeen are both empty
  restartSeq?: number;          // runtime-only: postState decoration; bumped by session:restart on a live child (R2)
}
```

### `src/persistence.ts`
`serializeSessions` strip list += `agentScope`, `restartSeq` (AC-7).

### `src/agent-scope.ts` (renderer-safe)
```ts
import type { AgentScopeView, Session } from './types';
export interface AgentScope {
  cwd: string;        // spec.cwd of the spawn
  dirs: string[];     // every --add-dir value in the final args (+ delivered /add-dir paths), resolved, deduped by folderKey
  external: string[]; // entries of [cwd, ...dirs] NOT covered by home/roots at capture; never stillSeen
}
export type DismissKind = 'unseen' | 'stillSeen';
export function scopeFromSpawnArgs(
  cwd: string,
  args: readonly string[],
  resolve: (base: string, p: string) => string,          // host: path.resolve
  folders: Pick<Session, 'home' | 'roots'>,
): AgentScope;
export async function agentScopeDrift(
  s: Pick<Session, 'home' | 'homeMissing' | 'roots' | 'missingRoots'>,
  scope: AgentScope,
  dismissed: ReadonlyMap<string, DismissKind>,           // folderKey → the list it was dismissed from
  exists: (p: string) => Promise<boolean>,               // called ONLY for stillSeen candidates
): Promise<AgentScopeView | undefined>;                  // undefined when both lists are empty
export function pruneDismissed(
  dismissed: ReadonlyMap<string, DismissKind>,
  s: Pick<Session, 'home' | 'roots'>,
): Map<string, DismissKind>;
export function isTypeablePath(p: string): boolean;
// module-private: covered(p, entries) — folderKey(p) equals, or isAncestorOf(folderKey(e), folderKey(p)) for some e
```
Rules:
- Parse: a token `--add-dir=x` → `x`; a token `--add-dir` → every following token until one starting
  with `-` (variadic; `--add-dir a b -p` → a, b). Empty values dropped. Relative → `resolve(cwd, v)`.
- `unseen` = `[home unless homeMissing, ...presentRoots(s)]` not covered by `[scope.cwd, ...scope.dirs]`,
  minus keys dismissed as `'unseen'`.
- `stillSeen` = `[...scope.dirs, scope.cwd]` (deduped by key) not covered by `[home, ...roots]`
  (missing roots included), not in `external`, not dismissed as `'stillSeen'`, and `await exists(p)`.
- `typeable` = `unseen.filter(isTypeablePath)`. `isTypeablePath`: false when any code unit is in
  `0x00–0x1F`, `0x7F`, `0x80–0x9F`, or the path starts with `\\` or `//`; spaces and `&` are fine.
- `pruneDismissed`: an `'unseen'` entry survives only while its key is a key of home/roots (removal
  drops it); a `'stillSeen'` entry survives only while its key is NOT covered by home/roots (re-adding
  drops it).

### `src/add-dir-delivery.ts` (renderer-safe)
```ts
export const ADD_DIR_LINE_GAP_MS = 300;
export type AgentScopeReason =
  | 'noSession' | 'notRunning' | 'notClaude' | 'nothingPending'
  | 'busy' | 'inFlight' | 'writeFailed' | 'homeMissing';
export type AddDirsResult =
  | { ok: true; delivered: string[] }
  | { ok: false; reason: AgentScopeReason; delivered: string[] };
export interface AddDirsDeps {
  sessionId: string;
  inFlight: Set<string>;                             // host-owned per-session latch
  sessionExists: () => boolean;
  isAlive: () => boolean;                            // bound to the generation live at the call (R1)
  isBusy: () => boolean;                             // activity.statusOf(id).busy
  typeable: () => readonly string[] | undefined;     // undefined = no scope (non-claude / not captured)
  write: (data: string) => boolean;                  // pty.input(id, data)
  sleep: (ms: number) => Promise<void>;
  onDelivered: (path: string) => void;               // scopes.delivered(id, path)
}
export function runAddDirs(deps: AddDirsDeps): Promise<AddDirsResult>;
```
Order: `!sessionExists` → `noSession`; `!isAlive` → `notRunning`; `typeable()` undefined →
`notClaude`; empty → `nothingPending`; `isBusy` → `busy` (**zero writes**); `inFlight.has(id)` →
`inFlight`; else add to latch, snapshot the list, per path: `isAlive` → `write('/add-dir ' + p)` →
`sleep(SUBMIT_GAP_MS)` → `isAlive` → `write('\r')` → `onDelivered(p)`; `sleep(ADD_DIR_LINE_GAP_MS)`
between paths (not after the last). Any failed check/write → `writeFailed` with `delivered` so far.
Latch released in `finally`. Busy is checked once, before the first write. The path is typed
verbatim (no `sanitizeMessage`, no quoting).

### `src/pty-host.ts`
```ts
start(sessionId: string, cols: number, rows: number, spec: SpawnSpec): void;  // unchanged signature; assigns a fresh generation
generation(sessionId: string): number | undefined;   // the CURRENT child's generation; undefined when none
retire(sessionId: string): boolean;                   // kill the current child and detach it: isAlive → false at once; false when none
```
Internals: `procs: Map<string, { proc: IPty; gen: number }>`, `retired: Set<IPty>`, one monotonic
`nextGen` per host. Each child's callbacks close over its own `proc`:
- `onData`: forwarded (tail, `term:data`) **only** while `procs.get(id)?.proc === proc`.
- `onExit`: `retired.delete(proc)` → log, return (no `term:exit`); current entry is another child →
  log `stale exit ignored`, return; entry is this child → delete it, send `term:exit`; no entry
  (disposed) → send `term:exit` (today's behaviour — `disposeSession` relies on it).
- `dispose` unchanged in meaning; `disposeAll` also kills and clears `retired`.

### `electron/agent-scope-tracker.ts` (host)
```ts
import type { AgentScope } from '../src/agent-scope';
import type { AgentScopeView, Session } from '../src/types';
export interface AgentScopeTrackerDeps {
  get: (id: string) => Session | undefined;
  exists: (p: string) => Promise<boolean>;     // fs.promises.stat(p).then(s => s.isDirectory(), () => false)
  onChange: (sessionId: string) => void;       // host: postState()
}
export class AgentScopeTracker {
  constructor(deps: AgentScopeTrackerDeps);
  captured(sessionId: string, scope: AgentScope): void;  // replaces scope, clears dismissals, recompute
  ended(sessionId: string): void;                        // exit / restart / dispose: drop scope, dismissals, view; onChange iff a view existed
  recompute(sessionId: string): void;                    // fire-and-forget; no-op without a scope; latest call wins
  delivered(sessionId: string, path: string): void;      // append to scope.dirs (key-deduped), recompute
  dismiss(sessionId: string): void;                      // current view's unseen → 'unseen', stillSeen → 'stillSeen'; recompute
  view(sessionId: string): AgentScopeView | undefined;
  typeable(sessionId: string): readonly string[] | undefined;  // undefined = no scope; [] = scope, nothing typeable
}
```
`recompute`: per-session token incremented per call; after `await agentScopeDrift(...)` the result
is applied only if the token is still current AND the scope object is the same one (an `ended`
mid-stat can't resurrect a view). Dismissals are `pruneDismissed` first. `onChange` only when the
view changed (arrays compared element-wise; `undefined` vs `undefined` is no change).

### Protocol — `src/protocol.ts`
```ts
import type { AgentScopeReason } from './add-dir-delivery';
// renderer → host
| { type: 'session:addDirsToAgent'; sessionId: string; requestId: number }
| { type: 'session:restart'; sessionId: string; requestId: number }
| { type: 'session:dismissAgentScope'; sessionId: string }
// host → renderer (to the sender only)
| { type: 'agentScope:result'; requestId: number; sessionId: string; ok: boolean; reason?: AgentScopeReason }
```
Validation: non-string `sessionId` → `reason: 'noSession'`; non-number `requestId` → `log.warn`, no
reply, no action. `session:restart` replies `ok: true` on success too (requestHost needs a reply).

### Host behaviour (`electron/main.ts`)
- `endProcessEpisode(id)`: the per-child teardown extracted from the `term:exit` branch —
  `activity.recordExit`, `cwdScanners.delete`, `bellScanState.delete`, `limitEpisodes.delete`,
  `teardownGitRefresh`, `flushScrollback` when `settings.scrollbackPersistence`. `term:exit` =
  `log.info` + `mgr.setStatus(id,'exited')` + `endProcessEpisode(id)` + `scopes.ended(id)`.
- `restartSeq = new Map<string, number>()`; `runtimeFields(id)` = `{ lastLine, agentScope?, restartSeq? }`
  (keys omitted when undefined) replaces `withLastLine` in `postState`.
- `session:restart`: `await folders.pending(id)`; re-`get` → `noSession`; `homeMissing` →
  `homeMissing`; if `pty.isAlive(id)`: `pty.retire(id)`, `endProcessEpisode(id)`, `scopes.ended(id)`,
  `restartSeq.set(id, (restartSeq.get(id) ?? 0) + 1)`; then `mgr.setStatus(id,'running')`,
  `pendingRelaunchMarker.add(id)`, `postState()`, reply `ok: true`.
- `relaunch`: `await folders.pending(m.id)`; re-`get`; absent or `homeMissing` → `log.info` and stop.
- mf-model's cold `term:start` refusal branch additionally: `pendingRelaunchMarker.delete(id)` and
  `mgr.setStatus(id, 'stale')` (never `'exited'`: `app.tsx`'s exit effect auto-kills an exited shell).
- Cold `term:start` after `pty.start`: when `plan.addDir && pty.isAlive(id)`,
  `scopes.captured(id, scopeFromSpawnArgs(spec.cwd, spec.args, path.resolve, s))` with the final
  (augmented) `spec` and the re-got `s`.
- `deliverTimedMessage` binds to `pty.generation(id)` at entry and re-checks equality after the gap
  (a restart inside the gap must not send the dead message's Enter into the new child).
- `disposeSession`: `scopes.ended(id)`, `restartSeq.delete(id)`.

### Renderer — `src/session-icon.ts`, `src/stale-sessions.ts`
```ts
export type SessionIconVisualState = 'stale' | 'cantStart' | 'busy' | 'attention' | 'review' | 'idle';
export type SessionStateFields = Pick<Session, 'status' | 'busy' | 'needsAttention' | 'completedRun' | 'git' | 'homeMissing'>;
// sessionIconState: status !== 'running' && homeMissing → 'cantStart' (first); else as today
// SESSION_STATE_WORD.cantStart = "Can't start"
export function canRelaunch(s: Pick<Session, 'status' | 'homeMissing'>): boolean;  // status !== 'running' && !homeMissing
export function relaunchableSessionIds(sessions: Session[]): string[];             // status === 'stale' && !homeMissing
```
`src/palette-state.ts` `TONE_BY_SESSION_STATE.cantStart = 'quiet'` (spec: reuses the stale look).

### Renderer — `webview/agent-scope-copy.ts`
```ts
import type { AgentScopeReason } from '../src/add-dir-delivery';
import type { AgentScopeView } from '../src/types';
export type CopySegment = { kind: 'text' | 'name'; text: string };   // 'name' renders in a truncating span
export interface BannerCopy { segments: CopySegment[]; title: string; second?: CopySegment[] }
export function bannerCopy(view: AgentScopeView): BannerCopy;
export type BannerPrimary = 'addDir' | 'restart' | null;
export interface BannerActions { showAddDir: boolean; addDirDisabled: boolean; showRestart: boolean; primary: BannerPrimary }
export function bannerActions(view: AgentScopeView, o: { busy: boolean; homeMissing: boolean }): BannerActions;
export const ADD_DIR_BUSY_TITLE: string;        // "claude is working — try again when it's idle"
export const RESTART_CONFIRM: string;           // 'Restart claude? This conversation ends.'
export function agentScopeToast(reason: AgentScopeReason): string | null;  // null = silent (log only)
export const MISSING_HOME_TITLE: string;        // 'Home folder not found'
export function useAsHomeLabel(name: string): string;           // `Use ${name} as home`
export function useAsHomeFailedToast(name: string): string;     // `Couldn't make ${name} the home folder`
```
`bannerCopy` (names = `sessionNameFromPath` basenames; `title` = every full path, newline-joined):
1 unseen `claude can't see {a} yet`; 2 `claude can't see {a} and {b} yet`; ≥3
`claude can't see {a} and {plural(n,'more folder')} yet`; only stillSeen
`claude can still see {a} until it restarts` (≥2: `{a} and {plural(n,'more folder')}`); both →
unseen segments + `second` = `It can still see {x} until it restarts.` (x per the stillSeen rule).
`bannerActions`: unseen with typeable → `showAddDir`, primary `addDir`; unseen none typeable or
stillSeen only → primary `restart`, no Add; `addDirDisabled = busy`; `homeMissing` → `showRestart`
false and a `'restart'` primary becomes `null` (restart would be refused).
`agentScopeToast`: `busy` → the busy copy; `writeFailed`/`notRunning` →
`Couldn't type /add-dir — claude isn't running`; others → `null`.

### Components
```ts
// webview/components/agent-scope-banner.tsx
export function AgentScopeBanner(props: { session: Session }): JSX.Element | null;  // null without session.agentScope
// webview/components/missing-home-state.tsx
export function MissingHomeState(props: {
  session: Session;
  onFixed: () => void;                       // centre focuses the Relaunch/Restart button once the normal block renders
}): JSX.Element;                             // a fragment; CenterPane owns the `.stale` wrapper and its WaitingLine
```
Banner markup: `div.scope-banner` → `span.scope-banner__dot[aria-hidden]`,
`div.scope-banner__msg[role=status][aria-live=polite][title]` (segments; `name` →
`span.scope-banner__name[dir=ltr]`; `second` in `div.scope-banner__second`), `div.scope-banner__actions`:
`button.btn` "Run /add-dir" (primary → `btn--warn`, `disabled` + `title=ADD_DIR_BUSY_TITLE` while busy
or sending), `button.btn` "Restart claude" (`btn--warn` when primary, else `btn--ghost`),
`button.scope-banner__close[aria-label=Dismiss]` (`IconClose`). Confirming replaces msg + actions
with `RESTART_CONFIRM` + `button.btn.btn--warn` "Restart" + `button.btn.btn--ghost` "Cancel".
Missing-home markup (a fragment CenterPane places inside its `div.stale`, before the module-private
`WaitingLine` it already renders there): `h2.stale__title` `MISSING_HOME_TITLE`,
`p.stale__path[dir=ltr]` (full home, selectable, wrapping), `button.btn.btn--warn` "Locate…",
optional `button.btn.btn--ghost.stale__usehome` (`useAsHomeLabel(name)`, name truncating, `title` =
full path).

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Agent scope (capture) | cold `term:start` final `spec` + `plan.addDir` | `AgentScopeTracker` | both |
| Drift recompute trigger | `SessionFolderRuntime.onFoldersChanged` (mf-model: L3 ops, Locate via `SessionOps.replaceRoot`/`setHome`, health changes) | `scopes.recompute` | consumer only — the producer is locked (L12 S1) and already fires for every folder mutation and health change (mf-model plan §SessionFolderRuntime) |
| `Session.agentScope` / `restartSeq` | `postState` decoration | `CenterPane` (banner, pane key); `serializeSessions` strip | both |
| Typed `/add-dir` line | `runAddDirs` | claude's input (QA-2) | producer; the consumer is claude, probed in QA-2 |
| `busy` | `SessionActivity` | banner disabled state, `runAddDirs` gate | read-only |
| PTY exit / data after retire | `PtyHost` (R1) | `term:exit` branch in main, `TerminalPane` (`[process exited…]` line) | both: exits of retired/stale children are silent, so neither consumer sees them |
| `term:exit` for a **disposed** child | `PtyHost` | `disposeSession`'s reliance ("term:exit … closed any live watcher") | unchanged, kept explicitly |
| Status after refused `term:start` | term:start refusal (mf-model code, edited here) | card, centre, `app.tsx` exit effect | both: `'stale'` chosen so the exit effect (keys on `→ 'exited'`) never auto-kills |
| `cantStart` state | `sessionIconState` | card pill/class (`session-card.tsx`), palette (`palette-state.ts`), attention chip (`src/attention.ts` — reads `'attention'` only, unaffected), sidebar collapsed-header signal (`sidebar.tsx` — busy/attention only, unaffected) | producer + the two readers that map every state |
| Relaunch affordances | — | card ↻, card menu Relaunch, palette `cmd:relaunch` + `cmd:relaunchAllStale`, `relaunchAllStale`, `autoRelaunchStale`, centre ↻ | all gated; host `relaunch` also refuses (renderer is not trusted) |
| `staleSessionIds` | `src/stale-sessions.ts` | Close-all-stale (sidebar menus, palette `cmd:closeAllStale`, `app.tsx` `closeAllStale`) | unchanged — closing a can't-start session stays allowed |
| Locate | mf-files `session:locateFolder` | MissingHomeState | consumer only |
| Timed delivery generation bind | `deliverTimedMessage` | `TimerScheduler` (`delivered` result) | producer; the scheduler only reads the boolean, unchanged |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/types.ts` | modify | `AgentScopeView`; `Session.agentScope?`, `Session.restartSeq?` |
| `src/persistence.ts` | modify | strip `agentScope`, `restartSeq` |
| `src/agent-scope.ts` | create | scope capture, drift, dismiss pruning, typeable |
| `src/add-dir-delivery.ts` | create | `runAddDirs`, `AgentScopeReason`, `ADD_DIR_LINE_GAP_MS` |
| `src/pty-host.ts` | modify | generations, `retire`, generation-checked data/exit |
| `electron/agent-scope-tracker.ts` | create | host scope/dismissal/view state |
| `src/protocol.ts` | modify | three messages + `agentScope:result` |
| `electron/main.ts` | modify | tracker wiring, handlers, `endProcessEpisode`, relaunch/refusal gates, decoration, timed-delivery bind |
| `src/session-icon.ts` | modify | `cantStart` state + word |
| `src/palette-state.ts` | modify | tone for `cantStart` |
| `src/stale-sessions.ts` | modify | `canRelaunch`, `relaunchableSessionIds` |
| `webview/app.tsx` | modify | relaunch affordances gated |
| `webview/components/session-card.tsx` | modify | ↻ gated by `canRelaunch` |
| `webview/agent-scope-copy.ts` | create | every banner / centre / toast string and the banner action model |
| `webview/components/agent-scope-banner.tsx` | create | 12c banner |
| `webview/components/missing-home-state.tsx` | create | 12d centre state |
| `webview/components/center-pane.tsx` | modify | banner mount, pane key, centre-state switch, Relaunch focus |
| `webview/styles.css` | modify | `.scope-banner*`, `.btn--warn`, `.stale__path`, `.stale__usehome`, `.session--cantStart`, `.termhost__body` column |
| `test/unit/agent-scope.test.ts` | create | AC-1, AC-2, AC-3 |
| `test/unit/add-dir-delivery.test.ts` | create | AC-8 |
| `test/unit/pty-host-generations.test.ts` | create | AC-9 |
| `test/unit/agent-scope-tracker.test.ts` | create | tracker races, dismissal |
| `test/unit/persistence.test.ts` | modify | AC-7 |
| `test/unit/session-icon.test.ts`, `test/unit/palette-state.test.ts`, `test/unit/stale-sessions.test.ts` | modify | AC-4 |
| `test/unit/agent-scope-copy.test.ts` | create | AC-5 |
| `test/unit/agent-scope-banner.test.ts` | create | banner states, focus, Esc (jsdom) |
| `test/unit/missing-home-state.test.ts` | create | centre state (jsdom) |
| `test/unit/launch-spec.test.ts` | modify only if a case is missing | AC-6 |
| `test/e2e/fixtures/fake-claude.mjs` | create | the fake agent the e2e spawns |
| `test/e2e/mf-live-edits.e2e.mjs` | create | E1–E7, AC-10 |

**Added by fix1** (review REVISE + real-claude QA FAIL, conductor design change; spec §2.3 is
the contract):

| Path | Action | Responsibility |
|---|---|---|
| `src/session-dot.ts` | modify | doc comment only ("five" → "six" states). Unplanned in the first pass; ratified here (review F6) |
| `src/terminal-output.ts` | create | `scanInertOutput` (a chunk that draws nothing is not activity, QA F1), bracketed-paste mode tracking |
| `src/add-dir-confirm.ts` | create | matches claude's own "Added … as a working directory" family of lines — the only evidence that makes a folder seen |
| `src/add-dir-delivery.ts` | rewrite | `runAddDir`: one bracketed paste, no Enter; `addDirArg` (trailing separator, drive root) |
| `electron/agent-scope-tracker.ts` | modify | `pasted`, `output` (scan), `tracks`; `delivered` removed |
| `src/types.ts` | modify | `AgentScopeView.pasted?`, `Session.startRefusal?` (review B1) |
| `webview/components/missing-home-state.tsx` | modify | `StartRefusedState`; home path in native separators (QA F6) |
| `test/unit/terminal-output.test.ts`, `test/unit/add-dir-confirm.test.ts` | create | the two new pure modules, on measured claude 2.1.282 bytes |
| `test/unit/state-vocabulary.test.ts`, `test/unit/theme-tokens.test.ts` | modify | review F1/F2 guards; the centre block's 4.5:1 guard (QA F5) |

## Scripts

None — no edit repeats across files; the e2e's `claude.cmd` is generated inside the scenario.

## Slices

### Slice 1: Pure logic — scope, delivery, PTY generations

**Check:** `npx vitest run test/unit/agent-scope.test.ts test/unit/add-dir-delivery.test.ts test/unit/pty-host-generations.test.ts test/unit/pty-host-io.test.ts test/unit/persistence.test.ts`; `npm run typecheck`.

**Parallel groups:** Serial: T1.1 · G1: T1.2 · G2: T1.3 · G3: T1.4
**Claims (serial lane):** `src/types.ts`

#### Task 1.1: Types + persistence strip
**Files:** Modify `src/types.ts`, `src/persistence.ts` (`serializeSessions` destructure), `test/unit/persistence.test.ts`.
**Interfaces:** Produces `AgentScopeView`, `Session.agentScope?`, `Session.restartSeq?`.
**Steps:**
- [ ] Failing test `'serialize strips agentScope and restartSeq'` — `JSON.parse(serializeSessions([{…, agentScope:{unseen:['/a'],stillSeen:[],typeable:['/a']}, restartSeq: 2}])).sessions[0]` has neither key.
- [ ] Run — FAIL (keys present); implement.

#### Task 1.2: `src/agent-scope.ts`
**Files:** Create `src/agent-scope.ts`, `test/unit/agent-scope.test.ts`.
**Interfaces:** Consumes `AgentScopeView`, `folderKey`, `isAncestorOf`, `presentRoots`. Produces `AgentScope`, `DismissKind`, `scopeFromSpawnArgs`, `agentScopeDrift`, `pruneDismissed`, `isTypeablePath` (Contracts).
**Steps:**
- [ ] Failing tests (AC-2): `'--add-dir x, --add-dir=y and variadic --add-dir a b -p all captured'` — dirs `[x,y,a,b]`; `'relative value resolves against cwd'` (`path.win32.resolve`: `C:\h` + `sub` → `C:\h\sub`); `'user-supplied dir outside the folders is external'`; `'dir under home is not external'`.
- [ ] Failing tests (AC-1, fake `exists`): `'added root → unseen'`; `'root inside a scope dir → not unseen'`; `'removed root still in scope → stillSeen'`; `'removed root that no longer exists → not stillSeen'` (and `exists` called only for candidates); `'missing root in scope → neither'`; `'Make home swap → undefined'`; `'dismissed unseen / stillSeen excluded'`; `'external never stillSeen'`; `'homeMissing → home not unseen'`; `'C:\\A vs c:/a/ same folder; /A vs /a different'`.
- [ ] Failing tests (AC-3): `'double spaces kept verbatim in typeable'`; `'\\x07, \\x7f, \\x85 rejected'`; `'\\\\host\\share and //host/share rejected'`; `'R&D typeable'`.
- [ ] Failing tests: `pruneDismissed` `'removed root drops its unseen dismissal'`, `'re-added path drops its stillSeen dismissal'`.
- [ ] Run — FAIL (module missing); implement.

#### Task 1.3: PtyHost generations
**Files:** Modify `src/pty-host.ts`; create `test/unit/pty-host-generations.test.ts` (own `vi.mock('@lydell/node-pty')` recording every spawned child with its own `onData`/`onExit`/`kill`, as `test/unit/pty-host-io.test.ts` does for one).
**Interfaces:** Produces `generation(sessionId)`, `retire(sessionId)`.
**Call sites:** `start`/`dispose`/`disposeAll` callers in `electron/main.ts` unchanged; `pty-host-io.test.ts` must stay green unmodified.
**Steps:**
- [ ] Failing tests (AC-9): `'gen-1 exit after retire + gen-2 start leaves gen 2 alive and sends no term:exit'`; `'gen-1 exit after dispose + gen-2 start is ignored'`; `'data from a retired child is dropped'`; `'exit of a disposed child with no successor still sends term:exit'`; `'generation increases per start; undefined when none'`; `'retire → isAlive false at once; retire with none → false'`; `'disposeAll kills retired children'`.
- [ ] Run — FAIL; implement.

#### Task 1.4: `runAddDirs`
**Files:** Create `src/add-dir-delivery.ts`, `test/unit/add-dir-delivery.test.ts`.
**Interfaces:** Consumes `SUBMIT_GAP_MS`. Produces `ADD_DIR_LINE_GAP_MS`, `AgentScopeReason`, `AddDirsResult`, `AddDirsDeps`, `runAddDirs`.
**Steps:**
- [ ] Failing tests (AC-8, fake deps, `sleep` resolves immediately and records ms): `'busy → busy with zero writes'`; `'idle, two paths → writes exactly ["/add-dir C:\\a b", "\\r", "/add-dir D:\\c", "\\r"] and sleeps [120, 300, 120]'`; `'dead after the first Enter → writeFailed, delivered [p1], onDelivered once'`; `'second call while the first awaits → inFlight, no writes'`; `'latch released after a failure'`; `'no scope → notClaude; empty → nothingPending; dead → notRunning; gone → noSession'`.
- [ ] Run — FAIL; implement.

### Slice 2: Host — tracker, messages, restart, gates

**Check:** `npx vitest run test/unit/agent-scope-tracker.test.ts test/unit/launch-spec.test.ts test/unit/timed-messages.test.ts`; `npm run typecheck`; `npm run fallow:check`. (Real-app proof is Slice 5.)

**Parallel groups:** G1: T2.1 · Serial: T2.2 → T2.3
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`

#### Task 2.1: `AgentScopeTracker`
**Files:** Create `electron/agent-scope-tracker.ts`, `test/unit/agent-scope-tracker.test.ts`.
**Interfaces:** Consumes `AgentScope`, `agentScopeDrift`, `pruneDismissed`, `DismissKind`, `AgentScopeView`. Produces `AgentScopeTrackerDeps`, `AgentScopeTracker` (Contracts).
**Steps:**
- [ ] Failing tests (fake `get`, controllable `exists` promises): `'captured with an unseen root publishes a view and calls onChange once'`; `'recompute with no drift change does not call onChange'`; `'an older recompute resolving after a newer one is discarded'`; `'ended while a stat is pending: the late result publishes nothing'`; `'dismiss hides the current lists; a later add shows only the new folder'` (AC-10 logic); `'delivered path leaves unseen'`; `'typeable: undefined without a scope, [] when nothing typeable'`; `'captured clears previous dismissals'`.
- [ ] Run — FAIL; implement.

#### Task 2.2: Protocol
**Files:** Modify `src/protocol.ts` (Contracts §Protocol).
**Steps:**
- [ ] Carve-out (type-only): proof is `npm run typecheck`.

#### Task 2.3: Host wiring
**Files:** Modify `electron/main.ts` (per Contracts §Host behaviour), `test/unit/launch-spec.test.ts` only if AC-6's cases are absent.
**Interfaces:** Consumes everything above plus `folders.onFoldersChanged`, `folders.pending`, `buildLaunchSpec`'s `plan.addDir`, `activity.statusOf`.
**Call sites:** `withLastLine` (postState, single use after mf-model S1) → `runtimeFields`; the `term:exit` branch → `endProcessEpisode`; `deliverTimedMessage`.
**Steps:**
- [ ] `scopes = new AgentScopeTracker({ get: (id) => mgr.get(id), exists: (p) => fs.promises.stat(p).then((st) => st.isDirectory(), () => false), onChange: () => postState() })`, constructed after `postState` is defined; `folders.onFoldersChanged((id) => scopes.recompute(id))`; `const addDirsInFlight = new Set<string>()`.
- [ ] Cases `session:addDirsToAgent` (`runAddDirs` with `isAlive: () => gen !== undefined && pty.generation(id) === gen` where `gen = pty.generation(id)` at entry, `sleep = (ms) => new Promise((r) => setTimeout(r, ms))`; reply; failures `log.info('agentScope', reason, {sessionId})`), `session:dismissAgentScope`, `session:restart`, the `relaunch` gate, the refusal-branch status revert, scope capture, `disposeSession`, `deliverTimedMessage` bind.
- [ ] Confirm `test/unit/launch-spec.test.ts` has AC-6's three cases (`homeMissing → home-missing`, `live cwd gone, home present → home`, `both gone → home-missing`) and add an assertion that the `ok` spec's `cwd` is never the injected fallback when home is present; add only what is missing.
- [ ] Carve-out (wiring): proof is Slice 5 plus the slice check.

### Slice 3: "Can't start" and relaunch gating

**Check:** `npx vitest run test/unit/session-icon.test.ts test/unit/palette-state.test.ts test/unit/stale-sessions.test.ts test/unit/attention.test.ts test/unit/session-card.test.ts test/unit/state-vocabulary.test.ts`; `npm run typecheck`.

**Parallel groups:** G1: T3.1 · Serial: T3.2
**Claims (serial lane):** `webview/app.tsx`, `webview/styles.css`

#### Task 3.1: State + predicates
**Files:** Modify `src/session-icon.ts`, `src/palette-state.ts`, `src/stale-sessions.ts`, `test/unit/session-icon.test.ts`, `test/unit/palette-state.test.ts` (`STATES` gains `'cantStart'`, sample `{id, status:'stale', homeMissing:true}`), `test/unit/stale-sessions.test.ts`.
**Interfaces:** Produces `'cantStart'`, `SESSION_STATE_WORD.cantStart`, `SessionStateFields` + `homeMissing`, `canRelaunch`, `relaunchableSessionIds`.
**Steps:**
- [ ] Failing tests (AC-4): `'stale + homeMissing → cantStart'`; `'exited + homeMissing → cantStart'`; `'running + homeMissing → idle/busy as today'`; `'word is "Can\'t start"'`; `'canRelaunch false for stale+homeMissing and exited+homeMissing, true for stale'`; `'relaunchableSessionIds skips homeMissing'`; `'palette tone for cantStart is quiet'`.
- [ ] Update the doc comment's state list in `src/session-icon.ts` (six states, precedence `cantStart` first).
- [ ] Run — FAIL; implement.

#### Task 3.2: Renderer gates + card style
**Files:** Modify `webview/app.tsx` (autoRelaunchStale effect and `relaunchAllStale` → `relaunchableSessionIds`; palette `cmd:relaunchAllStale` shown when `relaunchableSessionIds(sessions).length > 0`, `cmd:closeAllStale` keeps its `staleSessionIds` condition — split the shared `if`; card menu `Relaunch` and palette `cmd:relaunch` → `canRelaunch(s)`), `webview/components/session-card.tsx` (↻ when `session.status === 'stale' && canRelaunch(session)`), `webview/styles.css` (`.session--cantStart` joins the `.session--stale` opacity/hover selectors and mf-sidebar's stale pill selector), `test/unit/session-card.test.ts` (created by mf-sidebar; extend it).
**Steps:**
- [ ] Failing test `'can\'t-start card shows the "Can\'t start" pill and no ↻'` — markup contains `session__state">Can&#x27;t start` (`renderToStaticMarkup` escapes `'`) and `session--cantStart`, and not `session__relaunch`.
- [ ] Run — FAIL; implement.

### Slice 4: Banner and missing-home centre

**Check:** `npx vitest run test/unit/agent-scope-copy.test.ts test/unit/agent-scope-banner.test.ts test/unit/missing-home-state.test.ts test/unit/hover-overlays.test.ts test/unit/state-vocabulary.test.ts test/unit/drag-region.test.ts`; `npm run typecheck`; `npm run fallow:check`.

**Parallel groups:** Serial: T4.1 · G1: T4.2 · G2: T4.3 · Serial: T4.4
**Claims (serial lane):** `webview/components/center-pane.tsx`, `webview/styles.css`

#### Task 4.1: Copy module
**Files:** Create `webview/agent-scope-copy.ts`, `test/unit/agent-scope-copy.test.ts`.
**Interfaces:** Consumes `AgentScopeView`, `AgentScopeReason`, `plural`, `sessionNameFromPath`. Produces everything in Contracts §`webview/agent-scope-copy.ts`.
**Steps:**
- [ ] Failing tests (AC-5, joined segment text): 1 / 2 / 3+ unseen (`"claude can't see a and 2 more folders yet"`); stillSeen only (1 and 2); both (second line); none typeable → actions primary `restart`, no Add; busy → `addDirDisabled`; homeMissing → no Restart, primary never `restart`; `title` lists every full path; toast mapping for all eight reasons.
- [ ] Run — FAIL; implement.

#### Task 4.2: `AgentScopeBanner`
**Files:** Create `webview/components/agent-scope-banner.tsx`, `test/unit/agent-scope-banner.test.ts` (jsdom; `vi.mock('../../webview/host-request')`, `vi.mock('../../webview/terminal-bus')`, `vi.mock('../../webview/toast-store')`).
**Interfaces:** Consumes the copy module, `requestHost`, `post` (`webview/bridge.ts`), `requestTerminalFocus`, `pushToast`, `IconClose`. Produces `AgentScopeBanner`.
**Behaviour:** Run → state `sending`, `requestTerminalFocus(id)`, `requestHost((r) => ({type:'session:addDirsToAgent', sessionId, requestId: r}), ['agentScope:result'], 60000)` → back to `ready`; `ok:false` → `agentScopeToast(reason)` → `pushToast({message, variant:'error'})` when non-null. Restart claude → `confirming`, focus Cancel. Cancel / Esc (keydown on the banner root, `stopPropagation`) → `ready`, focus Restart claude. Restart → `requestHost(... 'session:restart' ..., 10000)`, then `requestTerminalFocus(id)`. × → `post({type:'session:dismissAgentScope', sessionId})`.
**Steps:**
- [ ] Failing tests: `'renders nothing without agentScope'`; `'busy disables Run /add-dir with the busy title'`; `'Run posts addDirsToAgent and focuses the terminal'`; `'busy result → busy toast; inFlight → no toast'`; `'first Restart click shows the confirm and focuses Cancel'`; `'Esc in the banner cancels and focuses Restart claude'`; `'confirm posts session:restart'`; `'× posts dismissAgentScope'`; `'only the message element is role=status'`.
- [ ] Run — FAIL; implement.

#### Task 4.3: `MissingHomeState`
**Files:** Create `webview/components/missing-home-state.tsx`, `test/unit/missing-home-state.test.ts` (jsdom, same mocks).
**Interfaces:** Consumes the copy module, `presentRoots`, `sessionNameFromPath`, `requestHost`, `pushToast`, and mf-files' Locate call. **Locate contract:** use exactly the message, reply and renderer helper `docs/plans/2026-09-23-mf-files.plan.md` §Contracts fixes for `session:locateFolder` (L11). Built assumption to verify: `{type:'session:locateFolder', sessionId, path, requestId}` answered by `session:opResult {requestId, ok, reason?}`, cancel silent, failures toasted by mf-files' mapping. If mf-files sends it from inline code in its Files-tab component, **move** that send + toast mapping into `webview/locate-folder.ts` as `locateFolder(sessionId: string, path: string): Promise<boolean>` and call it from both surfaces — never a second copy.
**Behaviour:** buttons disabled while a request is pending (picker open); Use as home → `requestHost((r) => ({type:'session:setHome', sessionId, path: presentRoots(s)[0], requestId: r}), ['session:opResult'], 10000)`, failure → `useAsHomeFailedToast(name)`; success of either → `onFixed()`. No autofocus.
**Steps:**
- [ ] Failing tests: `'title, full path, Locate…'`; `'Use {first present root} as home shown only with a present root'`; `'missing attached roots are not candidates'`; `'buttons disabled while pending'`; `'setHome failure toasts, success calls onFixed'`; `'Locate success calls onFixed'`.
- [ ] Run — FAIL; implement.

#### Task 4.4: Centre-pane integration + CSS
**Files:** Modify `webview/components/center-pane.tsx`, `webview/styles.css`.
**Steps:**
- [ ] `TerminalPane` gets `key={`${s.id}:${s.restartSeq ?? 0}`}`; `<AgentScopeBanner session={s} />` renders before it inside `.termhost__body`.
- [ ] The `stale` and `exited` blocks render only when `!active.homeMissing`; a third branch `active.status !== 'running' && active.homeMissing` renders `<div className="stale">` containing `<MissingHomeState session={active} onFixed={() => setFocusRelaunchFor(active.id)} />` followed by the same `WaitingLine` the other two blocks render. `focusRelaunchFor: string | null` state; the ↻ Relaunch / ↻ Restart buttons take a ref callback that focuses and clears it when it equals `active.id`.
- [ ] CSS: `.termhost__body { display:flex; flex-direction:column }`; `.termpane-wrap` `height:100%` → `flex:1; min-height:0` (`<TerminalPane` is rendered only in `center-pane.tsx`, measured). `.scope-banner` (flex row, `flex:0 0 auto`, `background: color-mix(in srgb, var(--amber) 14%, var(--term-bg))`, bottom border `color-mix(in srgb, var(--amber) 30%, transparent)`), `__dot` (8px round, `var(--amber)`), `__msg` (`flex:1 1 auto; min-width:0`, wraps up to two lines), `__name` (`var(--font-mono)`, `max-width: 28ch`, ellipsis, inline-block), `__actions` (`flex:0 0 auto`, buttons never shrink), `__close`. `.btn--warn` beside `.btn--danger` (`background: var(--amber); color: var(--on-accent)`, hover `color-mix(in srgb, var(--amber) 85%, var(--text))`) — reuse it if mf-files already added a warn-fill modifier (grep `btn--warn`). `.stale__path` (mono, `user-select:text`, `overflow-wrap:anywhere`, `max-width: min(560px, 90%)`), `.stale__usehome` name ellipsis. Buttons keep borders under `forced-colors`. If `state-vocabulary.test.ts` flags `.btn--warn:hover`, add its allowlist entry `'warn action — amber is the meaning'`, as mf-sidebar did.
- [ ] Carve-out (visual-fidelity): with the real app, compare banner and home state to `.autoloop/handoff/screenshots/12c-edit-folders.png` / `12d-missing-folder.png` in Aero, Neon, light (captures to `%TEMP%\claude-scratch\`, deleted after) — this is QA-1, run at integration when the machine is free.

### Slice 5: Real-app e2e

**Check:** after `npm run build`, `node test/e2e/run-smoke.mjs mf-live-edits` alone; then serially `scrollback-restore`, `scrollback`, `timed-messages`, `exit-closes-session`, `multi-window`, `session-restore-toggle`, `durability`, `terminal-focus`, `cwd`, `multi-folder-model`.

**Parallel groups:** Serial: T5.1 → T5.2
**Claims (serial lane):** `test/e2e/mf-live-edits.e2e.mjs`

#### Task 5.1: Fake claude
**Files:** Create `test/e2e/fixtures/fake-claude.mjs`.
**Steps:**
- [ ] On start print `FAKE-CLAUDE ARGS <JSON argv.slice(2)>` and `FAKE-CLAUDE CWD <process.cwd()>` (`\r\n` endings); `process.stdin.setRawMode(true)`; accumulate chars, on `\r` print `FAKE-CLAUDE GOT <line>`; the line `work` streams one line per 100 ms for 4 s. Never exits on its own.

#### Task 5.2: Scenario
**Files:** Create `test/e2e/mf-live-edits.e2e.mjs`.
**Setup:** temp userData with `agents.json` `[{ id:'fake-claude', label:'claude', command:'<tmp>\\bin\\claude.cmd', args:[], icon:'terminal', color:'green', cwdStrategy:'workspaceFolder' }]`; `claude.cmd` = `@"<process.execPath>" "<REPO>\test\e2e\fixtures\fake-claude.mjs" %*`; home `H`, folders `D with space`, `E` (with `needle.txt`), `F`, `G`, `K`, `P` under a temp dir. `launchApp({ userDataDir })`, `tapBridge`, `openSession(page, {path: H, agentId: 'fake-claude'})`. Output via `window.__capBy[sid]`; host messages via `window.agentDeck.post`; replies via a subscribe tap.
**Steps (one phase each, Gherkin §7):**
- [ ] E1/E4: `session:addRoot` `D with space` → `.scope-banner__msg` text `claude can't see D with space yet` within 1 s; exactly one `FAKE-CLAUDE ARGS`; click Run /add-dir → `FAKE-CLAUDE GOT /add-dir <abs D with space>` (unquoted) and `.scope-banner` gone.
- [ ] E3: `term:input` `work\r`; add E → Run /add-dir `disabled` while streaming; a direct `session:addDirsToAgent` post while busy → `agentScope:result {ok:false, reason:'busy'}` and no `GOT /add-dir` for E; after output stops, click → delivered.
- [ ] E7: add F → banner; click Restart claude → `document.activeElement` is Cancel; click Restart → within 10 s exactly two `ARGS` lines, the second containing `--add-dir` for each of D, E and F; `— session relaunched —` present; banner gone; 3 s later status still `running` and `term:input` `ping\r` → `GOT ping` (R1: the old child's exit tore nothing down).
- [ ] AC-10: add G → banner; × → gone; add K → banner text is exactly `claude can't see K yet`.
- [ ] E2: `openSession` a `shell:cmd` session in H; addRoot → after 1.5 s no `.scope-banner` in its `.termhost`.
- [ ] Live edits: with E attached to the claude session, the Files tab shows E's folder bar and Search finds `needle` under E (selectors copied from mf-files' own e2e); no new `ARGS` line.
- [ ] E5/E6: `closeApp`; set `autoRelaunchStale: true` in `<userData>/settings.json`; rename H → `H.gone`; relaunch; select the claude session's card → pill `Can't start`, `.stale__title` `Home folder not found`, `.stale__path` = H; `Use E as home` visible; 3 s: no `ARGS` for sid and status not `running`; no `spawn` record for sid in the host log (`<tmpdir>\conduit-e2e-logs\conduit-*.log`, JSONL, filtered by `sessionId`; field names per `electron/logger.ts`). Rename back → within 6 s `.stale__title` `Session not running` with ↻ Relaunch; pill `Stale`; still no `ARGS`.
- [ ] Locate: rename H away again, wait for `Home folder not found`; `app.evaluate(() => global.__pickDirHook.queue([P]))`; click Locate… → session `home === P`, the normal block shows with Relaunch focused; click it → `FAKE-CLAUDE CWD P`.
- [ ] `closeApp`; temp dirs left to the OS.

## Verification

- Per task: its `npx vitest run <file>`, red observed first.
- Per slice: the slice check; `npm run typecheck`; `npm run fallow:check` for slices adding exports.
- Integration (only when the machine is free of the other agent's PTY e2e): `npm run verify` (exit
  code read directly, never piped through `tail`), `npm run build`, then Slice 5's list one scenario
  at a time. `git status` shows only planned files.

## Deviation rule

If a task's assumption turns out wrong — an upstream export named above is missing or shaped
differently, a locked signature doesn't fit — that task **stops** and fixing the misaligned piece
becomes the work. Never a shim, second copy, special case, widened type, alias field, fallback, or
an override patched in place of its semantic source. The report leads with the fix that keeps the
locked decision.

## Decisions Needed

- [normal] **`external` scope entries** — dirs outside the session's folders at spawn (a user's own
  `--add-dir`) never appear in `stillSeen`; otherwise every such claude would carry a banner no
  restart can clear. Default taken.
- [normal] **Retire, not keep-in-`procs`** (spec §2.4 mechanics) — the dying child moves to a
  `retired` set so the remount's `term:start` spawns. Default taken.
- [normal] **`Session.restartSeq`** runtime field (host decoration) keys the pane for R2. Default taken.
- [normal] **`requestId` on `addDirsToAgent`/`restart` and their result** — reuses `requestHost`. Default taken.
- [normal] **Refused cold `term:start` sets status `'stale'`** — a relaunch racing the first health
  check otherwise leaves a "running" session with no process; `'exited'` would trigger the
  auto-close of shells. Default taken.
- [normal] **Banner hides Restart while `homeMissing`** — the host would refuse it (§3.3 "the UI never
  offers these"). Default taken.
- [normal] **`cantStart` palette tone `quiet`, card look = stale + word** (spec: reuses the stale glyph). Default taken.
- [normal] **Use-as-home failure toast** `Couldn't make {name} the home folder` — spec names none. Default taken.
- [normal] **Timed delivery bound to the child's generation** — a restart inside the 120 ms gap no
  longer sends the old message's Enter into the new claude; that fire reports not-delivered. Default taken.
- [normal] **Locate contract is mf-files'** — consumed as its plan fixes it; if its send is inline,
  it moves to `webview/locate-folder.ts` (T4.3). Default taken.
- [normal] **ASSUMED:** node's raw-mode stdin works under ConPTY for the `.cmd`-launched fake; if not,
  the fake reads cooked lines and the e2e types `\r` the same way. Verified by T5.2's first phase.
