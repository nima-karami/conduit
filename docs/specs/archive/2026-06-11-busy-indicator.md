# Spec: Busy / needs-attention indicator on session tabs

- **Tier:** FULL
- **Feature type:** UI (+ pure state machine + host wiring)
- **Slug:** busy-indicator
- **Wishlist item:** D5 — "Busy/attention indicator on tabs; done bubbles to top"
- **One-line request:** When a session is actively computing/running a task, show
  that state on its tab (e.g. a spinner/activity dot). When a long task finishes and
  needs your attention, surface it — e.g. the session rises to the top / gets a
  highlight — so while juggling several sessions you can see which one just became
  idle and wants input.
- **Surface:** `src/session-activity.ts` (NEW — pure state machine) ·
  `src/types.ts` (status fields on `Session`) · `electron/main.ts` (output wiring +
  focus + sweep timer) · `src/protocol.ts` (focus message + status on `Session`) ·
  `webview/bridge.ts` (post focus) · `webview/app.tsx` (post focus on select) ·
  `webview/components/sidebar.tsx` (busy/attention rendering + float) ·
  `webview/styles.css` (spinner/attention styles) · `webview/mock.ts` (preview)

## Problem frame

**Job:** When juggling several terminal sessions, a user wants to see at a glance
(1) which sessions are *busy* computing right now, and (2) which background session
just *finished a task and wants input* — so they don't have to click through every
tab to find the one that became idle.

- **Actors:** the person watching the sessions panel; the host (source of truth),
  which observes PTY output and the focused session and computes the runtime status.
- **Success outcomes:**
  - A session that has produced PTY output recently shows a **busy** affordance on
    its tab (animated activity dot / spinner) that coexists with the D4 runtime icon.
  - When a busy session goes **idle** (output stops for the quiescence window) **while
    it is not the focused session**, it gains a **needs-attention** highlight on its
    tab and, when sorting permits, floats toward the top of its group.
  - The **focused** session never gets a needs-attention flag (the user is already
    looking at it), and **focusing/selecting** a flagged session clears its flag.
  - Cost is bounded: per-output-chunk work is O(1) and does not broadcast full state
    on every chunk; busy→idle is detected by a single low-frequency sweep timer.
- **Non-goals:** inspecting the PTY child-process tree or parsing program output to
  know "is Claude thinking" (fragile — we use an output-activity heuristic only);
  persisting busy/attention across reloads (pure runtime state); desktop OS
  notifications / sound; per-session configurable thresholds; reworking D1 sort/filter
  or D4 icon; a literal full reorder that overrides the user's chosen manual order.

## Behavior & states

Two orthogonal runtime status fields are layered on the existing
`status: 'running' | 'exited' | 'stale'` (which is unchanged — lifecycle, not activity):

- **`busy: boolean`** — the session has produced output within the rolling **busy
  window** (default **1500 ms**). While output keeps flowing it stays busy.
- **`needsAttention: boolean`** — set when the session transitions **busy → idle**
  (a task finished: no output for the busy window) **while it is NOT the focused
  session**. Cleared when the user focuses/selects that session, when the session is
  removed, or when it becomes busy again.

**State machine** (pure, `src/session-activity.ts`, time injected):

```
                output (recordOutput)
   idle ───────────────────────────────▶ busy
    ▲                                      │
    │  sweep: now - lastOutputAt >= window │ sweep
    │  AND focused  -> idle (no attention) │
    └──────────────────────────────────────┘
                     │ sweep: window elapsed AND NOT focused
                     ▼
        idle + needsAttention   ──focus()──▶ idle (attention cleared)
```

- `recordOutput(id, now)`: marks the session busy, stamps `lastOutputAt = now`,
  clears `needsAttention` (output means it's working again, not waiting). Returns
  whether the public busy/attention flags changed (so the host can coalesce
  broadcasts — a chunk arriving while already busy changes nothing).
- `sweep(now)`: for each tracked session whose `lastOutputAt` is older than the busy
  window and is currently busy → it goes idle. If it was **not** the focused session
  at that moment, set `needsAttention = true`; if it **was** focused, just go idle.
  Returns whether anything changed.
- `focus(id)`: records the focused id; clears `needsAttention` on the newly-focused
  session. Returns whether anything changed.
- `forget(id)`: drops tracking for a removed session.

**Host wiring (`electron/main.ts`):**
- On every `term:data` from the PTY → `activity.recordOutput(sessionId, now)`. If the
  public flags changed, schedule a coalesced broadcast (see throttle below).
- A single **sweep timer** (`setInterval`, default every **750 ms**, ≤ half the busy
  window so detection latency is bounded) calls `activity.sweep(now)`; if anything
  changed, broadcast state.
- The renderer's active session id is sent to the host via a new
  `focus` message; the host calls `activity.focus(id)` and rebroadcasts on change.
- The session status fields are merged onto each `Session` in the broadcast `state`
  message so the renderer consumes them with no new channel.

**Throttle / coalesce (reuse D3 discipline):** output chunks can arrive hundreds per
second. We never broadcast per chunk. Instead:
- `recordOutput` returns "changed?"; only an *idle→busy* edge is a change, so the
  common case (already busy) does nothing.
- Broadcasts are coalesced through a trailing-edge timer (default **120 ms**): the
  first change arms a timer; further changes within the window are absorbed; the
  timer fires one `postState`. The sweep's busy→idle change goes through the same
  coalescer. This bounds IPC to ≲ 8 state messages/sec even under a firehose of output.

**Renderer (`webview/components/sidebar.tsx`):**
- The existing leading `.dot` animates (pulse) when `session.busy` — composing with,
  not replacing, the D4 `SessionGlyph` runtime icon that follows it.
- A `needsAttention` session gets a `session--attention` class → a left accent bar +
  soft glow + a small "ready" pip, so it stands out among idle siblings.
- **Float, not destructive reorder:** within each render group, needs-attention
  sessions are stably hoisted to the top of that group **only when the active sort is
  not `manual`** (i.e. the order is already derived, not user-owned). Under `manual`
  sort the user's explicit order is preserved untouched and attention is shown by the
  highlight alone. This keeps D1/D2/D3 ordering intact (see Decisions Needed).
- Selecting a session posts `focus` to the host (clears attention) in addition to the
  existing local `setActiveId`.

## Data / interface contract

```ts
interface Session {
  // …existing… status / createdAt / lastActiveAt unchanged
  busy?: boolean;           // produced output within the busy window (runtime, NEW)
  needsAttention?: boolean; // finished a task while unfocused (runtime, NEW)
}
```

```ts
// src/session-activity.ts — pure, no Electron/DOM imports
interface ActivityOptions { busyWindowMs?: number; now?: () => number }
class SessionActivity {
  recordOutput(id: string, now: number): boolean; // returns flagsChanged
  sweep(now: number): boolean;                     // returns anyChanged
  focus(id: string | undefined): boolean;          // returns changed
  forget(id: string): void;
  statusOf(id: string): { busy: boolean; needsAttention: boolean };
  apply(sessions: Session[]): Session[]; // returns sessions w/ busy+needsAttention merged
}
```

- New protocol message `{ type: 'focus'; id: string }` (webview → host).
- Status is transported by merging `busy` / `needsAttention` onto the `Session`
  objects already in the `state` message — **no new host→webview message type**.
- Both flags are optional and default to `false`/absent (back-compat: persisted and
  preview sessions without them render exactly as today).

## Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Output firehose (per-chunk) | `recordOutput` is O(1); only the idle→busy edge is a change; broadcasts coalesced via 120 ms trailing timer. No per-chunk IPC. |
| Busy session is the focused one when it goes idle | Goes idle, **no** needsAttention (user is watching it). |
| Session finishes while unfocused, user never looks | Stays `needsAttention` (highlight + float) until focused, removed, or busy again. |
| Focus a flagged session | `focus()` clears its `needsAttention`; rebroadcast. |
| Session removed / killed | `forget(id)` drops it from the activity map; no stale flags leak. |
| `term:exit` (process ends) | Exit is a lifecycle change; status becomes `exited`. Any pending attention is harmless; idle/exit reads as not-busy. Sweep won't resurrect busy (no new output). |
| Two+ sessions flagged at once | Each independently flagged; all float within their group (stable order among themselves preserved). |
| Sort = `manual` | Attention shown by highlight only; **no** reorder (user order preserved). |
| `window.agentDeck` undefined (preview) | No host bridge / no real PTY; mock supplies `busy`/`needsAttention` directly so the renderer states are exercised. Posting `focus` is a no-op in the mock. |
| Reload | Flags are not persisted; sessions restore as `stale`, both flags absent → no spurious highlight. |

## Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Busy window (quiescence) | 1500 ms | No (constant) | Long enough to bridge gaps between output bursts, short enough that "finished" is felt quickly. Runtime tuning is not a durable user preference. |
| Sweep interval | 750 ms | No | ≤ ½ the busy window bounds detection latency; cheap. |
| Broadcast coalesce window | 120 ms | No | Caps IPC ≲ 8 msgs/sec while staying visually instant. |
| Float attention to top | Only when sort ≠ `manual` | No | Non-destructive to the user's chosen manual order; highlight alone suffices there. |
| Busy/attention persistence | Off (runtime only) | No | It's ephemeral process state; persisting it would surface stale flags after reload. |

## Scope slicing

- **MVP:** pure `SessionActivity` state machine (busy window + sweep + focus +
  attention); host wires output→record, sweep timer, focus message, coalesced
  broadcast; `Session` carries `busy`/`needsAttention`; sidebar shows animated busy
  dot + attention highlight; select posts focus; mock exercises both states.
- **v1 / later:** float-to-top of attention sessions in derived sorts (included as
  MVP since it's cheap); optional setting to disable the float; per-session "muted".
- **Vision / out of scope:** OS notifications / sound; smarter "is the agent waiting
  for input" detection via output parsing; configurable thresholds; manual-sort float.

## Acceptance criteria

**Declarative:**
- AC1: `recordOutput(a, t)` makes `statusOf(a).busy === true`.
- AC2: after `recordOutput(a, t0)` then `sweep(t0 + window)` with `a` unfocused →
  `busy === false`, `needsAttention === true`.
- AC3: after `recordOutput(a, t0)`, `focus(a)`, then `sweep(t0 + window)` →
  `busy === false`, `needsAttention === false` (finished while focused → no flag).
- AC4: a flagged session: `focus(a)` → `needsAttention === false`.
- AC5: `recordOutput` while already busy returns `false` (no change → no broadcast).
- AC6: `recordOutput` on a flagged session clears `needsAttention` (it's working again).
- AC7: `sweep` before the window elapses returns `false` and keeps `busy === true`.
- AC8: `forget(a)` then `statusOf(a)` → both flags `false` (untracked).
- AC9: `apply(sessions)` returns sessions with `busy`/`needsAttention` merged; sessions
  not tracked are returned unchanged (flags absent/false).

**EARS:**
- When a session produces output, the system shall mark that session busy and clear
  any pending needs-attention on it.
- While a session has produced no output for the busy window and is not the focused
  session, the system shall mark it not-busy and needs-attention.
- While a session that goes idle is the focused session, the system shall mark it
  not-busy and shall not set needs-attention.
- When the user focuses a session, the system shall clear that session's
  needs-attention flag.
- When a session is removed, the system shall stop tracking its activity.

**Gherkin:**
```
Scenario: Background task finishes and asks for attention
  Given session B is busy and session A is focused
  When B produces no output for the busy window
  Then B is not busy and B needs attention
  And B floats above idle siblings when sort is not manual

Scenario: Focusing clears the attention flag
  Given session B needs attention
  When the user selects B
  Then B no longer needs attention
```

## UI module (feature type = UI)

**State catalog:**

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Session tab dot | busy | leading dot pulses (animated) atop normal status color | — (informational) |
| Session tab dot | idle | static status dot (today's behavior) | — |
| Session tab | needsAttention | left accent bar + soft glow + "ready" pip; floats up in derived sorts | click/select clears it |
| Session tab | busy + attention | mutually exclusive by construction (busy clears attention) | — |
| Runtime icon (D4) | all | unchanged `SessionGlyph` still shown beside the dot | — |

**Interaction inventory:**

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Session tab | select (clears attention) | click | existing tab focus/select | tap | existing session menu (unchanged) | dot/highlight are presentational; tab keeps its existing role |

**Accessibility & i18n:**
- Busy/attention are conveyed by animation + color **plus** position (float) — not by
  color alone; the attention pip adds a non-color shape cue. The busy pulse respects
  `prefers-reduced-motion` / the app's `reduceMotion` setting (no animation → the dot
  shows a steady "busy" tint instead of pulsing), reusing the existing motion guard.
- No new interactive control is introduced, so no new focus order / ARIA wiring;
  attention does not steal focus.
- Strings: a `title`/`aria-label` like "Busy" / "Finished — needs attention" on the
  indicator is English, consistent with the rest of the app (no i18n layer present) —
  flagged below.

**Design tokens:**
- Reuse existing semantic vars: `--accent` / `--accent-soft` for the attention
  highlight (matching `.session--active`), `--green` family for the busy pulse, the
  existing `.dot` sizing. No raw hex; a `@keyframes` pulse added next to existing ones.

## Decisions Needed

- (normal) **Busy = recent PTY output**, not process-tree inspection. Cheap, robust,
  reversible; matches the approach mandated by the wishlist note. Continuing.
- (normal) **Float only in non-manual sorts.** Avoids clobbering the user's explicit
  manual order (D2/reorder). Highlight alone communicates attention under manual sort.
  Reversible (could add a setting). Continuing.
- (normal) **Thresholds are constants** (1500 / 750 / 120 ms), not settings — runtime
  tuning isn't a durable preference. Reversible. Continuing.
- (normal) **English-only** indicator labels — matches the app (no i18n framework).
  Not a regression.

## Self-audit

All core-spine sections and the UI-module checklist are addressed (state catalog,
interaction inventory, a11y incl. reduced-motion + non-color cue, i18n, tokens). No
in-scope items deferred. No `high`-severity decisions.

---

SPEC: docs/specs/busy-indicator.md
TIER: FULL
DECISIONS_NEEDED: 4 (highest: normal)
