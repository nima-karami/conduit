# Spec: Better session naming + richer metadata (last-active)

- **Tier:** FULL
- **Feature type:** UI (+ pure model + host wiring)
- **Slug:** session-meta
- **Wishlist item:** D3 — "Better session naming + richer metadata (last-updated)"
- **Surface:** `src/types.ts` (model) · `src/session-manager.ts` (pure model) ·
  `src/persistence.ts` (back-compat restore) · `src/settings.ts` (sort enum +
  card field) · `electron/main.ts` (activity wiring) · `webview/card-fields.ts` +
  `webview/components/sidebar.tsx` (tab surface + sort) · `webview/mock.ts` (preview)

## Problem frame

**Job:** When juggling several terminal sessions, a user wants to identify a session
by the project it belongs to (not the shell binary) and to tell at a glance how
recently it was active — so a freshly-touched session reads clearly and can sort to
the top.

- **Actors:** the person managing sessions in the renderer; secondarily the host,
  which is the source of truth for the session model and stamps activity.
- **Success outcomes:**
  - New sessions auto-name **repo-first** — `"<folder> — <agent>"` — instead of the
    current agent-first `"<agent> — <folder>"`, so the project leads.
  - User-renamed sessions are **never** overwritten by the default-naming change.
  - Each session carries `createdAt` (already present) **and** `lastActiveAt` (new),
    both epoch-ms. `createdAt` stamps on creation; `lastActiveAt` stamps on creation
    and bumps on meaningful activity.
  - The session tab/card can show a compact **relative last-active** time, reusing
    the shared `webview/relative-time.ts` `relativeTime()` helper.
  - Sessions can sort by **recently active** (a new sort key) alongside the existing
    sort options.
  - Sessions persisted before this change (missing `lastActiveAt`) load gracefully.
- **Non-goals:** absolute timestamps / date pickers; per-event activity history;
  refining *what counts as activity* beyond a cheap host signal (D5 refines this with
  a real busy indicator); the three-dot sort/filter menu restyle (D1); runtime
  icon (D4); migrating/backfilling the user's real `sessions.json` (back-compat is
  read-tolerant, not a migration).

## Behavior & states

**Naming (`create`):**
- No explicit `name` passed → default = `"<basename(projectPath)> — <agent label>"`.
  Example: agent "Claude" in `/work/proj` → `"proj — Claude"`.
- Explicit `name` passed (e.g. a user rename, or `duplicate`'s `"… (copy)"`) → used
  verbatim. `rename()` continues to set a custom title that no later default touches.

**Timestamps:**
- `create`: `createdAt = lastActiveAt = now()` (`now` injected for tests).
- Activity bump (`touch(id)`): sets `lastActiveAt = now()` and emits a change so the
  UI + persistence update. No-op for unknown ids.
- **Activity definition for D3 (cheap + sensible):** a session is "active" when its
  terminal starts (`term:start`) or receives user input (`term:input`) on the host.
  Output-driven / busy-state activity is explicitly deferred to D5.

**Restore (back-compat):**
- Persisted sessions missing `lastActiveAt` default it to their `createdAt` (or to
  `now` if `createdAt` is also absent). Missing `createdAt` defaults to `now`.
- Restored sessions remain marked `stale` (unchanged behavior).

## Data / interface contract

```ts
interface Session {
  // …existing…
  createdAt: number;     // epoch ms, set on creation
  lastActiveAt: number;  // epoch ms, set on creation, bumped on activity (NEW)
}
```

- `SessionManager` gains an injected `now: () => number` (default `Date.now`) so
  stamping is deterministic in tests.
- `SessionManager.touch(id: string): void` — bump `lastActiveAt`; emit on success.
- `restoreSessions(blob)` and `SessionManager.restore(sessions)` tolerate sessions
  without `lastActiveAt`/`createdAt` (default as above).
- `SessionSort` gains `'active'` (label "Recently active"); sorts by
  `lastActiveAt` descending.
- `CardField` gains `'active'` (label "Last active"); renders `relativeTime(lastActiveAt)`.

## Edge cases & failure modes

- **Missing timestamps in the UI:** `relativeTime(undefined)` must not crash — the
  card field guards a missing/NaN `lastActiveAt` and renders `''` (nothing) rather
  than "NaNd ago".
- **Back-compat load:** old `sessions.json` with only `createdAt` → `lastActiveAt`
  backfilled to `createdAt` at restore so sorting/relative-time work immediately.
- **Duplicate:** the copy is a fresh `create`, so it gets new `createdAt`/`lastActiveAt`
  (a duplicate is a new session) and the explicit `"… (copy)"` name.
- **Sort stability:** ties on `lastActiveAt` fall back to name compare (consistent
  with the other sort keys).
- **`window.agentDeck` undefined (preview):** no host bridge; the fake shell never
  calls `touch`, but mock sessions carry `lastActiveAt`, so naming/relative-time/sort
  all render from mock data. Guarded already by the existing bridge fallback.

## Defaults vs. settings

- **Default name scheme** `"<folder> — <agent>"` — not a setting (a durable scheme,
  not a per-user preference). Rationale: the wishlist asks for one cleaner default.
- **`sessionSort`** already a persisted setting; `'active'` is a new allowed value.
  Default sort stays `'manual'` (unchanged).
- **Card fields** already persisted (`cardTitle/Subtitle/Detail`); `'active'` is a
  new allowed value. Defaults unchanged (D1 may later surface last-active by default).

## Scope slicing

- **MVP:** repo-first default name; `lastActiveAt` on the model, stamped on create +
  `touch`; host calls `touch` on `term:start`/`term:input`; back-compat restore; new
  `'active'` sort key; new `'active'` card field; mock updated. Tab can show last-active.
- **v1 / later:** D1 surfaces the new sort in the three-dot menu and may default a
  card role to last-active; D5 refines activity to true busy/idle output detection.
- **Out of scope:** absolute dates, history, icon (D4), busy indicator (D5),
  sessions.json migration.

## Acceptance criteria

**Declarative:**
- AC1: `create('claude', '/work/proj')` → `name === 'proj — Claude'`.
- AC2: `create(..., 'My Name')` → `name === 'My Name'` (explicit preserved); after
  `rename(id, 'X')`, name is `'X'` and stays `'X'`.
- AC3: `create` with injected `now=1000` → `createdAt === 1000 && lastActiveAt === 1000`.
- AC4: `touch(id)` with injected `now=2000` → `lastActiveAt === 2000`, `createdAt`
  unchanged; unknown id is a no-op (no throw, no emit).
- AC5: `restore([{…createdAt:5, no lastActiveAt}])` → loaded session has
  `lastActiveAt === 5`, `status === 'stale'`.
- AC6: sort `'active'` orders sessions by `lastActiveAt` descending.

**EARS:**
- When a session is created without an explicit name, the system shall name it
  `"<folder basename> — <agent label>"`.
- When a session is created, the system shall set `createdAt` and `lastActiveAt` to
  the current time.
- When `touch` is called with a known id, the system shall set that session's
  `lastActiveAt` to the current time and notify listeners.
- While restoring a persisted session that lacks `lastActiveAt`, the system shall
  default `lastActiveAt` to that session's `createdAt`.

**Gherkin:**
```
Scenario: Recently-active session sorts first
  Given sessions A (lastActiveAt older) and B (lastActiveAt newer)
  When the sessions are sorted by "Recently active"
  Then B appears before A
```

## UI module (feature type = UI)

- **State catalog:** the tab renders the same in all session statuses
  (running/stale/exited); last-active is an extra text field, status dot unchanged.
- **Interaction inventory:** the new sort option appears in the existing
  `<select>` sort control (D1 will restyle it). No new click targets on the tab.
- **Accessibility:** the relative-time text is plain text inside the existing card
  body; no new interactive control, so no new focus/ARIA surface. The sort `<select>`
  already carries a `title`; the new option is a labelled `<option>`.
- **i18n:** strings ("Recently active", "Last active") are hard-coded English,
  consistent with the rest of the app (no i18n framework present) — flagged below.
- **Design tokens:** reuse existing card field styling (same class as the "time"
  field); no new colors/spacing introduced.

## Decisions Needed

- (normal) **Activity = term start/input** for D3, not output. Conservative + cheap;
  D5 owns true busy detection. Picked the reversible default; continuing.
- (normal) **Name scheme `"<folder> — <agent>"`** (em-dash, folder first) rather than
  folder-only. Keeps the agent visible until D4's runtime icon lands; reversible.
- (normal) **English-only strings** — matches the existing app (no i18n layer); not a
  regression.

## Self-audit

All core-spine sections and the UI module checklist are addressed. No items deferred
within scope. No `high`-severity decisions.

---

SPEC: docs/specs/session-meta.md
TIER: FULL
DECISIONS_NEEDED: 3 (highest: normal)
