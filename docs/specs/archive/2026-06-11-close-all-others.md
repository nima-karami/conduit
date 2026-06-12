# Spec — "Close all sessions" + "Close others" (J4)

## Context

Closing sessions one at a time is tedious when many are open. Users want to clear
the deck (close everything) or focus on one (close everything else). The single
session-close path already exists — right-click a session in the Sessions sidebar →
**Close**, which posts `{ type: 'kill', id }` to the host. The host
(`electron/main.ts`) handles `kill` by `pty.dispose(id)` → `SessionManager.remove(id)`
→ `activity.forget(id)`, then re-broadcasts `state` with the smaller session list.
J3 hardened the transition-to-zero so closing the **last** session returns to the
initial start state (editor empty state) instead of a black/empty page.

This feature adds two **bulk** close actions on top of that same path.

## Behavior

### Where the actions appear

- **Session context menu** (right-click a session in the Sessions sidebar) — the
  former single "Close session" item is now three items at the foot of the menu,
  all `danger`-styled:
  - **Close** — the existing single close (kills just that session).
  - **Close others** — closes every session **except** the one right-clicked.
    Disabled when it's the only session (nothing else to close).
  - **Close all** — closes **every** session.
- **Sessions panel three-dot menu** ("Sort & filter sessions" overflow) — a single
  **Close all sessions** item at the foot, `danger`-styled, separated from the
  sort/group section. Disabled when there are no sessions. "Close others" is not
  offered here — it needs a specific target, which the panel menu has none.

### How the close is performed

Pure selection logic lives in `webview/bulk-close.ts` (no React/DOM/host dependency,
unit-tested):

```ts
closeAllIds(ids)            // -> [...ids]            (all sessions)
closeOthersIds(ids, target) // -> ids.filter(id => id !== target)
```

`app.tsx` builds the id list from the current `sessions`, then a single
`closeSessions(ids, …)` helper iterates and posts `{ type: 'kill', id }` per id —
**reusing the existing single-close path**, so each session is torn down properly
(`pty.dispose` + `mgr.remove` + `activity.forget`) and never bypassed. The host
re-broadcasts a smaller `state` after each removal; the renderer reflects host
state. When the list empties, J3's `nextCenterView` falls the center view back to
the editor start state — so **Close all does not black-screen**.

`post` is bridge-guarded: in the browser preview (`window.agentDeck` absent) it
routes to the mock host, which now handles `kill` by dropping the session and
re-emitting the smaller list — so the preview exercises the same flow.

## Confirm decision

**Reuse the existing `confirmCloseRunning` setting; do not add a new always-on
confirm.** Single-close confirms only when `confirmCloseRunning` is on **and** the
session is running. For the bulk actions, `closeSessions` confirms **once** (not
per-session) if the setting is on and **any** of the targeted sessions is running;
otherwise it closes immediately. This keeps behavior consistent with single-close:
a user who has disabled the running-close confirm gets no prompt here either, and
one who has it on gets a single summary prompt ("Close all 3 sessions? Running
terminals will be terminated."). All three bulk items are visually `danger`-styled
regardless, since they're destructive.

## Acceptance criteria

- [x] Session context menu shows **Close**, **Close others**, **Close all**, all
      `danger`-styled. "Close others" is disabled when it's the only session.
- [x] Three-dot panel menu shows **Close all sessions** (`danger`), disabled with
      zero sessions.
- [x] "Close others" closes every session except the target; the target stays open.
- [x] "Close all" closes every session and lands on the initial start state
      (editor empty + "No sessions yet"), **not** a black/empty page.
- [x] Bulk close iterates the existing single-close `kill` path — no bypass of the
      pty dispose / `SessionManager.remove` teardown.
- [x] Pure selection logic (`closeAllIds`, `closeOthersIds`) unit-tested
      (`test/unit/bulk-close.test.ts`): close-others excludes target, close-all
      returns all, empty list, single session, target-not-present.
- [x] `npm run verify` and `npm run build` both green.
- [x] Runtime verified via Playwright preview: context menu items present; Close
      others → only target remains; Close all → start state (sessions 0,
      `centerEmpty`/`sidebarEmpty` true, root rendered, body bg `var(--bg)`, no
      app console errors); panel menu "Close all sessions" present + functional.

## Manual confirmation (real Electron app)

The preview's mock host fakes the `kill` round-trip (drop + re-emit). The real
host kill path (`pty.dispose` → `mgr.remove` → `activity.forget` → state
re-broadcast) is identical per id but can't run in the browser preview. A final
manual check in the packaged app — open several real sessions, then Close
others / Close all — confirms the real pty teardown and the no-black-screen
behavior end-to-end (the J3 dispose guard + error boundary already cover the
WebGL teardown crash on GPU-less machines).
