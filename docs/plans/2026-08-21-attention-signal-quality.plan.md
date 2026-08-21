# Attention Signal Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Needs you" arms only on real evidence — a qualifying run ending, or a bare BEL — once per episode, never for a session the user can see, never on spawn banners or exited sessions.

**Architecture:** The decision stays in main, in a rewritten pure state machine (`src/session-activity.ts`) that consumes three new inputs (byte counts, bare-bell counts, per-window visible-session sets) alongside timestamps. An OSC-aware bell scanner joins `stripAnsi` in `src/last-line.ts`. The renderer's only change is reporting *visible* ids (active + split) instead of a single focus id. Busy/idle semantics for the Busy meter are unchanged.

**Tech Stack:** TypeScript, Electron main, vitest, Playwright-Electron e2e (`test/e2e/harness.mjs`).

**Spec:** `docs/specs/2026-08-21-attention-signal-quality.md` — the contract and the behavioral acceptance matrix live there; every task below implements a numbered contract item. The 2026-08-21 investigation's file:line map is reproduced inline where needed (line numbers are anchors — re-locate by symbol).

## Global Constraints

- `npm run verify` fully green; never weaken/narrow/disable a gate. **Deliberate contract changes to existing attention tests are expected** (the old tests pin the buggy behavior — e.g. a trivial short burst arming attention). Rewriting them to the spec's matrix is the task, not gate-gaming; keep the busy-meter assertions intact and say in the commit message which assertions changed contract.
- Comments WHY-only, link the spec. Two tsconfigs. No control chars in regexes (biome error) — the bell scanner is a character walk like `stripAnsi`, not a regex.
- E2E strictly serial; PTY-ish failures re-run ALONE before believing. Never kill processes by name.

---

### Task 1: OSC-aware bare-bell scanner

**Files:**
- Modify: `src/last-line.ts` (beside `stripAnsi`, which already walks OSC/DCS strings — reuse its state discipline; note `\x07` legitimately terminates OSC there)
- Test: `test/unit/bell-scan.test.ts` (new)

**Interfaces:**
- Produces: `export function countBareBells(chunk: string): number` — BELs that are NOT terminating an OSC/DCS/APC/PM/SOS string. Also handles `ESC \` (ST) termination and a chunk that both contains bells and titles.

- [ ] Write failing tests: `countBareBells('\x07') === 1`; `countBareBells('\x1b]0;title\x07') === 0`; `countBareBells('\x1b]0;t\x07\x07') === 1`; `countBareBells('a\x07b\x1b]2;x\x1b\\\x07') === 2`; `countBareBells('') === 0`; a DCS case `\x1bPq...\x1b\\` containing `\x07`... check real DCS semantics: inside DCS, BEL does not terminate (only ST) — decide from `stripAnsi`'s existing handling and mirror it; assert consistency with whatever `stripAnsi` does.
- [ ] Run to verify failure → implement as a small state walk (share/extract `stripAnsi`'s string-state logic if a clean refactor is ≤ trivial; otherwise a sibling walker) → tests green.
- [ ] Commit: `feat(terminal): OSC-aware bare-bell detection`

### Task 2: `SessionActivity` rewrite — runs, episodes, visible sets

**Files:**
- Rewrite: `src/session-activity.ts`
- Rewrite: `test/unit/session-activity.test.ts` (keep busy-meter cases AC-for-AC; replace attention cases with the new contract)

**Interfaces (later tasks + main rely on these exact shapes):**
```ts
export const MIN_RUN_MS = 2000;
export const MIN_RUN_BYTES = 1024;
export const ATTENTION_QUIET_MS = 4000;
export const SPAWN_GRACE_MS = 5000;

export interface ActivitySnapshot { busy: boolean; needsAttention: boolean; completedRun: boolean; }
export interface AttentionEdge { id: string; kind: 'run-end' | 'bell'; }

export class SessionActivity {
  constructor(opts?: { busyWindowMs?: number; minRunMs?: number; minRunBytes?: number; attentionQuietMs?: number; spawnGraceMs?: number });
  recordOutput(id: string, at: number, bytes: number, bareBells: number): void;
  recordSpawn(id: string, at: number): void;      // pty.start — starts grace, resets run/episode
  recordExit(id: string): void;                   // term:exit — clears in-flight state; no arming after
  setVisible(windowId: number, ids: readonly string[]): void;
  dropWindow(windowId: number): void;
  focusHint(id: string): void;                    // kept if anything else calls focus(); acknowledgment now flows from visibility — remove focus() if nothing else uses it
  forget(id: string): void;
  sweep(now: number): AttentionEdge[];            // arms per contract; returns NEW edges (for flash/notification)
  snapshot(id: string): ActivitySnapshot;         // or however main reads state today — preserve the existing read API shape used by the broadcast at electron/main.ts:1116-1163 and session-icon derivation
}
```
Semantics (spec contract 1–6): a run accumulates from first output post-idle/post-ack (duration = lastOutputAt − runStartAt; bytes summed). `sweep` arms `needsAttention` when: running, past grace, not visible in ANY window's set, quiet ≥ attentionQuietMs, and (run qualified OR pending bell). A bare bell sets a pending-bell flag → next sweep arms immediately regardless of quiet (still never for visible sessions — a bell on a watched session is already seen; it IS cleared by that visibility). Arming emits the edge ONCE (episode latch); visibility of that session (in any set) acknowledges: clears `needsAttention`, ends the episode, resets run accumulation. After acknowledgment, output re-accumulates a fresh run; non-qualifying dribble never arms. Busy flag: unchanged 1500 ms semantics.

- [ ] Write the new test matrix first (every spec acceptance row as a pure-machine case, plus: two-window visible sets both exempt; `dropWindow` un-exempts; exit-then-quiet no edge; bell-while-visible no edge; grace expiry then qualifying run arms; byte-qualification path with a fast 2 KiB burst under 2 s; constants exported).
- [ ] Verify the matrix fails against the old machine → implement → green, plus the preserved busy-meter cases.
- [ ] Commit: `feat(attention): evidence-gated arming — qualifying runs, episodes, visible sets, bell`

### Task 3: Main-process wiring + protocol

**Files:**
- Modify: `electron/main.ts` — (a) `recordOutput` call site (~:1018-1021): pass `chunk.length` + `countBareBells(chunk)`; (b) `pty.start` cold+relaunch path (~:2366): `recordSpawn`; (c) `term:exit` handling (~:1062-1072): `recordExit`; (d) sweep loop (~:1116-1163): consume `AttentionEdge[]` for flashFrame/Notification (keep `shouldRaiseOsAttention` gating exactly); DELETE the `osNotified` set (~:1106-1112, :1133, :1988, :1618) — the episode latch subsumes it; (e) replace the `'focus'` case (~:1985-1990) with a `'visible'` case: `activity.setVisible(windowIdOf(sender), m.ids)` — derive the window from the sender webContents (the `windows` map / `sessionOwner` machinery already keys windows; find the existing sender→window resolution used by other handlers); (f) window `'closed'` handler (~:772-775): `activity.dropWindow(w.id)`.
- Modify: `src/protocol.ts` — replace `{type:'focus'; id}` with `{type:'visible'; ids: string[]}` in the webview→host union (grep `'focus'` for every producer/consumer first; if anything else rides the focus message — e.g. the osNotified clear — account for it).
- Modify: `webview/bridge.ts` fake shell if it touches 'focus' (grep; update to 'visible' no-op).

- [ ] Wire, typecheck both configs, fix all fallout honestly (no casts).
- [ ] Commit: `feat(attention): wire bell/bytes/spawn/exit/visible-set signals through main`

### Task 4: Renderer visible-ids reporting

**Files:**
- Modify: `webview/app.tsx` (~:755-757 — the effect that posts `focus` on activeId change): post `{type:'visible', ids}` where ids = active session id + any split session id, on change of either. Find where `splitId` lives (`center-pane.tsx` ~:214-248 renders the split; the state's owner is likely app.tsx or center-pane props — report visibility from the OWNER of both values so there's one producer).
- Verify snooze (`webview/use-snooze.ts`) and card/chip surfaces need no change (they read the same broadcast flags).

- [ ] Implement + unit-test any extracted pure helper (e.g. `visibleIds(activeId, splitId): string[]` — dedupe, drop null).
- [ ] Commit: `feat(attention): report visible sessions (active + split) instead of a focus id`

### Task 5: E2E matrix + docs

**Files:**
- Create: `test/e2e/attention-signal.e2e.mjs` — scripted PTY children (node one-liners writing byte patterns with sleeps) driving the REAL app hidden; assert badge state via the session-card DOM / broadcast state, per the spec's acceptance matrix rows that don't need OS focus: spinner-forever (no badge), qualifying-run-then-quiet (badge once; second cycle no re-fire), ack-then-dribble (no re-arm), bare BEL (immediate), OSC-title-BEL (nothing), spawn banner (nothing), split-visible (no badge).
- Modify: `test/e2e/attention.e2e.mjs` — keep it the OS-surface scenario (flash/notification, needs real focusable window): update its "finish" stimulus to a QUALIFYING run (burst ≥ MIN_RUN_BYTES or ≥2 s) so it tests the new contract; its once-per-two-cycles assertion should now hold via the episode latch (stronger: assert no second flash even after re-focus + blur without a new qualifying run).
- Docs: INDEX row for the spec; CHANGELOG `[Unreleased]` → Fixed ("'Needs you' no longer pings for sessions with nothing to show — ...") in user-facing language.

- [ ] Red proof: run `attention-signal` against the PRE-fix build (stash the src+electron changes, rebuild): the spinner-forever and ack-then-dribble legs must FAIL (old code arms). Capture both runs.
- [ ] Serial regression: `attention`, `scrollback-mode-neutralize`, `renderer-crash-recover`, `exit-closes-session`, `terminal-focus` — one at a time; re-run any failure alone.
- [ ] Full `npm run verify` in the worktree, unfiltered, captured.
- [ ] Commit: `test(attention): e2e signal matrix + contract update for OS surfaces`

## Self-review notes (applied)

- Spec contract 1→Task 2 (runs), 2→Tasks 1+2+3 (bell), 3→Task 2 (latch) + Task 3 (osNotified removal), 4→Tasks 2+3+4 (visible sets), 5→Tasks 2+3 (grace), 6→Tasks 2+3 (exit). Acceptance matrix→Task 5. No gaps.
- Names cross-checked: `countBareBells`, `setVisible`/`dropWindow`, `recordSpawn`/`recordExit`, `AttentionEdge`, constants.
- Known judgment point for the builder: if `focus()` has callers beyond attention (grep first), keep a shim rather than breaking them; note it in the report.
