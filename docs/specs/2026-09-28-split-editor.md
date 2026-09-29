---
status: active
date: 2026-09-28
---

# Feature Spec: Split editor (two groups, left/right)

**Tier:** FULL   **Feature type:** UI
**One-line request:** "Split view like in vscode (probably split left/right is enough)."

Written in autonomous mode: every open question is an assumption, and each one is listed in §13.

## 1. Problem frame

- **Job:** see two editors side by side (a file next to its test, a diff next to the source, or the
  agent's terminal next to a file) without switching tabs back and forth.
- **Actors:** one user in one Conduit window, working in one session at a time.
- **Success outcomes:**
  - Two **editor groups**, left and right, each with its own tab strip and active tab.
  - Exactly one group is **active** (focused). Everything that reads "the active tab" today
    reads the active group's active tab.
  - Both groups can show the same file. They share one buffer and dirty state, and each keeps its
    own scroll, cursor and fold state.
  - The split and its groups' tabs survive a restart, the same way tabs do today.
- **Non-goals:** vertical or grid splits, more than two groups, splitting the Terminal tab (the
  existing session split pane, `splitId`, already covers that), floating or detached editor
  windows, and editor groups across Conduit windows.

## 2. Behavior & states

### 2.1 Tab model today (inventory)

| Fact | Where | How established |
|---|---|---|
| Doc kinds: `file` (renders code / markdown / image / PDF / HTML / plan by path), `diff`, `commit-diff`, `review`, `web`, `git-history`. The Terminal is a pseudo-tab with no doc id (`activeId === null`). | `webview/docs.ts` `DocKind`; `webview/components/doc-tabs.tsx` | Source inspection |
| One `OpenDoc` per identity: the id is `${kind}:${path}` and is unique across the whole state. `review`/`git-history` are singletons; the `commit-diff` preview uses an `@preview` slot. | `docs.ts` `idOf`, reducer `open`/`openReview` | Source inspection |
| Docs are **session-owned** (`sessionId`), and a session shows only its own docs. There is a single global `DocsState.activeId` plus per-session memory in `activeBySession`. Tab order is the order of the one `docs[]` array. | `docs.ts` `DocsState`; `app.tsx` `visibleDocs` | Source inspection |
| The center pane mounts only the **active** doc's viewer (`DocView key={activeDoc.id}`), plus every web tab (always mounted, display-toggled) and every running terminal (always mounted). | `center-pane.tsx` | Source inspection |
| 19 lines in `app.tsx` read the active doc: palette editor commands, `activeFilePath` re-read on activate and on window focus, `repo:context` auto-follow, `reviewMode`, closeTab, and nav-history deps. `cycleTab`/`navGoToTab` index `docs.filter(sessionId)` order directly. | `grep -c "docState.activeId\|activeDoc" webview/app.tsx` → 19 | Measured (grep count) |
| **Close teardown is per doc:** `forceCloseDoc` runs `clearDirty(path)`, `clearReveal(path)`, `markClosing(id)` (drops view state), `clearHtmlView(id)` and `pushClosedTab` on every close. | `app.tsx:1640-1657` | Source inspection |
| Tab context-menu Close Others / to the Right / to the Left / All go through `tab-close-selection.ts` over **paths**, then filter `docState.docs` by path. | `app.tsx` ~2336-2368, ~3254 | Source inspection |
| Diff tabs create **unkeyed** original/modified models per mount and dispose them on unmount, unlike file models. | `diff-viewer.tsx:136-166` | Source inspection |
| Go to Definition and every Monaco cross-file navigation go through `registerEditorOpener` → `openDefinitionFile` → `openFileRef(abs, …, 'preview', {reveal})`, which lands in "the" active tab slot. | `monaco-opener.ts`, `project-index.ts`, `app.tsx:2000` | Source inspection |
| Monaco models are keyed by `file://` URI and reused (`getModel(uri) ?? createModel`), so two editors on one path would share one model. | `code-viewer.tsx:169` | Source inspection |
| **Per-instance, path-keyed registries** that assume one live CodeViewer per path: `baselineRef` (the dirty baseline, per instance), and single-slot `Map<path, entry>` registries `registerSave`, `registerSelection`, `registerNavEditor`, `registerChangeNav` (`nextChange`/`prevChange`). A second mount **overwrites** the first viewer's entry, and when the second unmounts, its identity-checked unregister **deletes** it, so the survivor ends up unregistered. Also `takeReveal(path)` (consumed by the first mount) and `publishCursor({path})` (breadcrumbs). | `code-viewer.tsx`, `save-registry.ts`, `selection-registry.ts`, `nav-editors.ts`, `change-nav-registry.ts`, `project-index.ts` | Source inspection |
| View state (scroll, Monaco view state, Review anchor, `planSource`) and HTML view mode (`html-view-store.ts`) are keyed by `OpenDoc.id`. | `view-state-store.ts`, `html-view-store.ts` | Source inspection |
| No `role="tablist"` exists. Doc tabs are `role="tab"`, and the Terminal tab is a plain `<button>`. | `doc-tabs.tsx` | Source inspection |
| The Files explorer has **no** active-file highlight or auto-reveal. | `grep activeDoc\|autoReveal\|aria-current` over files-view, right-pane, folder-section, file-tree* → no hits | Measured (grep) |
| `Ctrl+1…9` is already bound (`navGoToTab`: go to tab N of the session). `Ctrl+\` is unbound. | `shortcuts.ts`; `grep Backslash` → only a comment | Measured (grep) |
| A second, unrelated "split" already exists: the **session split pane** (`splitId`, "Open in split pane", palette "Split with: X" / "Close split pane"). It shows two terminals side by side inside `.termstack`. | `app.tsx:384,2206,3436`; archive spec t6-split-panes | Source inspection |
| The tab-bar **background** is a drag handle that re-docks the whole center panel, and `.centerpane` is a dock drop target. Tabs have their own reorder drag, and a `file` tab drag also stamps `DownloadURL` for drag-out. | `doc-tabs.tsx` `moveGrip`; `center-pane.tsx` `dock` | Source inspection |
| `docs.json` (`version: 1`) restores only `file` and `diff` kinds. `isRestorableDoc` filters but does not strip unknown fields. | `src/persistence.ts` | Source inspection |
| Review **mode** (layout plus the right pane as navigator) is `activeDoc?.kind === 'review'`. | `app.tsx:1191` | Source inspection |

None of these are runtime behavior claims that §2.3 depends on, except one: that **two concurrent
CodeViewers on the same path break dirty/save/nav**. That is inferred from the source, is
`ASSUMED`, and is listed in §13 as D1. The planner's first slice must reproduce it before fixing it.

### 2.2 Group model (target)

- **Layout per session.** Each session has either **one group** or **two groups** (left = group 1,
  right = group 2). This matches how docs and `activeBySession` are already session-scoped.
  Switching sessions shows that session's layout.
- **Group contents.** A group is an ordered list of tabs plus its own active tab. Group 1
  **always** holds the session's Terminal pseudo-tab first. Group 2 never has one.
- **Doc vs. tab.** A doc (identity, ownership, title, `reviewSource`, …) exists **once**. A tab is
  a doc's membership in a group. A splittable doc can be a member of both groups (two tabs, one
  doc). **Preview is per tab:** at most one preview tab per group per session. A file or diff
  preview and the commit-diff `@preview` slot may coexist in one group: the slot is its own
  preview kind (amended in the review round).
- **Active group.** Exactly one per session. Every consumer listed in §3 reads the active group's
  active tab.

### 2.3 Which kinds can be in both groups

| Kind | In both groups at once? | Move between groups? | Why |
|---|---|---|---|
| `file` (every renderer) | yes | yes | VS Code parity: one document, independent views. |
| `diff` | yes | yes | Each mount owns its own (unkeyed) diff models, so the two views are independent and read-only on the original side. |
| `commit-diff` (pinned) | yes | yes | Read-only. A **preview** slot is pinned first when split or moved. |
| `web` | **no** | yes, **without reloading** the page | One `<webview>` per tab, kept warm on purpose. A second instance is a second browsing context. |
| `review`, `git-history` | **no** (singletons) | yes | They are singleton ids, and Review's state lives in one `view-state-store` entry. |
| Terminal pseudo-tab | **no** | **no** | Always in group 1. The session split pane covers two terminals. |

"Split Right" on a move-only kind **moves** the tab into group 2. On the Terminal tab it is
disabled.

### 2.4 Primary flows

1. **Split Editor Right** (`Mod+\`, the tab context menu "Split Right", or the strip button):
   - **One group:** create group 2 and put the active group's active doc in it: a duplicate tab for
     splittable kinds, a move for move-only kinds. Group 2 becomes the active group, and focus
     lands in its viewer. Group 1 keeps showing what it showed. For a moved tab, group 1 falls
     back to that tab's left neighbour, or the Terminal.
   - **Two groups, active = group 1:** same as above, into the existing group 2. If the doc is
     already a tab there, that tab is activated instead of duplicated.
   - **Two groups, active = group 2:** no-op. The polite live region announces
     "Only two editor groups are supported." The menu item is disabled.
   - **Active tab is the Terminal:** disabled and a no-op, with no announcement from the key.
2. **Focus a group:** a pointer-down or focus-in anywhere inside a group's strip or body makes it
   the active group. Keyboard: see §9. A pointer-down inside a web tab's `<webview>` guest never
   reaches the host document, so a web tab focuses its group through the focus-in path instead
   (the guest taking focus).
3. **Move a tab:** drag it to the other group's strip (insert at the drop position) or body
   (append). Keyboard/menu: "Move to Other Group". The moved tab becomes active in the target
   group, and the target group becomes active.
4. **Drag to split:** with one group, dropping a doc tab on the **right-edge zone** of the group
   body (the right third, with a half-width drop overlay preview) creates group 2 and moves the
   tab into it. With two groups, edge zones are inert and a body drop simply moves the tab.
5. **Close the last tab in group 2** → group 2 closes, group 1 takes the full width and becomes
   active. Group 1 never closes because it always has the Terminal tab.
6. **Close Editor Group** (palette, and the context menu on group 2's strip background) closes
   every tab in group 2, going through the existing dirty-close prompts (`close-dirty.ts`).
   Cancelling any prompt keeps the group. **Join Editor Groups** (v1) moves group 2's tabs to the
   end of group 1 instead: an already-present duplicate just drops, and preview tabs are pinned.
7. **Resize:** drag the divider, or focus it and use the arrow keys. The ratio persists.

### 2.5 Behavior contracts per consumer (the active group drives)

- **Opens** (explorer, quick open, Find in Files, change list, links, Monaco navigation such as Go
  to Definition / References / peek-open, the nav-history apply, reopen closed tab) target the
  **active group**. One exception: when the active group's active tab is the **Terminal** and
  group 2 exists, the open targets **group 2**, so the terminal stays in view (D5). If the doc is
  already a tab in the target group, that tab activates. If it is only in the *other* group, a new
  tab opens in the target group (splittable kinds) or the existing tab moves (move-only kinds).
- **Monaco navigation from an editor** lands in that editor's **own** group. It is routed by
  the `source` editor that `openCodeEditor(source, …)` receives, mapped to its group, not by
  focus. That way a peek-open or Ctrl+click without prior focus still stays in its group. The
  navigation also makes that group active.
- **Background opens** (middle-click, a web page's background link, `mode: 'background'`) target
  the same group as a foreground open would (the rule above) and never change the active group.
  The `flashTabId` cue shows in that group's strip.
- **Tab commands** (`Mod+W`, `Ctrl+Tab`/`Ctrl+Shift+Tab`/`Ctrl+PgUp`/`Ctrl+PgDn`, `Ctrl+1…9`,
  pin by double-click, and the overflow chevron list) act on the **active group's** tab order.
  The tab context menu's Close / Close Others / Close to the Left / Close to the Right / Close All
  act on the **right-clicked tab's group**, by tab ref, never by path or `docs[]` order.
- **Close fallback:** when a group's active tab closes, the left neighbour **in that group**
  becomes active, else the right neighbour, else the Terminal (G1) or G2 collapses (I4).
- **Close teardown** (`clearDirty`, `clearReveal`, `markClosing`, `clearHtmlView`) runs only
  when the doc's **last** tab closes. Closing one tab of two drops only that tab's per-tab view
  state. `pushClosedTab` runs on every tab close and records the group.
- **Ownership transfer** (a foreground open or `openReview` from session B of a doc owned by A)
  removes the doc from **all** of A's groups (collapsing A's G2 if it empties), then lands it in
  B's target group.
- **`Mod+S`** / the palette editor commands (Reveal, Copy Path, Toggle HTML view, Revert, …) act
  on the active group's active doc.
- **Closing a tab whose doc is still a tab in the other group** closes only that tab: no dirty
  prompt, and the buffer and model survive. The dirty prompt fires only when the **last** tab of a
  dirty doc closes. The closed-tab stack records the group, and reopen restores into that group
  if it still exists (else the active group).
- **Session close** removes the session's docs from both groups. **Ownership transfer** on
  re-open keeps working per doc.
- **Review mode** is on while the Review tab is the **visible** tab of either group (not only the
  active one), so its right-pane navigator keeps driving the visible Review (D6).
- **`repo:context` auto-follow** fires for the active group's active file. **Re-read**
  (`readFile`) fires when a tab becomes visible in either group, and on window focus it runs for
  the visible file of **both** groups.
- **Nav history:** `currentEntry` reads the active group's editor (its cursor). An entry counts as
  "on screen" (so a step never lands there) only when it is the active group's visible tab. An
  entry visible in the inactive group is a valid landing, and landing there focuses that group.
- **Breadcrumbs** render inside each group's viewer, and each one reflects **its own** editor's
  cursor, even when both groups show the same file.
- **Explorer highlight:** none exists today (§2.1), so there is nothing to retarget. Out of scope.

### 2.6 States

| State | Transitions |
|---|---|
| **Single** (one group) | → Split (Split Right / drag to edge / restore) |
| **Split, left active** | ↔ Split, right active (focus); → Single (group 2 emptied / Close Group / Join) |
| **Split, right active** | same as above |
| **Split, narrow** (center width < 2 × min) | Both groups shrink proportionally below min. The stored ratio is unchanged. Nothing auto-closes. |
| **Split in another session** | Invisible. Restored when that session is activated. |
| **Board / Canvas center view** | The editor groups are hidden as a whole and come back unchanged. |

## 3. Data / interface contract

### 3.1 The riskiest change: from one active tab to per-group state (planner slices from this)

**Contract, not code.** Today `DocsState` = `{ docs[], activeId, activeBySession }`. After:

- `docs[]` stays the unique doc registry: identity, ownership, title, and kind-specific fields.
  Its array order **stops** being tab order.
- Per session, `layouts[sessionId]: SessionLayout = { groups: [G1] | [G1, G2], activeGroup: 1 | 2 }`.
  Each group is an `EditorGroup = { tabs: Tab[], active: string | null }`, where
  `Tab = { id, preview? }` and `active === null` is the Terminal (G1 only). `layouts` replaces
  `activeBySession`, and `OpenDoc.preview` moves onto `Tab`.
- `activeId` stays a field, but only as a **cache** of the shown session's active group's active
  tab. It is written only by the reducer's `finalize()` step, which also collapses an empty G2 (I4)
  and drops zero-tab docs (I6). Existing `docState.activeId` readers therefore keep working
  unchanged. (Planner: `docs/plans/2026-09-28-split-editor.plan.md` P1.)

**Invariants (unit-testable in the reducer):**

- **I1.** Every tab references an existing doc owned by the session whose groups hold it.
- **I2.** A doc appears at most once per group, and a move-only kind appears in at most one group.
- **I3.** At most one preview tab per group per session, counting file and diff previews. The
  commit-diff `@preview` slot is its own preview kind and may sit beside one (amended in the
  review round).
- **I4.** G2 is never empty. Emptying it removes it and sets `activeGroup = 1`.
- **I5.** The Terminal sentinel is in G1 only, is always first, and can't be moved or closed.
- **I6.** A doc with zero tabs is removed from `docs[]` (the dirty prompt already ran).
- **I7.** With a single group, reducer behavior is **identical** to today for every existing
  action. This is the regression guard: every existing `docs.ts` test passes unchanged against the
  selector.
- **I8.** Retargeting a preview tab never mutates or removes a doc that the other group still
  references. It creates or reuses a different doc and moves only this tab's ref.
- **I9.** Ownership transfer leaves the losing session with no tab referencing the doc, and I4
  still holds for it.
- **I10.** A move (tab to the other group, or a move-only split) **re-keys** that tab's per-tab
  view state (scroll, Monaco view state, Review anchor, HTML mode) to the new group. A duplicate
  starts from a copy of the source tab's state.

**New actions:** `splitRight`, `moveTab {id, toGroup, beforeId?}`, `focusGroup`, `closeGroup`,
`joinGroups` (v1). Existing actions gain an optional target group, defaulting to the active group
per §2.5.

**Modules affected:** `webview/docs.ts` (reducer, `toPersistedDocs`, restore), `webview/app.tsx`
(the 19 active-doc readers, `cycleTab`, `navGoToTab`, `forceCloseDoc`/`closeDoc` teardown,
the tab-menu close actions and palette `cmd:closeOthers`, reopen, open routing including
background opens, the definition opener, nav-history deps, the window-focus re-read),
`webview/tab-close-selection.ts` (select over a group's tab refs, not paths),
`webview/components/center-pane.tsx` (render N groups; supply `files`/held diffs and a `DocView`
for **each** group's visible doc; web hosts per group), `webview/components/doc-tabs.tsx` (one strip
per group, a new `role="tablist"`, cross-strip drag, split button),
`webview/use-background-open-feedback.ts` (flash per group), `webview/monaco-opener.ts` (route by
source editor), `webview/closed-tabs.ts` (+group), `webview/use-nav-history.ts` / `editor-nav.ts`
(apply and on-screen per §2.5), `webview/view-state-store.ts` + `webview/html-view-store.ts` (key by
group + doc, re-key on move), `src/protocol.ts` + `src/persistence.ts` (`PersistedDoc.group`),
`src/settings.ts` (the ratio), `webview/shortcuts.ts` (new actions), and `webview/tab-overflow.ts`
(`data-tabid` must be unique per strip; query within the strip).

### 3.2 Second risk: two live viewers on one path

Every path-keyed registry in §2.1 has to hold up with two CodeViewers (or diff editors) mounted on
the same path at once. Contract:

- **Dirty baseline is per path, not per instance.** A save from either group clears the dirty
  dot in **both** tabs, and a later edit in either one compares against the saved content.
- **Every path-keyed registry becomes multi-entry per path**: `save-registry`,
  `selection-registry`, `nav-editors`, `change-nav-registry`, and any other found by grep (check
  `review-note-target`, `mention-bus`). Lookups resolve to the **active group's** editor for that
  path, with a fallback to any mounted one. Unmounting one viewer leaves the other registered.
  The existing single-slot identity check does **not** give this (§2.1). Required test: mount two
  viewers, unmount the **newer** one, and check that `Mod+S` still saves from the survivor.
- **Reveal** (`setReveal`/`takeReveal`) is consumed by the editor in the **target** group of the
  open, not by whichever mounts first.
- **Cursor publish** carries a group (or editor) identity so each breadcrumb follows its own
  editor.
- **Per-tab vs. shared:** view state, HTML rendered/source mode and plan source mode are **per
  tab** (group + doc). Dirty state and file models are **per path** (shared).
- **Model lifetime:** file models are unchanged: they persist and no editor unmount disposes
  them. Diff models stay per mount (§2.1).

### 3.3 Persistence

- `PersistedDoc` gains optional `group?: 2` (absent = group 1). A doc with tabs in both groups
  persists as **two entries** that differ only in `group`. `active` means "active tab of its group
  in its session". The active group persists as `focus: true` on the group-2 active entry of a
  session whose active group is 2; restore then focuses group 2, and otherwise group 1. Nothing
  else carries it, so single-group output is unchanged and an older build ignores the field
  (amended in the review round).
- **Order:** entries are serialized in per-group tab order, G1 first and then G2, per session.
  Restore rebuilds each group's order from entry order. Preview is per entry.
- `DOCS_VERSION` stays **1**. An older build reading a newer file dedupes by id (first entry wins)
  and ignores `group`, so a downgrade degrades to "everything in one group". Restore dedupe
  becomes per `(id, group)`.
- Only `file`/`diff` restore today, so a restored group 2 holding only non-restorable kinds is
  dropped. By I4 it simply isn't created.
- **Ratio:** a global setting `editorSplitRatio` (0–1, default 0.5, clamped [0.15, 0.85] on load),
  persisted like `leftWidth`/`rightWidth`.

### 3.4 Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Per-group tabs + active tab | `docsReducer` (all open/close/move paths) | center-pane, doc-tabs, all ~30 app.tsx readers, palette | yes |
| Active group | focus-in / pointer-down in a group, split/move actions | every "active doc" reader via the selector | yes |
| `docs.json` entries (+`group`) | `toPersistedDocs` → host `persistDocs` → `serializeDocs` | host `parseDocs` → `restoreDocs` → `restore` reducer | yes (host passes the field through; add it to the type) |
| Dirty baseline / dirty set | CodeViewer save + content change (per path) | tab dots in both strips, close-dirty prompt, LSP reconcile | yes |
| Reveal request | open routing (`setReveal`) | CodeViewer mount in the target group | yes |
| Cursor bus | CodeViewer | BreadcrumbBar, nav history (`currentEntry`) | yes |
| View state | each viewer on scroll/unmount | the same viewer, same group, on remount | yes |
| Closed-tab stack | tab close | reopen closed tab | yes |
| `editorSplitRatio` | divider drag/keys | group layout | yes |
| Web `<webview>` instance | center-pane web hosts | a moved web tab | yes (the "no reload on move" contract) |

No row has a producer out of scope.

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Split while the active doc is dirty | The duplicate shows the same unsaved buffer (shared model) and a dirty dot in both strips. |
| Close one of two tabs of a dirty doc | Closes silently. The other tab stays dirty. |
| Close the last tab of a dirty doc | The existing unsaved-changes prompt. Cancel keeps the tab (and group 2 if that was its last tab). |
| Save from group 1 while group 2 shows the same file | Both dots clear. Group 2's next edit dirties both again. |
| File changes on disk while open in both groups (clean) | Both views show the new content (one model). Dirty: the existing withhold rule, no clobber. |
| File deleted/renamed on disk | Same as today, applied to every tab of that doc in both groups. |
| Preview tab in G1, then the same file opened as preview in G2 | Two independent previews. Pinning one doesn't pin the other. |
| Split Right on a preview tab | The new G2 tab is **pinned** (VS Code pins on split). The G1 tab stays a preview. |
| Split Right on a `commit-diff` `@preview` slot | The slot is pinned first (re-keyed), then split. |
| Move a `web` tab | The page is not reloaded. Scroll, form state and history survive. |
| Move Review / History | The single instance moves. Review's anchor/folds/filter survive (its `view-state-store` entry follows the move). |
| Drop the only G2 tab onto G1 | G2 closes (I4). |
| Drag a tab onto its own group's body | No-op (the existing reorder rules apply within a strip). |
| Tab drag vs. panel re-dock drag vs. an explorer/OS file drag | Only a **tab** drag arms group strips, bodies and the edge zone. A panel dock drag keeps today's `.centerpane--droptarget` behavior. An explorer/OS file drop on a group body is out of MVP and behaves as today. |
| Tab drag cancelled (Esc / dropped outside) | No change. Overlays clear. |
| Session switch or Board/Canvas switch mid-drag | The drag is abandoned. A drop after the switch is a no-op: no tab moves between sessions. |
| Session split pane (`splitId`) + editor split | Independent. G1 showing the Terminal shows the two-terminal split inside G1's width. |
| Center narrower than 2 × min width | See §2.6 "narrow". Divider drag is clamped so neither side goes below min when there is room. |
| Window resize | Ratio preserved. |
| Rapid Split Right presses | Idempotent after the first (the second press hits the cap no-op or activates the existing tab). |
| Nav history Back to an entry whose doc is open in both groups | Lands in the **active** group's tab. If it's only open in the other group, that group is focused. If it isn't open, it opens in the active group. |
| Session with zero docs + split | Impossible: G2 is never empty. |
| Restore finds G2 docs whose session didn't restore | Dropped (existing orphan rule). |
| Multiple Conduit windows | Unchanged known limitation: the last `persistDocs` wins. |
| Group 2 switches away from (or moves, or closes) a file that group 1 also shows | Auto-save's `viewLeave` fires for that path when that group's editor unmounts. Under afterDelay / onFocusChange the file saves, even though group 1 still shows it. This is defined behaviour: `viewLeave` is per editor view, not per path. |
| Two PDFs (or the same PDF) visible at once | Each viewer passes the shared `PDFWorker` explicitly (CLAUDE.md gotcha). Destroying one loading task must not break the other. This needs a check (D8). |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Split ratio | 0.5, persisted after drag | yes (implicit, by drag) | Same as the panel widths. |
| Group min width | 240px | no | Keeps a strip plus some code legible. Constant in code. |
| Split Right keybinding | `Mod+\` | rebindable (Settings → Shortcuts) | VS Code parity, and it's free. |
| Focus left/right group | No default combo. Palette commands, rebindable (D3). `Ctrl+1…9` untouched. | rebindable | `Ctrl+1/2` is taken by `navGoToTab`. |
| Move tab to other group | `Mod+Alt+ArrowRight` / `Mod+Alt+ArrowLeft` | rebindable | VS Code's "move editor into next/previous group". |
| Open target while G1 shows the Terminal | Group 2 | no | Keeps the agent terminal visible (D5). |
| Layout scope | per session | no | Matches doc ownership. |
| Split-on-preview pins | yes | no | VS Code parity. |

## 6. Scope slicing

- **MVP (must):** the §3.1 reducer + selector with I1–I7; two strips + divider (mouse + keyboard,
  persisted ratio); Split Right via key / context menu / strip button; Move to Other Group via
  context menu + key; active group by focus; §2.5 routing for opens, Monaco nav and tab commands;
  §3.2 shared dirty/save/reveal/cursor; close-last-closes-group; Close Editor Group; persistence
  (§3.3); a web tab moves without reloading; Review/History move.
- **v1 (should):** drag between strips and drag to the right edge; Join Editor Groups; reopen
  closed tab into its original group; Ctrl-drag duplicates.
- **Vision (could):** explorer/OS file drop onto a group; "Open to the Side" (`Ctrl+Enter` in quick
  open, Alt+click in the explorer); a per-session ratio.
- **Out of scope:** vertical/grid splits, >2 groups, splitting the Terminal, a Files-explorer
  active-file highlight, multi-window docs.json.

## 7. Acceptance criteria

All criteria can be observed through `test/e2e/harness.mjs` (hidden app, real input). Suggested
scenario: `test/e2e/split-editor.e2e.mjs`, with a temp git repo holding `a.ts`, `b.ts`,
`note.md`, and `b.ts` importing a symbol from `a.ts`.

### EARS

- **E1.** When the user presses `Mod+\` with a file tab active in a single group, the center pane
  shall show two `.editor-group` elements side by side, each with its own tab strip, the right one
  containing that file's tab as its active tab, and the right group shall be active
  (`data-active="true"` on the right `.editor-group`, absent on the left).
- **E2.** While the same file is open in both groups, typing in one group shall show the typed
  text in the other group's editor, and both tabs shall show the dirty dot. After `Mod+S` both
  dots shall clear.
- **E3.** While the same file is open in both groups, scrolling one editor shall not change the
  other editor's scroll position.
- **E4.** When the user clicks into the left group's editor and triggers Go to Definition on a
  symbol defined in another file, the target file shall open in the **left** group at the
  definition line, and the right group's active tab shall be unchanged.
- **E5.** When a file is opened from the explorer while the right group is active, it shall
  open in the right group. While the left group's active tab is the Terminal and a right group
  exists, it shall open in the right group.
- **E6.** When the last tab of the right group is closed, the center pane shall show a single
  group at full width, and the left group shall be active.
- **E7.** If the user closes one of two tabs of a dirty file, then no unsaved-changes prompt shall
  appear, and the remaining tab shall stay dirty.
- **E8.** When the user drags the divider (or focuses it and presses ArrowLeft ×N), the group
  widths shall change, neither group shall go below 240px while the center pane is ≥ 480px, and
  after a restart the ratio shall be the same (±1%).
- **E9.** When the app restarts with a split open (on the same user-data dir), the session shall
  restore both groups with the same tabs **in the same order**, the same active tab per group, and
  the same file shown in both groups where it was.
- **E10.** When a web tab is moved to the other group, the page shall not reload (a
  `window.__marker` set in the guest before the move is still present after it).
- **E11.** `Ctrl+W`, `Ctrl+Tab` and `Ctrl+2` shall act only on the active group's tabs.
- **E12.** Split Right on the Terminal tab shall be disabled in the context menu. With the Terminal
  tab active and focus **outside** xterm (e.g. on the strip), `Mod+\` shall change nothing. With
  focus **inside** xterm, `Ctrl+\` keeps today's routing to the PTY (0x1C) and splits nothing: a
  terminal owns its keys, per `decide-shortcut.ts`.
- **E15.** Close one of two tabs of a file, then press `Mod+S` / `Alt+F5` in the surviving tab:
  the save and change navigation work (the §3.2 registry contract).
- **E16.** With `x.ts` pinned in the right group and a preview in the left group, single-clicking
  `x.ts` then `y.ts` in the explorer while the left group is active retargets only the left preview.
  The right `x.ts` tab stays (I8).
- **E13.** While the right group is active, Split Right shall be disabled, and the key shall
  announce "Only two editor groups are supported" in the polite live region.
- **E14.** With a single group, every existing e2e (editor-preview-tabs, editor-tabs-persist,
  editor-nav-history*, middle-click-*, goto-matrix*) shall pass unchanged. This is I7 at the app
  level.

### Gherkin (key flows)

```gherkin
Feature: Split editor
  Background:
    Given a session on a temp repo with a.ts and b.ts
    And b.ts is open and active

  Scenario: Split and edit the same file in both groups
    When I press Mod+\
    Then two editor groups are visible and the right one is active
    When I type "X" at the top of the right editor
    Then the left editor's first line starts with "X"
    And both b.ts tabs show the unsaved dot
    When I press Mod+S
    Then neither b.ts tab shows the unsaved dot

  Scenario: Navigation lands in the focused group
    Given the editor is split with b.ts in both groups
    When I click into the left editor on the imported symbol and press F12
    Then a.ts is the active tab of the left group
    And the right group's active tab is still b.ts

  Scenario: Split survives restart
    Given the editor is split with a.ts left and b.ts right
    When I close and relaunch Conduit on the same user-data dir
    Then two groups are shown with a.ts left and b.ts right
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Editor group | Active | Its strip's active tab uses the full active treatment, plus a thin accent rule on the strip's bottom edge | — |
| Editor group | Inactive | Active tab dimmed (the inactive-selected treatment). No accent rule. | Click to focus |
| Editor group | Loading (file read pending) | The existing per-viewer loading state, inside that group only | — |
| Editor group | Viewer error (missing file / corrupt PDF / diff error) | The existing per-viewer error state, confined to its group. The other group is unaffected. | Existing retry |
| Split button (strip) | Enabled / disabled (Terminal active, or at cap) | Icon button. Disabled is dimmed with a reason tooltip. | Split Right |
| Divider | Rest / hover / dragging / focused | A hairline. Hover/drag shows the accent handle. Focus shows a visible ring. | Drag / arrow keys |
| Drop overlay (v1) | Drag in progress: strip insert / body / right-edge half | The insert marker (existing `tab--dropbefore`) / a whole-group tint / a right-half tint | Drop |
| Drop overlay (v1) | Drag cancelled / switched away | Overlays cleared, nothing moved | — |
| Right group | First-run / empty | Not possible (I4). | — |
| Narrow | Groups < min | Both shrink, the strips overflow into the existing chevron | — |
| Offline / permission | n/a | Local-only feature. | — |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Group | focus | pointer-down anywhere in the group | `Mod+Alt+ArrowLeft/Right` moves the tab; focus group via palette "Focus Left/Right Editor Group" (D3) | tap = focus | — | `role="group"`, `aria-label="Left editor group"` / `"Right editor group"`, active marked with `data-active` + the label suffix ", active" |
| Tab | split, move, close, pin, reorder | drag within/between strips; drag to the right edge (v1) | existing tab keys; `Mod+\`; `Mod+Alt+Arrow` | — | + "Split Right", "Move to Other Group" (enabled per §2.3) | existing `role="tab"` plus a **new** `role="tablist"` per strip, labelled by group, holding only the doc tabs. The Terminal is a plain button beside G1's tablist, not a tab (amended in the review round). |
| Split button | Split Right | click | Tab-reachable, Enter/Space | tap | — | `aria-label="Split editor right"`, `aria-disabled` + title reason |
| Divider | resize | drag | focusable; ArrowLeft/Right ±16px, Shift ±64px, Home/End to min/max | drag | — | `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow` (percent), label "Resize editor groups" (mirrors `git-history-view` `gh__resizer`) |
| Right strip background | Close/Join group | right-click | via palette | long-press n/a | "Close Editor Group", "Join Editor Groups" (v1) | — |
| Palette | Split Editor Right, Move to Other Group, Focus Left/Right Editor Group, Close Editor Group, Join Editor Groups | — | — | — | — | — |

The drag alternatives are the menu item plus the keyboard move, which satisfies WCAG 2.5.7.

**Naming vs. the session split:** the new commands all say "Editor Group" or "Split Editor".
The existing "Split with: X" / "Close split pane" keep their names (D7).

## 10. Accessibility & i18n (UI)

- Every action is keyboard-operable (§9). Focus is visible on the divider, the split button, and
  the tabs in both strips, and it holds up in forced colors.
- Accessible names: groups, the split button, the divider, and one tablist per strip.
- Live region (the existing `navLiveRef` polite region): announce "Split editor: <title> opened
  in right group", "Moved <title> to left group", "Editor group closed", and the cap message.
- The active group is never signalled by color alone: the accessible name suffix plus the accent
  rule's thickness (a shape, not only a hue).
- Focus management: after a split or move, focus goes into the target group's viewer. After a
  group closes, focus goes to group 1's active viewer (or its tab if the viewer isn't focusable).
- Reduced motion: no animated divider or tab travel. The drop overlays are static tints.
- **i18n:** Conduit has no i18n framework. User-facing strings are collected in a module-level
  `STR` object per component (the `git-history-view` precedent), not inlined in JSX. Pluralize
  "N editors" with `countNoun`. Labels must tolerate +30%: the strip button is icon-only, and the
  menu labels are free width. RTL: not supported app-wide. "Split Right" is a physical-direction
  command (VS Code parity) and would not mirror.

## 11. Design tokens (UI)

- The active-group rule uses `--accent`. The inactive-group active tab uses the existing
  inactive/muted tab token from the interaction-state vocabulary (`quiet` role, `selected` rung).
  No new hex.
- The divider uses the existing hairline/border token, with `--accent` on hover/drag/focus
  (matching the panel resizers).
- Drop overlays use the existing `--accent` at the tint alpha used by `.centerpane--droptarget` /
  `.tabbar__tail--over`.
- Checked in all three themes (Neon, Aero, …) via `npm run shots`. The strip button inside
  `.topbar`'s rect needs no special handling (the center strips are not in the top bar). Any
  overlay on Monaco must clear Monaco's own z-index values (CLAUDE.md, `.minimap{z-index:5}`).
  The edge-zone overlay is a new floating layer over Monaco.

## 12. Assumptions

- A1. Layout is per session (§2.2), because docs are session-owned.
- A2. The Terminal pseudo-tab stays in group 1 only. The session split pane is the terminal-split
  story.
- A3. "Open in the active group" is VS Code parity. The Terminal exception (D5) is the only
  deviation.
- A4. `DOCS_VERSION` stays 1. Adding an optional field plus duplicates is downgrade-safe (§3.3).
- A5. The ratio is global, not per session.
- A6. Group min width is 240px.
- A7. Ctrl-drag duplicate, Join, and edge drag-to-split are v1, not MVP.
- A8. The explorer has no active-file highlight to retarget (measured by grep, §2.1).

## 13. Decisions Needed

- **D1 [high]** A second concurrent CodeViewer on one path breaks dirty/save/reveal/nav/breadcrumb
  (§3.2). This is inferred from the source and `ASSUMED`; runtime has not been measured. **Default:**
  treat it as true. The first build slice reproduces it with a two-viewer unit or e2e before any
  fix, and §3.2's contract is the fix target either way.
- **D2 [high]** The data model shape: a doc registry plus per-group tab refs (§3.1), versus
  duplicating `OpenDoc` per group with a group-qualified id. **Default:** registry + tab refs. It
  keeps one identity for ownership, dirty and persistence, and makes I7 (zero change for single
  group) checkable. The alternative touches every id consumer.
- **D3 [normal]** Group focus keys: `Ctrl+1/2` (VS Code) collide with `navGoToTab`. **Default:**
  keep `Ctrl+1…9` as go-to-tab (scoped to the active group), and give focus-group palette commands
  no default binding. The user can bind them. The alternative (steal `Ctrl+1/2`) breaks a shipped
  binding.
- **D4 [normal]** The move-tab keys `Mod+Alt+ArrowLeft/Right`. They haven't been checked against
  Monaco's editor keybindings, terminal passthrough, or the Windows GPU-driver screen-rotation
  hotkey (`Ctrl+Alt+Arrow`). `Ctrl+Alt` is also AltGr on non-US layouts, and `Mod+\` needs AltGr
  on DE and similar layouts. **Default:** take them. The context menu and palette are the
  guaranteed non-US-layout path. The planner verifies there is no Monaco/xterm collision (falling
  back to palette-only if one exists).
- **D5 [normal]** Opens while group 1 shows the Terminal target group 2 (keeps the agent
  visible). This deviates from VS Code's "active group". **Default:** target group 2.
- **D6 [normal]** Review mode is on when Review is visible in **either** group, not only the
  active one. **Default:** either group.
- **D7 [normal]** Two features both called "split" (the session split pane vs. the editor split).
  **Default:** keep both, and use "Editor Group" wording for the new one. A rename of the old one
  is a separate call.
- **D8 [normal]** Two PDF viewers mounted at once share one `PDFWorker`. It is unverified whether
  one viewer's `task.destroy()` harms the other. **Default:** allow PDFs in both groups, and the
  planner adds a two-PDF e2e (split a PDF, close one side, the other still renders plus a fresh PDF
  load succeeds).
- **D9 [normal]** Moving a web tab must not reload it (§2.3, E10). That rules out naive
  reparenting of `<webview>` (a reload on reparent is `ASSUMED`, not measured). **Default:** keep
  the contract. If the only feasible mechanism reloads, the planner surfaces it rather than
  shipping a silent reload.
