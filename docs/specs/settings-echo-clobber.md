# settings-echo-clobber (K1)

## Problem (user-visible)

Clicking "collapse sidebar" sometimes flashes: it closes, re-opens, then closes
again. The same class of bug affects every optimistic settings toggle — explorer
collapse, sort, word wrap, panel widths — anything routed through the settings
provider's `update()`.

## Root cause

A three-part race between the renderer's optimistic update and the host's stale
settings echo:

1. **Renderer optimism + debounce** — `webview/settings.tsx` `update()` flips local
   state immediately, then debounces ~250ms before posting `updateSettings` to the
   host. During that window the host's persisted `settings` copy is stale.
2. **Host echoes settings on every broadcast** — `electron/main.ts` `postState()`
   attaches the host's current `settings` to EVERY `state` message. Those fire on
   terminal activity (coalesced ~120ms), a busy/idle sweep (~750ms), and session
   changes — none of which have anything to do with settings.
3. **Renderer hydrates on every state** — `webview/app.tsx` calls `hydrate(msg.settings)`
   on every `state` message; the old `hydrate` wholesale-overwrote local settings.

Timeline: toggle → sidebar closes → an activity broadcast carries the stale
`sidebarCollapsed:false` → `hydrate` re-opens it → the debounce fires and the host
persists → the next echo finally closes it again. "Sometimes" = only when a broadcast
lands inside the 250ms (or in-flight) window.

## Chosen scheme

Fix at the provider (one place), not per-toggle. A small **dirty-epoch gate**
(`src/settings-sync.ts`, pure + unit-tested) decides whether each incoming hydrate is
trusted:

- `onLocalEdit()` marks the gate **dirty** and bumps a monotonic **epoch** on every
  user edit. From that moment, hydrates are stale until our change is confirmed.
- The debounced post (and the unload flush) capture the posted value + epoch in a
  `posted` ref.
- `decideHydrate()`:
  - not dirty → **apply** (host is authoritative at idle; covers initial load too);
  - dirty and a newer edit has happened since the post (epoch moved) → **ignore**;
  - dirty, same epoch, incoming value equals what we posted → this is the host
    **confirming** our change: clear dirty, don't re-set (value already local);
  - dirty, same epoch, value doesn't match → a **stale broadcast** that raced our
    post → **ignore**.

The provider compares the incoming settings to the posted settings via a stable
`JSON.stringify` (the host echoes the full `settings` object it persisted, so the
confirming echo matches exactly in this single-window app).

Why epoch + value-match rather than a fixed settle timer: a fixed timer is a guess and
can still admit a late stale echo or reject a legitimate idle update. Matching the
confirming echo is exact and self-healing — the gate re-opens precisely when the host
has caught up, and any number of stale broadcasts in the window are ignored.

### Unload flush (requirement 2)

`flush()` clears the debounce timer and posts synchronously; it is wired to both
`pagehide` and `beforeunload`. This persists a change-then-quick-quit that the in-flight
debounce would otherwise drop.

### Decision on host-side echo stripping (requirement 3)

**Decided: do NOT strip settings from `postState`.** Evaluated stripping settings from
activity/sweep/session broadcasts so only the initial hydrate carries them. Rejected
because `postState()` is the single shared broadcast path and also serves the `ready`
initial hydrate; stripping it requires a parallel "initial settings" send channel,
adding host-protocol surface and a multi-window assumption for no correctness gain once
the provider gate exists. The gate makes stale echoes harmless regardless of how often
they arrive, so the cheaper, contained, fully-unit-tested provider fix is the
minimal-correct one. (This is a single-window app, so no multi-window sync is lost.)

## Interleavings covered (unit tests)

1. toggle → stale echo arrives mid-window → **no revert** (echo ignored).
2. idle (not dirty) → hydrate **applies** (host authoritative; also the initial-load path).
3. two rapid toggles → first post's confirming-epoch echo does **not** re-open the gate;
   only the latest edit's confirmation clears dirty.
4. echo arriving AFTER settle (gate clean again) → **applies** (authoritative once more).
5. confirming echo (matches posted value, same epoch) → clears dirty, does not re-set.
6. stale echo after post but before confirmation → **ignored**.

## Files

- `src/settings-sync.ts` — new pure gate (makeGate/onLocalEdit/onPostFired/decideHydrate/settle).
- `webview/settings.tsx` — provider wires the gate into `update`/`hydrate`, adds `flush()`
  + unload listeners.
- `test/unit/settings-sync.test.ts` — interleaving tests.
