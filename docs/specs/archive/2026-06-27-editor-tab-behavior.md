---
status: draft
date: 2026-06-27
---

# Feature Spec: VS Code–style editor tab open + persistence

**Tier:** FULL   **Feature type:** UI
**One-line request:** "The new editor tab opening behavior and its persistence should be like VS Code, feature-spec this fully"

> Autonomous spec. Every ambiguity that could change the build is recorded in
> **§13 Decisions Needed** (severity-tagged), never asked. Read that section first.

---

## 0. Current-state survey (grounding — what already exists)

The build target is **an extension of machinery that already exists for one doc
kind**, not a greenfield feature. Faithful facts about the code as of this spec:

- **Doc/tab model** lives in `webview/docs.ts` (`OpenDoc`, `DocsState`, `docsReducer`)
  and is held in `webview/app.tsx` as a `useReducer` (`docState`, line ~136). Tabs
  render via `webview/components/center-pane.tsx` → `webview/components/doc-tabs.tsx`.
- **Preview/pin ALREADY exists — but only for `commit-diff` docs** (history-originated
  file diffs). Evidence: `OpenDoc.preview?: boolean`; the `@preview` sentinel id
  (`previewId`), `openHistoryDoc`, the `openCommitFile`/`pinDoc` reducer actions;
  `doc-tabs.tsx` `onDoubleClick → onPinDoc` and the `tab--preview` class; the
  `.tab--preview > span { font-style: italic }` token in `webview/styles.css:1382`.
- **Regular file docs DO NOT use preview today.** Every file open funnels through
  `openFile` (`app.tsx:894`), which dispatches `{ type: 'open', kind: 'file' }`. That
  reducer branch (`docs.ts:162`) *always* creates a permanent tab (no `preview`
  flag), and de-dupes by `id = "file:<path>"` (re-opening focuses + transfers
  ownership). So a single click and an "open for good" are indistinguishable today —
  there is no preview tab and no replace-in-place for files.
- **Explorer interaction:** a file row's `onClick` calls `toggle(node)` which calls
  `onOpenFile` (`right-pane.tsx:983`). **There is no double-click handler in the
  explorer today** — single-click is the only open gesture.
- **File-open entry points (all → `openFile`, all currently permanent):**
  1. Explorer single-click (`right-pane.tsx` `toggle` → `onOpenFile`).
  2. Terminal path link (`onOpenFileAt` → `openTerminalFileLink` → `openFile`).
  3. Go-to-definition (`setDefinitionOpener` → `openFileRef.current`, `app.tsx:1008`).
  4. Content-search hit (`openMatch` → `openFile`, `app.tsx:949`).
  5. Review jump-to-hunk (`jumpToHunk` → `openFile`, `app.tsx:960`).
  6. Recents / command palette (`app.tsx:1665`, `1681`).
  7. OS / external file-open (`openFileInEditor` host msg → `openFile`, `app.tsx:1022`).
  8. Breadcrumb navigation (`onOpenFile`, `center-pane.tsx:140`).
  9. Drag-drop a file onto the editor (`app.tsx:1438`).
  10. Working-tree diff (`openDiff` → `kind: 'diff'`, a sibling of `openFile`).
- **The editor is EDITABLE** (dirty tracking in `webview/dirty-store.ts`, save via
  `webview/save-registry.ts`, Ctrl+S, the archived `editable-code` spec, and the
  per-tab unsaved-dot in `doc-tabs.tsx`). The request's "read-only today" premise is
  **stale for file docs** — only the Review view is read-only. ⇒ **"editing promotes
  a preview to permanent" DOES apply.** (See §13 D1.)
- **Persistence today:** **editor tabs are NOT persisted.** `docState` is renderer-
  only and initialises to empty (`initialDocs`). Only **sessions**
  (`src/persistence.ts` `serializeSessions` → `sessions.json`, written on
  `mgr.onChange` and in `flushStateSync` at `before-quit`, `electron/main.ts`) and
  **window layout** (`windows.json`, `WindowLayout.sessionIds`) survive a restart. So
  tab restore is **net-new** and must round-trip renderer → host → disk → renderer.
- **Session scoping:** docs are owned by a session (`OpenDoc.sessionId`); only the
  active session's docs show (`app.tsx:617`), and `activeBySession` remembers each
  session's last-active doc. Sessions are window-owned (multi-window).

---

## 1. Problem frame

- **Job (JTBD):** "When I'm browsing a codebase I want to glance at files without
  drowning in tabs, but keep the ones I'm actually working on — and when I reopen the
  app, find my workspace exactly as I left it." This is VS Code's preview-tab model.
- **Actors / roles:** the single local user driving Conduit (developer). No
  multi-user/permission dimension.
- **Success outcomes (observable):**
  - A single click on a file opens it in **one reusable, italic preview tab**;
    single-clicking another file **replaces that tab's content in place** (tab count
    does not grow, position is stable).
  - A deliberate gesture (double-click the file, double-click the tab, edit, drag, or
    an explicit "Keep Open") **promotes** the preview to a permanent (non-italic) tab.
  - At most **one preview file tab per session** at any time.
  - On restart, open tabs — including which is active and each tab's preview/pinned
    state — are **restored**, gated by the existing "restore sessions" setting.
- **Non-goals:** see §6 Out of scope. Notably: NOT building VS Code editor *groups*/
  split-by-preview, pinned-tab *ordering* rules, "locked" editors, or tab *groups*.

---

## 2. Behavior & states

### 2.1 The preview-tab state machine (per session)

```
            single-click a file (entry points 1–9)
   (none) ─────────────────────────────────────────▶ PREVIEW(fileA)
                                                          │
   single-click fileB (replace in place, same slot/pos)  │  ◀──┐
   PREVIEW(fileA) ───────────────────────────────────▶ PREVIEW(fileB)
                                                          │     │ (loops on each
                                                          │      single-click)
        promote: dbl-click file / dbl-click tab /         ▼
        edit (dirty) / drag tab / "Keep Open"      PINNED(fileB)
                                                          │
   single-click fileC ──────────────────────────────▶ PINNED(fileB) + PREVIEW(fileC)
   (a NEW preview slot opens; the pinned tab is untouched)
```

- **Happy path:** click `a.ts` → italic preview tab "a.ts". Click `b.ts` → same tab
  becomes italic "b.ts" (a.ts is gone, no new tab). Double-click `b.ts` in the
  explorer (or the tab, or start editing) → "b.ts" goes upright/permanent. Click
  `c.ts` → a *new* italic preview "c.ts" appears beside the permanent "b.ts".
- **At most one preview per session.** Opening a file as preview when a preview
  already exists **mutates the existing preview slot in place** (keeps array index ⇒
  stable tab position), never appends.

### 2.2 Full UI state catalog — see §8.

### 2.3 Non-happy lifecycle states

- **Preview target deleted on disk:** the editor body shows the existing
  file-read-failure / not-found state; the preview tab remains until replaced or
  closed (matches VS Code, which keeps the tab and shows an error). The next
  single-click replaces it anyway.
- **Restore from disk:** on launch, persisted docs rehydrate attached to their
  (stale) sessions; they render when that session is activated. A restored preview is
  restored **as a preview** (VS Code parity, §13 D2). A restored doc whose file no
  longer exists keeps its tab and shows the not-found body on first read.

---

## 3. Data / interface contract

### 3.1 Renderer model change (`webview/docs.ts`)

- `OpenDoc.preview?: boolean` already exists; **generalise its meaning** from
  "commit-diff only" to "any previewable doc kind" (`file`, `diff`, and the existing
  `commit-diff`). `web`/`review`/`git-history` never set it.
- **Keep the real id for file/diff previews** (`id = "file:<path>"`), unlike the
  `commit-diff` `@preview` sentinel. Rationale: a file path is already a stable
  identity, so de-dupe and "promote = clear the flag" both work without re-keying.
  Replace-in-place is done by mapping the existing preview doc to the new
  path/id/title (preserving its array index) — mirroring `openHistoryDoc`'s in-place
  map so the tab does not jump to the end.
- **New/changed reducer actions** (names indicative):
  - `open` gains a `mode: 'preview' | 'permanent'` (default per caller; see §9). For
    `mode:'preview'` of a `file`/`diff`: if the id already exists **as permanent** →
    activate it (never downgrade a pinned tab to preview); if it exists **as the
    preview** → just activate; else **replace the session's existing preview in
    place** or append if none.
  - `pinDoc` generalised to clear `preview` on a `file`/`diff` doc (id unchanged), not
    only re-key commit-diff.
  - `reorder` of a preview doc → clears its `preview` (drag promotes, VS Code parity).
  - A promotion trigger from **edit**: when a doc transitions to dirty
    (`dirty-store`), if it is a preview, clear `preview`. (Wiring point: the
    dirty-set subscriber in `app.tsx`/`doc-tabs.tsx`.)
- **Invariant:** for any `sessionId`, `docs.filter(d => d.sessionId===s && d.preview
  && (d.kind==='file'||d.kind==='diff')).length <= 1`.

### 3.2 Persisted DTO change (host, `src/persistence.ts` + `electron/main.ts`)

Tabs must round-trip. Add a persisted, per-doc record. Recommended shape
(versioned alongside sessions; see §13 D3 for *where* it lives):

```ts
interface PersistedDoc {
  kind: 'file' | 'diff';   // see §13 D4 for which kinds restore
  path: string;            // absolute, as today
  sessionId: string;       // owner; ties the tab to a restored (stale) session
  preview?: boolean;       // restored as-is (D2)
  active?: boolean;        // the owning session's remembered active doc
}
// Plus the global "which session's doc is active" already derivable from sessions.
```

- **Trust boundary:** paths come from the user's own machine (same trust as
  `sessions.json` today). Restore must tolerate a stale/missing path (keep the tab,
  show not-found) and a missing session (drop the orphan doc).
- **Versioning:** bump or namespace the persisted blob's `version`; an older blob
  with no docs section restores to "no tabs" (back-compat, like `restoreSessions`).
- **Write triggers:** same cadence as sessions — debounced async write on doc-state
  change, plus the **synchronous `flushStateSync`** path in `before-quit` (durability
  parity; see MEMORY "update durability"). Tab state is low-stakes vs. sessions, so a
  lost write only loses tab layout, never session/PTY state.

### 3.3 IPC messages (`src/protocol.ts`)

Renderer is the source of truth for `docState` today (an explicit exception to the
"host owns all state" rule in CLAUDE.md). Two seams:

- **Renderer → host (persist):** a new client message, e.g.
  `{ type: 'persistDocs'; docs: PersistedDoc[] }`, sent (debounced) whenever the
  persisted-relevant slice of `docState` changes. Host writes it.
- **Host → renderer (restore):** carry restored docs in the existing `state`
  broadcast (`main.ts:917`) as a new field (e.g. `state.openDocs`), or a one-shot
  `{ type: 'restoreDocs'; docs: PersistedDoc[] }` consumed once on first render to
  seed `docState`. (Choice = §13 D5.) Restore must land **after** sessions exist so
  owner ids resolve — reuse the existing "open-after-ready" queue pattern
  (`pendingOsOpensRef`, `app.tsx:444`).

> **Cross-boundary ⇒ real-app verification required.** Tab state must survive a true
> process restart; the preview mock shell (`window.agentDeck` absent) cannot exercise
> persistence. Add a `test/e2e/<name>.e2e.mjs` scenario on the shared harness (see
> CLAUDE.md / MEMORY "Playwright-Electron"), NOT a `needs-human-smoke` tag.

---

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Open a file already open **as a permanent tab** | Focus/activate it. Never create a preview or a duplicate; never downgrade it to preview. |
| Open a file already shown **as the preview** | Just activate/re-reveal it (no-op churn). |
| Single-click while a preview exists | Replace the preview **in place** (same tab slot/position), retarget id/path/title. |
| Preview file **deleted on disk** | Editor body shows not-found/read-error; tab stays until replaced or closed. |
| **Edit** the preview (becomes dirty) | Promote to permanent (clear `preview`) so an unsaved buffer is never silently replaced by the next single-click. Protects against data loss. |
| Close the preview tab | Preview slot becomes empty; next single-click opens a fresh preview. |
| **Drag** the preview tab (reorder) | Promote to permanent (VS Code parity). |
| Many tabs open | Unaffected; exactly ≤1 is preview. Overflow chevron + dropdown (`doc-tabs.tsx`) unchanged; preview shows its italic cue in the dropdown too (see §10 a11y). |
| Concurrency: two single-clicks in flight | Reducer is synchronous + idempotent on id; last write wins on the single preview slot — no duplicate tabs. |
| Two windows, two active sessions | Preview is per-session, so each window's active session has its own independent preview. No cross-window interference. |
| Restart with a preview tab | Restored as a preview (§13 D2). |
| Restart with the file gone | Tab restored; not-found body on first read; not auto-closed. |
| Restart with a dirty (unsaved) buffer | Unsaved buffer contents are NOT persisted (no autosave today); the tab restores as a clean permanent tab pointing at the on-disk file. (Out of scope: hot-exit/dirty restore — §6.) |
| `restoreSessions` setting OFF | No sessions restore ⇒ no docs restore (docs are session-scoped). Consistent, no separate setting. |
| Singleton docs (`review`, `git-history`) | Never preview; open/activate as today. |
| `commit-diff` preview (existing) | Behavior preserved. Coexistence with a file preview: see §13 D6. |
| `web` tab | Never preview (each URL is a distinct permanent tab); unchanged. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Single-click opens as preview | **On** | Yes — a setting equivalent to VS Code `workbench.editor.enablePreview`; off ⇒ every open is permanent | Durable, divergent user preference; VS Code default is on. |
| Preview from search/go-to-def/path-link/recents/palette | **On** (preview) | Folded under the same enable-preview setting | Matches VS Code `enablePreviewFromQuickOpen`/code-nav defaults; keeps the "browsing is cheap" model. |
| Double-click in explorer = permanent | **On** | No | Core gesture, not a preference. |
| Edit promotes to permanent | **On** | No | Data-safety invariant, not a preference. |
| OS/external file open (`openFileInEditor`) = permanent | **On (permanent)** | No | Opening from outside the app is a deliberate "work on this" act (VS Code opens these non-preview). See §13 D7. |
| Restore tabs on restart | Gated by existing **`restoreSessions`** | Reuse existing setting | Docs are session-scoped; a second toggle would be confusing/redundant. |
| Restore preview as preview | **On** | No | VS Code parity (§13 D2). |

---

## 6. Scope slicing

- **MVP (must):**
  - Preview tab for **`file`** docs: single-click = preview, replace-in-place, ≤1 per
    session.
  - Promotion via **double-click the file in explorer** (add the dbl-click handler),
    **double-click the preview tab** (generalise existing handler), and **edit
    (dirty)**.
  - All file-open entry points classified preview vs permanent per §9.
  - Italic preview cue (token already exists) **+ a non-visual (ARIA) preview cue**
    (§10).
- **v1 (should):**
  - **Persist + restore** open tabs (incl. active + preview/pinned state) across
    restart, gated by `restoreSessions` (§3.2/§3.3).
  - **Drag-to-promote** (reorder clears preview).
  - Apply preview semantics to **`diff`** docs and add the **enable-preview setting**.
  - Explicit **"Keep Open" / pin** context-menu action on the tab.
- **Vision (could):**
  - Unify to a single preview slot across all kinds (file + commit-diff) per VS Code
    "one preview per group" (§13 D6).
  - Restore `commit-diff`/`web` tabs too (§13 D4).
  - Persist & restore **unsaved (dirty) buffers** — VS Code "hot exit".
  - Preview-on-keyboard-arrow in Quick Open (preview-as-you-navigate).
- **Out of scope:**
  - VS Code editor **groups / split layout** semantics, pinned-tab segregation
    ordering, "locked" editors, tab pinning-to-the-front.
  - Hot-exit / dirty-buffer persistence (listed as Vision, not built now).
  - Any change to terminal-tab or session-tab behavior.
  - Changing the Review view's read-only nature.

---

## 7. Acceptance criteria

### 7.1 Declarative (baseline)

- A single click on a file (from any entry point in §9 classed *preview*) opens it in
  exactly one italic preview tab; clicking another such file replaces that tab's
  content without increasing the tab count or moving the tab.
- Double-clicking a file in the explorer opens it directly as a permanent (non-italic)
  tab.
- Double-clicking the preview tab, editing the file, or dragging the tab makes it
  permanent.
- Opening a file that is already a permanent tab focuses it (no preview, no
  duplicate).
- With `restoreSessions` on, after a restart the previously open tabs reappear with
  the same active tab and the same preview/pinned states.

### 7.2 EARS

- **Ubiquitous:** The editor shall maintain at most one preview file tab per session.
- **Event-driven:** When the user single-clicks a file from a preview-class entry
  point, the editor shall show that file in the session's preview tab, replacing any
  previous preview content in the same tab position.
- **Event-driven:** When the user double-clicks a file in the explorer, the editor
  shall open it as a permanent tab.
- **Event-driven:** When the user double-clicks the preview tab, drags it, or edits
  its file, the editor shall promote that tab to permanent.
- **Unwanted behavior:** If the user single-clicks a file that is already open as a
  permanent tab, then the editor shall activate that tab and shall not create a
  preview or a duplicate.
- **State-driven:** While a preview tab holds unsaved edits, the editor shall treat it
  as permanent (it shall not be replaced by a subsequent single-click).
- **Optional feature:** Where `restoreSessions` is enabled, the app shall persist the
  open tabs and restore them — with active and preview/pinned state — on next launch.
- **Unwanted behavior:** If a restored tab's file no longer exists, then the editor
  shall keep the tab and show a not-found state rather than dropping it silently.

### 7.3 Gherkin (key flows)

```gherkin
Feature: VS Code-style preview tabs
  Background:
    Given a running session with the editor visible
    And no editor tabs are open

  Scenario: Single-click reuses one preview tab
    When I single-click "a.ts" in the explorer
    Then an italic preview tab "a.ts" is shown and active
    When I single-click "b.ts" in the explorer
    Then the same tab now shows "b.ts" in the same position
    And there is exactly one editor tab

  Scenario: Double-click pins, then preview opens beside it
    Given an italic preview tab "b.ts" is active
    When I double-click "b.ts" in the explorer
    Then the tab "b.ts" becomes non-italic (permanent)
    When I single-click "c.ts" in the explorer
    Then a new italic preview tab "c.ts" opens beside "b.ts"
    And "b.ts" remains a permanent tab

  Scenario: Editing promotes a preview
    Given an italic preview tab "b.ts" is active
    When I type into the editor so the buffer is dirty
    Then "b.ts" becomes a permanent tab
    When I single-click "c.ts" in the explorer
    Then "b.ts" is not replaced and "c.ts" opens in a new preview tab

  Scenario: Opening an already-pinned file focuses it
    Given "b.ts" is open as a permanent tab and "x.ts" is the preview
    When I single-click "b.ts" in the explorer
    Then "b.ts" is activated
    And no new tab is created and "x.ts" preview is unchanged

  Scenario: Tabs restore across restart
    Given "b.ts" is a permanent tab and "c.ts" is the active preview
    And "restore sessions" is enabled
    When I quit and relaunch Conduit
    Then "b.ts" is restored as a permanent tab
    And "c.ts" is restored as the active preview tab
```

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Editor tab strip | First-run / empty | No doc tabs, only the Terminal tab | Click a file to open |
| Editor tab | Preview (ideal) | One **italic** tab title; close (×) on hover | Single-click another file replaces it; dbl-click / edit / drag promotes |
| Editor tab | Permanent (ideal) | Upright (non-italic) tab title | Normal tab |
| Editor tab | Active | Active styling (`tab--active`) + matches above | — |
| Editor tab | Dirty (unsaved) | Unsaved dot, **and** upright (dirty ⇒ promoted) | Ctrl+S / click dot to save |
| Editor tab | Preview + would-be-replaced | (transient) content swaps in place; no flash of a new tab | — |
| Editor body | Loading | Cached content stays until host replies (no flicker, per `openFile` note) | — |
| Editor body | Not-found (file deleted) | File-read error/not-found surface; tab persists | Close tab |
| Tab overflow dropdown | Has preview among many | Listed item shows the same preview (italic/“preview”) cue | Select to activate |
| Restored workspace | After restart | Same tabs/active/preview as before quit | — |
| Restored workspace | restoreSessions off | No tabs (clean) | — |

(First-run/empty, loading, error/not-found, and partial are all covered; no
permission/offline state applies — local filesystem, no auth.)

## 9. Interaction inventory (UI) — entry-point classification

| Entry point | Single-action result | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Explorer file row | **single-click → preview; double-click → permanent** | click / dblclick | Enter = preview, Shift/Alt-Enter or a “Open to the side”? → out of scope; Enter+Enter n/a | tap = preview, double-tap = permanent | "Open" / "Keep Open" | tree item; opened tab gets preview cue |
| Terminal path link | preview | click | — | tap | — | — |
| Go-to-definition | preview | (via action) | the goto keybind | — | — | — |
| Content-search hit | preview | click | Enter | — | — | — |
| Review jump-to-hunk | preview | click | — | — | — | — |
| Recents / palette | preview | click | Enter | — | — | — |
| Breadcrumb nav | preview | click | Enter | — | — | — |
| OS/external open (`openFileInEditor`) | **permanent** (§13 D7) | n/a | n/a | n/a | — | — |
| Drag a file onto editor | **permanent** | drop | — | — | — | — |
| The preview tab itself | dbl-click / drag / edit → **promote** | dblclick / drag | a tab "Keep Open" command (v1) | double-tap | "Keep Open", "Close", "Close Others"… | `role=tab`, `aria-selected`; **add preview state to accessible name** |

Rules honored: **every drag promotion has a non-drag pathway** (dbl-click / edit /
"Keep Open"); preview vs permanent is not signalled by color alone (italic + ARIA);
focus stays visible (existing tab focus styles); destructive close keeps the existing
unsaved-changes confirm dialog (`closeDoc`, `app.tsx:857`).

## 10. Accessibility & i18n (UI)

**Accessibility**
- **Preview is currently italic-only** (`.tab--preview > span`) — a visual-only signal.
  Add a **non-visual cue**: include "(preview)" (or `aria-description`/`aria-label`
  suffix) on the tab's accessible name, and the same in the overflow dropdown item, so
  screen-reader users can tell preview from permanent. (WCAG 1.4.1 use-of-color, 1.3.1.)
- **Keyboard:** every promotion reachable without a pointer — explorer Enter opens
  (preview), a tab-level **"Keep Open"** command/menu item promotes (since dbl-click
  and drag are pointer-only). Without it, keyboard users cannot pin — this is a
  required pathway, not optional.
- **Visible focus** on tabs preserved (don't regress `tab--active`/focus outline);
  verify under forced-colors (italic still distinguishes; ARIA name carries the rest).
- **Announce** promotion/replacement only if it would otherwise be silent to AT —
  prefer the accessible-name change over a noisy live region (low value, can be
  noisy); a polite live region for "Pinned <file>" is optional (§13 leave to impl).
- **Reduced motion:** the in-place content swap must not depend on animation.

**i18n**
- New user-facing strings ("(preview)", "Keep Open") must be externalized **at the
  same level the codebase already does** — note the repo currently hardcodes English
  microcopy (e.g. "Unsaved changes — Ctrl+S to save" in `doc-tabs.tsx`); match the
  existing convention and do not regress. (No i18n framework exists today; introducing
  one is out of scope — flagged as an existing limitation, not this feature's job.)
- Tab titles are file basenames (locale-neutral). No new pluralization/number/date
  formatting. RTL: the strip already lays out with the existing fl/overflow logic; no
  directional workflow reverses.

## 11. Design tokens (UI)

- **Preview cue token already exists:** `.tab--preview > span { font-style: italic }`
  (`styles.css:1382`). Reuse it for file/diff previews — no new color token. Keeping
  the cue **non-color** (italic) is deliberate and satisfies use-of-color. Theme
  variants (light/dark/high-contrast): italic + ARIA name are theme-independent, so no
  per-theme token is required.
- No new semantic color roles introduced. (If a future design wants a subtler cue,
  that's a token decision deferred to design, not required here.)

## 12. Assumptions

- The editor is editable for file docs (verified via dirty-store/save-registry) ⇒
  edit-promotes applies. (The request's "read-only" note is treated as stale; see D1.)
- "At most one preview" is scoped **per session** (Conduit's editor-group analogue),
  not globally — matches existing session-scoped doc model.
- Replace-in-place keeps the tab's position (array index), mirroring `openHistoryDoc`.
- Persistence reuses the `restoreSessions` setting and the existing atomic-write +
  `before-quit` sync-flush durability machinery; no new persisted setting.
- `web`, `review`, `git-history` are never previewable; their behavior is unchanged.
- Reverse-engineered entry-point list (§0/§9) is complete; if a new file-open path is
  added later it must pick a class.

## 13. Decisions Needed (autonomous)

- **[normal] D1 — Does "edit promotes" apply (editor read-only?).** Request said the
  editor is read-only; the code shows it is **editable** for file docs.
  **Default taken:** edit-promotes is **included**. Reversible (drop the trigger if
  the premise was intended). Low risk — promoting on edit only protects data.
- **[normal] D2 — Restore a preview as preview or pin it on restore?**
  **Default taken:** restore **as preview** (VS Code parity). Alternative (pin on
  restore) is simpler but diverges from VS Code; reversible.
- **[normal] D3 — Where do persisted docs live?** Options: extend `sessions.json`
  (one file, atomic with sessions) vs. a sibling `docs.json`. **Default taken:**
  **sibling `docs.json`** keyed by sessionId, written on the same cadence — keeps the
  session blob shape stable and isolates a tab-blob corruption from session restore.
  Reversible either way.
- **[normal] D4 — Which doc kinds restore?** **Default taken:** restore **`file` (and
  `diff` in v1)** only; do **not** restore `commit-diff`/`review`/`git-history`/`web`
  in MVP (they depend on transient git/page state). Listed in Vision to extend.
- **[normal] D5 — Restore transport: in the `state` broadcast vs. a one-shot
  `restoreDocs` message.** **Default taken:** a **one-shot `restoreDocs`** consumed
  once to seed `docState` (avoids the host having to keep re-sending renderer-owned
  state on every `state` broadcast, which would fight renderer ownership). Reversible.
- **[normal] D6 — One preview slot across all kinds, or one per kind?** VS Code = one
  preview per group total. Conduit already ships a separate `commit-diff` preview.
  **Default taken (conservative):** **one preview per kind per session** for MVP
  (don't disturb shipped commit-diff behavior); unify to a single slot in Vision.
- **[normal] D7 — OS/external file open: preview or permanent?** **Default taken:**
  **permanent** (VS Code opens externally-triggered files non-preview; it's a
  deliberate act). Reversible.

No `high`-severity decisions: every default is reversible and none risks data loss or
an irreversible migration (the persisted blob is versioned and degrades to "no tabs").

## 14. Open questions

None blocking — all material ambiguities are captured as severity-tagged defaults in
§13 (autonomous mode).

---

## Self-audit

All template sections present and filled for a FULL UI spec: problem frame, behavior/
states + state machine, data/interface contract (renderer model, persisted DTO, IPC),
edge cases, defaults vs. settings, scope slicing, acceptance criteria (declarative +
EARS + Gherkin), UI state catalog, interaction inventory (all entry points classified),
a11y + i18n (incl. the italic-is-color-only gap and the keyboard "Keep Open" pathway),
design tokens, assumptions, severity-tagged Decisions Needed, open questions. UI module
(§8–11) is genuinely filled, not skipped. Cross-boundary persistence is flagged for
real-app e2e (not the mock). No section left thin without a one-line justification.

A fresh-eyes reviewer subagent was **not** dispatched (autonomous pipeline; to avoid a
nested-agent dependency and the Sonnet-subagent hazard noted in repo MEMORY). In its
place this self-audit was run rigorously against the feature-spec template, the
state-and-interaction checklist, and the accessibility-i18n checklist; coverage gaps
found during the walk (ARIA preview cue, keyboard pin pathway, i18n externalization
limitation) were folded back into §10.
