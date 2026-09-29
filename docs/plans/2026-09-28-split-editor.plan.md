# Split editor — implementation plan

**Spec:** `docs/specs/2026-09-28-split-editor.md`  **Tier:** FULL

Triage: FULL. It adds a new state seam (per-session editor groups in the docs reducer), a new
persisted field, a new setting, a new layout component family, and it retargets ~30 app readers
and every path-keyed viewer registry. The spec is FULL.

**Build order:** this item builds after these three have merged. Anchors below are from `beb4253`;
find code **by name**, not by line.
- `auto-save` (`docs/plans/2026-09-28-auto-save.plan.md`)
- `changes-active-highlight` (`docs/plans/2026-09-28-changes-active-highlight.plan.md`)
- `tree-chevrons` (`docs/plans/2026-09-28-tree-chevrons.plan.md`)

**Preconditions (Task 1.1 checks these first):** `webview/file-saves.ts`,
`webview/file-save-controller.ts` and `webview/active-target.ts` exist. `grep -rn "registerSave(" webview`
shows only `webview/file-saves.ts`, and `code-viewer.tsx` has no `baselineRef`. If any of these
fail, stop and report: the dependency hasn't merged.

## Goal

Up to two editor groups (left and right) per session. Each group has its own tab strip and active
tab, and exactly one group is active. The active group feeds every "active tab" consumer. A path
open in both groups shares one buffer, and each group keeps its own view state.

## Architecture

**The group model is symmetric and lives in the docs reducer** (architecture-critic blocker 1,
locked by the conductor).
- `docs[]` is the doc registry: identity, ownership, title and kind fields. Its order means
  nothing: it is append order and is never used as tab order.
- `layouts[sessionId]` holds one or two `EditorGroup`s. Each group has its own ordered tab refs
  (with a per-tab `preview` flag) and an `active` tab, where `null` is the Terminal (group 1 only).
  The layout also records `activeGroup`.
- `layouts` replaces `activeBySession`. `OpenDoc.preview` is removed, so the compiler finds every
  preview reader.
- `activeId` stays a stored field, but it is only a **cache**. It is written only by `finalize()`
  and always equals the shown session's active group's active tab. Every existing reader of
  `docState.activeId` is therefore already correct.
- Every reducer case goes through `groups[g]`. There is no `if (split)` fork.

**I7 is guarded by the existing suite.** `docs.test.ts` gets an accessor-only rewrite, and its
expected literals are unchanged (the reviewer diffs it). `doc-groups.test.ts` then runs the same
core behaviours again in split mode, parametrised over the group.

**Viewers learn their group from a React context.** `EditorGroupContext` defaults to group 1.
Registries that assumed one viewer per path become multi-entry per path through one shared
primitive, `createPathRegistry`. Lookups prefer the requested group.

**Saving is already per-path.** The auto-save store (`fileSaves.attach` is idempotent per path)
owns the baseline and the one save registration, so this plan adds nothing to saving. It only gates
`fileSaves.dispose` / save-on-close on the doc's **last** tab.

**Web tabs never reparent (D9).** `.editorgroups` is one CSS grid whose columns come from the
split ratio. Each group's strip and body sit in rows 1 and 2 through `subgrid` (Electron 43). Every
`.webhost` is a **direct child of that grid for its whole life**, placed in the body row of its
group's column by `data-group`. Moving a web tab changes an attribute, never the parent, so the page
never reloads. No rects are measured. `.editorgroups` has `isolation: isolate`, so the hosts'
z-index (above Monaco's `.minimap{z-index:5}`) stays inside it.

## Data flow

```
user input (tab click / key / menu / drag / focus-in)
   │ app.tsx handlers ── dispatchDocs({type, …, group?}) ──▶ docsReducer  [webview/docs.ts]
   │                                                           │ docs[] = registry (order meaningless)
   │                                                           │ layouts[s] = { groups:[G1]|[G1,G2], activeGroup }, G = { tabs[{id,preview?}], active }
   │                                                           ▼ finalize(): collapse empty G2 · drop zero-tab docs · write activeId cache
   │     selectors [webview/doc-groups.ts]: groupDocs · groupActive · tabGroupsOf · openTargetGroup ·
   │                                        resolveActivateGroup · centerLayout
   ▼
app.tsx ── centerLayout(docState, session) ──▶ <CenterPane layout> ──▶ <EditorGroups>
   │                                               ├─ <EditorGroup group=1> DocTabs + .termwrap(terminals + DocView)
   │                                               ├─ divider (editorSplitRatio) ── update({editorSplitRatio}) ─▶ settings.json
   │                                               ├─ <EditorGroup group=2> DocTabs + DocView
   │                                               └─ every .webhost: a direct grid child, placed by data-group (never reparented)
   │                                                     (EditorGroupContext.Provider value=group around each body)
   ▼
viewers (CodeViewer / MarkdownViewer / DiffViewer / Review / History / Html / Plan)
   ├─ useEditorGroup() → registerNavEditor/registerSelection/registerChangeNav(path, …, group)
   ├─ takeReveal(path, group) · publishCursor({path, offset, group}) → BreadcrumbBar (same group)
   ├─ view-state key = tabStateKey(doc.id, group)   (G1 key === doc.id → today's key)
   └─ fileSaves.attach(path) (idempotent, per path: shared baseline, dirty, save entry)
Monaco navigation: openCodeEditor(source, …) → groupOfEditor(source) → openDefinitionFile(abs, pos, group)
   → app openFile(…, {reveal, group}) → setReveal(path, pos, group) + dispatch open {group}
toPersistedDocs → persistDocs (+group:2 entries) → host serializeDocs → docs.json → parseDocs (validates group) → restore
```

## Settled decisions — do not re-litigate

- D1: two concurrent viewers on one path break the path-keyed registries. Treat it as true, and
  reproduce it red before the fix (Task 2.1).
- D2: one doc registry plus per-group tab refs (not a duplicated `OpenDoc` per group).
- D3: focus-group commands are palette-only with no default binding, and they are rebindable.
  `Ctrl+1…9` stays go-to-tab, scoped to the active group.
- D4: `Mod+Alt+ArrowLeft/Right` moves the tab. Measured, no collision:
  - Monaco 0.55.1 has no Windows/Linux default for `Ctrl+Alt+Left/Right`. The only match is the
    mac-only `WinCtrl+Alt` word-part binding (`wordPartOperations.js` L75/L116).
  - It has no binding for plain `Ctrl+\`; `Ctrl+Shift+\` is jumpToBracket.
  - xterm gets every non-reserved key through the capture handler (`app.tsx` onKeyCapture).
- D5: while group 1 shows the Terminal and group 2 exists, opens target group 2.
- D6: Review mode is on while Review is the visible tab of **either** group.
- D7: new wording is "Editor Group" / "Split Editor". The session split pane keeps its names.
- D8: PDFs are allowed in both groups. A two-PDF e2e is added (Task 5.3).
- D9 (conductor ruling): prefer a web-tab move that doesn't reload. The web-layer approach below
  never reparents. If E10 nevertheless shows a reload, ship it, and record it in `CHANGELOG.md` and
  in the run report. It is not a blocker.
- Spec §5 defaults: ratio 0.5, clamped [0.15, 0.85] on load; group min width 240 px; `Mod+\`
  splits; split-on-preview pins; layout is per session; the ratio is global.
- **P1 (conductor-locked, from the architecture critic):** symmetric state. It is
  `docs` + `layouts` + an `activeId` cache written only by `finalize()`. `OpenDoc.preview` is gone,
  and so is `activeBySession`. The persistence format is unchanged apart from `group?: 2`, and
  single-group output is byte-identical to today's.
- **P1b (plan):** foreground ownership transfer **appends** the tab to the new owner's target group.
  Today it kept its interleaved `docs[]` index, which was an artefact of the shared array. If a
  `docs.test.ts` literal encodes the old position, stop and report; don't change the literal.
- **P7 (conductor):** web hosts are placed by the CSS grid from the same ratio as the groups, and
  never reparented or measured. `.editorgroups` has `isolation: isolate`.
- **P8 (conductor):** edit-promotes-preview is per tab. A dirty path pins **every** preview tab of
  that path in either group (`pinDoc {id, group}`).
- **P9 (conductor):** auto-save's `viewLeave` fires when a group stops showing a file (tab switch,
  move, close), even while the other group still shows it. Under `afterDelay` / `onFocusChange`
  that saves. This is defined behaviour: recorded in spec §4 and covered in T5.2's e2e.
- **P2 (plan):** a default target group is resolved in **one** function, `openTargetGroup`, which
  the reducer uses when an action omits `group`. `app.tsx` calls the same function to stage the
  reveal for the same group.
- **P3 (plan):** there is no `closeGroup` reducer action. Close Editor Group is an app loop over
  group 2's tabs through the per-tab close (prompts included), and I4 collapses the group once it
  is empty. A reducer action would have no caller.
- **P4 (plan):** a tab moved between groups arrives **pinned**, like split-on-preview. A
  `commit-diff` `@preview` slot is re-keyed to its pinned id first (spec §2.3).
- **P5 (plan):** the view-state key for a tab is `tabStateKey(docId, group)`, which is `docId` for
  group 1 and `g2:${docId}` for group 2. Group 1's keys are therefore byte-identical to today's.
- **P6 (plan):** user-facing strings live in one module, `SPLIT_COPY` (`webview/split-editor-copy.ts`),
  following the `AUTO_SAVE_COPY` precedent rather than a per-component `STR`. Logged as Decisions
  Needed #6.

## Spec staleness

- **S1.** Spec §3.4 says "Cursor bus → nav history (`currentEntry`)". That's false: `currentNavEntry`
  (`webview/app.tsx` ~2810) reads `liveCursor` from `webview/nav-editors.ts`, not the cursor bus.
  Only `breadcrumb-bar.tsx` subscribes to `subscribeCursor`. The plan makes `liveCursor` group-aware
  (Task 2.1) and the cursor bus group-tagged for breadcrumbs (Task 2.2).
- **S2.** Spec §3.2 says "`save-registry` becomes multi-entry". This is superseded by auto-save,
  where the store registers once per path through the idempotent `attach`, and the baseline is per
  path in the store. The plan makes no `save-registry` change; E15 proves the save half.
- **S3.** Spec §3.1 says "`tab-overflow.ts`: `data-tabid` must be unique per strip; query within
  the strip". Already true: the queries are scoped to `stripRef.current`
  (`webview/components/doc-tabs.tsx` ~90, ~138), and `tab-overflow.ts` is pure. No change.
- **S4.** Spec §3.2 says "check `review-note-target`, `mention-bus`". Neither is path-keyed; each is
  a single slot (`webview/review-note-target.ts`, `webview/mention-bus.ts`). Last-set-wins is correct
  for both. No change.
- **S5.** Spec §2.1 "View state is keyed by `OpenDoc.id`" is partly false: `markdown-viewer.tsx`
  keys its scroll by `` `file:${doc.path}` `` (~818/834), and `code-viewer.tsx` defaults `vsId` to
  `` `file:${doc.path}` ``. For group 1 those equal `doc.id`. The plan passes `tabStateKey` explicitly
  to both (Task 2.4).
- **S6.** Spec §2.1 describes the tab-menu closes as "filter `docState.docs` by path". That's true,
  and it is a pre-existing cross-session bug: it matches other sessions' tabs and file+diff tabs that
  share a path. Task 3.2 replaces it with ids from the right-clicked tab's group.
  `closeTabSelection` is generic over strings, so its signature is unchanged.
- **S7.** Spec D9 says "reparenting reloads (`ASSUMED`)". The plan never reparents, so this isn't
  measured. The `.webhost` layers are already `position:absolute; inset:0` (`webview/styles.css`
  ~12611). The plan replaces that absolute placement with grid placement in `.editorgroups`
  (P7).

## Global constraints

- **Gate:** `npm run verify`, run once before handoff through the heavy-lock wrapper the pipeline
  provides. Write its output to `%TEMP%\claude-scratch\split-verify.log` and read the exit code from
  `$LASTEXITCODE`. Never pipe it through `tail`, `Select-Object` or a pager. Never disable, narrow or
  defer a check.
- **Inner loop per task:** `npx vitest related <touched files> --run` + `npm run typecheck` (checks
  both tsconfigs; `test/` is in the host one).
- **e2e:**
  - Always `npm run build` first. Then run only the scenarios a slice's Check names, each **alone**
    and serially, with `node test/e2e/run-smoke.mjs <term>` (a substring filter).
  - Never the full suite.
  - A PTY-looking failure is re-run alone on a quiet machine before anyone believes it.
  - Never kill processes by name.
- **Regression set:** these five spec E14 suites are the "touched" set for Slices 1–5. Run each with
  the one-off script (see Scripts), one term per invocation:
  - `editor-preview-tabs`
  - `editor-tabs-persist`
  - `editor-nav-history` (3 scenarios)
  - `middle-click` (5)
  - `goto-matrix` (5)
- **Scratch:** everything goes in `%TEMP%\claude-scratch\`. In Bash, use the literal expanded path,
  never `$env:TEMP`. Delete it before handoff.
- **Naming and placement:**
  - Files are kebab-case `.ts`/`.tsx`. Components are PascalCase functions in
    `webview/components/<kebab>.tsx`. Pure modules sit in `webview/` beside their siblings.
  - Unit tests are `test/unit/<module>.test.ts` (vitest, node env). Monaco-importing modules are
    tested with `vi.mock('monaco-editor', …)`, as `test/unit/nav-editors.test.ts` does.
  - e2e scenarios are `test/e2e/<name>.e2e.mjs` on `test/e2e/harness.mjs`.
- **Comments:** WHY only. A decision recorded here or in the spec gets a one-line pointer
  (`// see split-editor spec §3.1 I8` / `// see docs/plans/2026-09-28-split-editor.plan.md P1`),
  never a re-explanation.
- **CI portability:** CI runs on ubuntu. No `\` paths, drive letters or `process.platform` in unit
  tests; use POSIX fixture paths as `docs.test.ts` does.
- **CSS:**
  - Tokens only: `--accent`, `--border`, `--border-2`, `--raise`, `--elev-1`, `--state-sel-bg`,
    `--state-sel-fg`, `--state-sel-hover-bg`, `--text-dim`, `--focus-ring-color`.
  - No raw colours, no `!important`, no specificity escalation, no bare generic class names (Monaco
    cascade gotcha).
  - Any layer painted over Monaco sits above `.minimap{z-index:5}`.
  - Every new interactive element joins the interaction-state vocabulary section at the foot of
    `webview/styles.css`; `test/unit/state-vocabulary.test.ts` enforces it.
- **Renderer guards:** nothing here touches `window.agentDeck` beyond the existing `post` calls.
- **Deviation rule** (below) applies to every task.

## Out of scope

- Vertical or grid splits, more than two groups, splitting the Terminal, multi-window docs.json.
- Explorer/OS file drops onto a group and "Open to the Side" (spec Vision).
- A per-session ratio.
- Renaming the session split pane (D7).
- Fixing the host's `parseDocs` dropping non-file/diff kinds (S7 in the spec; pre-existing).
- A Files-explorer active-file highlight; changes-active-highlight owns that, fed by `activeId`,
  which already tracks the active group.

## Contracts

### Group model — `webview/doc-groups.ts` (new)

```ts
import type { DocKind, DocsState, OpenDoc } from './docs';

export type GroupIndex = 1 | 2;
export interface Tab { id: string; preview?: true }
/** `active === null` is the Terminal, legal in group 1 only (I5). */
export interface EditorGroup { tabs: readonly Tab[]; active: string | null }
export interface SessionLayout {
  groups: readonly [EditorGroup] | readonly [EditorGroup, EditorGroup];
  activeGroup: GroupIndex;
}
export const EMPTY_LAYOUT: SessionLayout; // { groups: [{ tabs: [], active: null }], activeGroup: 1 }

/** How Split Right / a cross-group open treats a kind (spec §2.3). */
export type SplitBehavior = 'duplicate' | 'move';
export function splitBehavior(kind: DocKind): SplitBehavior; // web/review/git-history → 'move'

// Slice 1 (reducer, toPersistedDocs, app.tsx preview readers, CenterPane → DocTabs are the callers)
export function layoutOf(state: DocsState, sessionId: string): SessionLayout; // EMPTY_LAYOUT when absent
export function groupDocs(state: DocsState, sessionId: string, group: GroupIndex): OpenDoc[];
export function groupActive(state: DocsState, sessionId: string, group: GroupIndex): string | null;
export function tabPreview(state: DocsState, sessionId: string, group: GroupIndex, id: string): boolean;
export function previewIdsOf(state: DocsState, sessionId: string, group: GroupIndex): ReadonlySet<string>;
export function openTargetGroup(state: DocsState, sessionId: string): GroupIndex;
export function resolveActivateGroup(state: DocsState, sessionId: string, id: string | null): GroupIndex;
/** Every preview tab, in any session and either group, whose doc is a file/diff on a dirty path (P8). */
export function dirtyPreviewTabs(
  state: DocsState, dirty: ReadonlySet<string>,
): readonly { id: string; group: GroupIndex }[];

// Slice 3 (app.tsx is the first caller)
export function tabGroupsOf(state: DocsState, id: string): GroupIndex[];
export function activeGroupOf(state: DocsState, sessionId: string): GroupIndex;

// Slice 4 (app.tsx → CenterPane is the first caller)
export interface GroupView {
  group: GroupIndex;
  docs: OpenDoc[];
  activeDocId: string | null;
  previewIds: ReadonlySet<string>;
}
export interface CenterLayout { groups: readonly GroupView[]; activeGroup: GroupIndex }
export function centerLayout(state: DocsState, sessionId: string | undefined): CenterLayout;
```

Semantics:
- **`groupDocs`:** the group's tabs, mapped to their registry docs **by reference**, in tab order.
  An absent group gives `[]`.
- **`groupActive`:** `layoutOf(…).groups[g-1]?.active ?? null`.
- **`tabPreview` / `previewIdsOf`:** read the tab's `preview` flag.
- **`openTargetGroup`:**
  - one group → 1
  - `activeGroup === 1` with group 1's active `null` (Terminal) and two groups → 2 (D5)
  - otherwise → `activeGroup`
- **`resolveActivateGroup`:**
  - `id === null` → 1
  - a tab in the active group → the active group
  - else the group that holds it
  - held nowhere → the active group
- **`tabGroupsOf`:** the groups of the doc's **owning** session that hold a tab for `id`, in
  1, 2 order. An unknown id gives `[]`.
- **`activeGroupOf`:** `layoutOf(…).activeGroup`.
- **`centerLayout`:** an `undefined` session gives
  `{ groups: [{ group: 1, docs: [], activeDocId: null, previewIds: new Set() }], activeGroup: 1 }`.

### `webview/docs.ts` changes

```ts
export interface OpenDoc { /* unchanged, MINUS `preview` */ }
export interface DocsState {
  docs: OpenDoc[];                              // registry; order carries no meaning
  layouts: Readonly<Record<string, SessionLayout>>; // replaces activeBySession
  activeId: string | null;                      // cache; written ONLY by finalize()
}
export const initialDocs: DocsState; // { docs: [], layouts: {}, activeId: null }
// DocsAction (every new field optional on existing actions):
//   open           { …, group?: GroupIndex }
//   openCommitFile { …, group?: GroupIndex }
//   openReview     { …, group?: GroupIndex }
//   close          { id; group?: GroupIndex }   // group ⇒ close THAT tab; absent ⇒ remove the doc (every tab)
//   activate       { id; sessionId?; group?: GroupIndex }
//   pinDoc         { id; group?: GroupIndex }
//   reorder        { dragId; targetId: string | null; group?: GroupIndex }
//   | { type: 'splitRight'; sessionId: string }
//   | { type: 'moveTab'; sessionId: string; id: string; toGroup: GroupIndex; beforeId?: string | null }
//   | { type: 'focusGroup'; sessionId: string; group: GroupIndex }
// Slice 6 adds: moveTab.duplicate?: boolean; moveTab creating group 2 (edge drop); { type: 'joinGroups'; sessionId }
export function backgroundOpenOutcome(
  state: DocsState, kind: DocKind, path: string, targetSessionId: string, diffScope?: DiffTabScope,
): BackgroundOpenResult; // signature unchanged
```

**`finalize(state, touched: readonly string[], focus: string | null): DocsState`** (private) is the
only writer of `activeId` and the only enforcer of I4/I6. It runs at the end of every case that
changed something. A no-op case returns the input `state` **by identity** and does not call it.
1. For each touched session: if group 2 has no tabs, drop it and set `activeGroup = 1` (I4).
2. Drop from `docs[]` every doc that no layout references (I6). The dirty prompt has already run in
   the app.
3. **`activeId`:**
   - `focus !== null` → the focus session's active group's active tab.
   - `focus === null` → keep `activeId` if some layout still has it as a tab. Otherwise use the
     active tab of the session that owned it (the shown session).
   - `closeSession` alone passes its own fallback. When `activeId` vanishes, it takes the active
     tab of the session that owns the **last** doc left in `docs[]` (today's behaviour, which the
     closeSession test pins), else `null`.

**Every case works on `groups[g]`, with no fork for split mode.** `s` is the action's session and
`g = action.group ?? openTargetGroup(state, s)`. "Falls back" always means: the left neighbour in
that group, else the right neighbour, else `null` for group 1 (the Terminal) or removing group 2
(I4).

- **open**, foreground (focus `s`):
  - **Ownership transfer:** if the doc is owned by another session, remove every tab of it from that
    session's layout (falling back its actives), set `sessionId = s`, and include that session in
    `touched` (I9). The tab is appended in `s` (P1b).
  - **A tab already in `groups[g]`** → activate it. A non-preview open clears the tab's `preview`.
    Apply `sideBySide` / `repoRoot` to the doc as today.
  - **The doc exists as a tab only in the other group of `s`:**
    - `duplicate` kind → append a tab in `g`, following the preview-slot rule below
    - `move` kind → remove it from the other group (falling back) and append it in `g`
  - **A new doc:** push it to `docs[]`.
    - With `mode: 'preview'` on a file/diff, where `groups[g]` already has a preview tab of a
      file/diff doc → replace that tab ref **at the same index**. The old doc survives if the other
      group still references it (I8 falls out of I6).
    - Otherwise append a tab. The tab's `preview` follows `mode`; only file/diff are previewable.
  - Set `groups[g].active = id` and `activeGroup = g`.
- **open**, background (focus `null`; `activeGroup` and the actives never change):
  - Doc owned by another session → pin its preview tabs there (no new tab), as today.
  - Tab in `groups[g]` → pin it.
  - A `duplicate` kind only in the other group → append a pinned tab in `g`.
  - A `move` kind only in the other group → pin it in place.
  - New → push it and append a pinned tab in `g`.
  - Unchanged → the same `state`.
- **`backgroundOpenOutcome`:** judged against `openTargetGroup(state, targetSessionId)` with the
  same rules:
  - pinning an existing preview → `'pinned'`
  - an existing tab that is already pinned → `'already-open'`
  - a new tab (including a duplicate into the target) → `'opened'`
- **openCommitFile:** the `commit-diff:@preview` slot stays one global doc.
  - The pinned id already exists → the foreground-open rules.
  - `permanent`:
    - The slot targets the same path → re-key the slot doc and **every** tab ref naming it, and
      clear the preview.
    - Otherwise → a new doc and tab.
  - `preview`:
    - The slot has a tab in `groups[g]` of `s` → retarget the doc in place (path and title); the
      tab doesn't move.
    - Otherwise → remove its tab from where it is (falling back), retarget it, and append a preview
      tab in `g` of `s`.
  - `background` → the background rules, with today's slot re-key.
- **openReview:** a `move` kind. The foreground-open rules plus today's `reviewSource`
  canonicalisation.
- **close:**
  - With `group`, when the doc has tabs in both groups → remove that tab only (falling back).
  - Without `group`, or when it's the doc's last tab → remove every tab of the doc (each group
    falling back).
  - Focus `null`.
- **closeSession:** remove the session's docs and `layouts[s]`. Uses finalize's closeSession
  fallback.
- **activate:**
  - `id === null` → `layouts[sessionId].groups[0].active = null` and `activeGroup = 1`, creating
    the layout if it's absent.
  - Else `g = group ?? resolveActivateGroup(state, owner, id)`. A no-op if the doc has no tab in
    `g`. Otherwise `groups[g].active = id` and `activeGroup = g`.
  - Focus is the owner, or `sessionId` for `null`.
- **switchSession:** focus `s`. This yields the Terminal (`null`) for a session with no layout.
- **pinDoc:**
  - `g = group ?? the first group of the owner holding a preview tab for id`.
  - file/diff → clear that tab's `preview`.
  - commit-diff slot → re-key it (or drop it onto an existing pinned doc) and rewrite the id in
    **every** layout's tabs and actives. `activeId` follows through finalize with focus `null`.
- **reorder:** `g = group ?? resolveActivateGroup(state, owner, dragId)`. Apply `moveBefore` over
  `groups[g]` tab ids (a `targetId` absent from the group means the end), and a dragged preview is
  pinned.
- **splitRight:** a no-op (same `state`) unless `activeGroup === 1` and `x = groups[0].active !== null`.
  - Pin `x`'s group-1 tab first if it's a preview (for the `commit-diff` slot, re-key as `pinDoc`
    does).
  - Create group 2 if absent.
  - `x` already in group 2 → activate it there.
  - Else, a `duplicate` kind → append a pinned tab.
  - Else (`move` kind) → remove it from group 1 (falling back) and append it.
  - `activeGroup = 2`. Focus `s`.
- **moveTab** (Slice 1 form):
  - A no-op unless `layouts[s]` has two groups and `id` is a tab in the group other than `toGroup`.
  - Remove the source tab (falling back).
  - If it's already in the target → activate it there. Else insert a **pinned** tab (P4) before
    `beforeId` (`null` or absent = end).
  - The target becomes active. Focus `s`.
- **focusGroup:** a no-op without that group or when it's already active. Otherwise set
  `activeGroup`. Focus `s`.
- **restore:** skip orphans (unknown session). Dedupe per `(id, group)`, first entry wins.
  - The first sighting of an id creates its doc (`initialTitle`, `diffScope`).
  - Each entry appends a tab to group `entry.group ?? 1` of its session, with `preview` from the
    entry, and `active` sets that group's active.
  - `activeGroup = 1`. `activeId = null`, as today (the app's following `switchSession` resolves it).
- **`toPersistedDocs`:** sessions in order of first appearance in `docs[]`. For each: group 1's
  tabs in order, then group 2's tabs with `group: 2`.
  - Each entry is `{ kind, path, sessionId, preview? (from the tab), diffScope?, active? (=== that group's active), group? }`.
  - The empty-target `commit-diff` slot is dropped, as today.
  - For a single-session state the output is byte-identical to today's. With several sessions the
    entries come grouped per session rather than interleaved, which restores the same thing
    (Decisions Needed #11).

### Persistence — `src/protocol.ts`, `src/persistence.ts`

- `PersistedDoc` gains `group?: 2`; the doc comment says "absent = group 1".
- `isRestorableDoc` rejects an entry whose `group` is present and `!== 2` (trust boundary).
- `DOCS_VERSION` stays 1.

### Registries — `webview/path-registry.ts` (new)

```ts
import type { GroupIndex } from './doc-groups';
export interface PathRegistry<T> {
  register(path: string, value: T, group: GroupIndex): () => void; // unregister removes THIS entry only
  get(path: string, prefer?: GroupIndex): T | undefined;             // prefer's entry, else most recently registered
  entries(path: string): readonly { value: T; group: GroupIndex }[];
}
export function createPathRegistry<T>(normalize?: (path: string) => string): PathRegistry<T>;
```

Consumers and their signature changes:
- **`selection-registry.ts`:**
  - `registerSelection(path, entry, group: GroupIndex = 1)`
  - `selectionInActiveDoc(docs, activeId, group: GroupIndex = 1)`
- **`change-nav-registry.ts`:**
  - `registerChangeNav(path, entry, group: GroupIndex = 1)`
  - `goToChangeInActiveDoc(docs, activeId, direction, group: GroupIndex = 1)`
- **`nav-editors.ts`** (normalize = `canonicalPath`):
  - `registerNavEditor(path, editor, group: GroupIndex = 1)`
  - `liveCursor(path, group?: GroupIndex)`
  - `revealInNavEditor(path, pos, group?: GroupIndex): boolean`
  - `requestNavFocus(path, group?: GroupIndex)`. `pendingFocus` becomes `{ path; group?: GroupIndex } | null`
    and matches only an editor registering in that group, when a group is given.
  - new `groupOfEditor(editor: unknown): GroupIndex | undefined`, an identity scan over entries
  - `lastCursors` stays per path

### Reveal, opener, cursor — `webview/project-index.ts`

```ts
export function setReveal(path: string, pos: CursorPos, group?: GroupIndex): void;
export function takeReveal(path: string, group: GroupIndex): CursorPos | undefined; // consumes only if staged group is undefined or === group
export function hasReveal(path: string, group?: GroupIndex): boolean;
export function setDefinitionOpener(fn: (absPath: string, pos: CursorPos, group?: GroupIndex) => void): void;
export function openDefinitionFile(absPath: string, pos: CursorPos, group?: GroupIndex): void;
export interface CursorEvent { path: string; offset: number; group: GroupIndex }
```

`peekReveal` and `clearReveal` keep their signatures.

### Group context — `webview/editor-group-context.ts` (new)

```ts
import type { GroupIndex } from './doc-groups';
export const EditorGroupContext: React.Context<GroupIndex>; // default 1
export function useEditorGroup(): GroupIndex;
export function tabStateKey(docId: string, group: GroupIndex): string; // group 1 → docId; 2 → `g2:${docId}`
```

### Stores (Slice 5)

- `view-state-store.ts`: `moveViewState(from: string, to: string): void` (moves and clears the
  tombstone of `to`), `copyViewState(from: string, to: string): void`.
- `html-view-store.ts`: `moveHtmlView(from: string, to: string): void` and
  `copyHtmlView(from: string, to: string): void`. Both notify subscribers.

### Split ratio — `webview/editor-split.ts` (new) and `src/settings.ts`

```ts
export const EDITOR_GROUP_MIN_PX = 240;
/** Clamp so neither side < min when width ≥ 2·min; below that return ratio unchanged (spec §2.6 narrow). */
export function clampSplitRatio(ratio: number, widthPx: number): number;
export function stepSplitRatio(ratio: number, widthPx: number, key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End', shift: boolean): number;
// ±16px, Shift ±64px; Home/End → min/max allowed ratio
```

`AppSettings.editorSplitRatio: number` is added with default `0.5`, coerced with
`clampNum(payload.editorSplitRatio, 0.15, 0.85, DEFAULT_SETTINGS.editorSplitRatio)` next to
`surfaceOpacity` (`clampNum` does not round). `resetLayout` in `webview/settings.tsx` restores it.

### Shortcuts — `webview/shortcuts.ts`

New `SHORTCUT_ACTIONS` entries in group `'Editor groups'`:

| id | defaultCombo |
|---|---|
| `splitEditorRight` | `'Mod+\\'` |
| `moveTabNextGroup` | `'Mod+Alt+ArrowRight'` |
| `moveTabPrevGroup` | `'Mod+Alt+ArrowLeft'` |
| `focusLeftGroup` | `''` |
| `focusRightGroup` | `''` |

- `matchCombo(e, '')` returns `false`.
- `formatCombo('')` returns `'Unassigned'`.

### Copy — `webview/split-editor-copy.ts` (new)

```ts
export const SPLIT_COPY = {
  splitRight: 'Split Right', splitButton: 'Split editor right', moveToOther: 'Move to Other Group',
  closeGroup: 'Close Editor Group', joinGroups: 'Join Editor Groups',
  focusLeft: 'Focus Left Editor Group', focusRight: 'Focus Right Editor Group',
  groupLabel: (g: 1 | 2, active: boolean) => `${g === 1 ? 'Left' : 'Right'} editor group${active ? ', active' : ''}`,
  tablistLabel: (g: 1 | 2) => `${g === 1 ? 'Left' : 'Right'} editor group tabs`,
  divider: 'Resize editor groups',
  capReached: 'Only two editor groups are supported.',
  terminalCantSplit: "The terminal can't be split into an editor group",
  splitOpened: (title: string) => `Split editor: ${title} opened in right group`,
  moved: (title: string, g: 1 | 2) => `Moved ${title} to ${g === 1 ? 'left' : 'right'} group`,
  groupClosed: 'Editor group closed',
} as const;
```

Each key is added by the first task that consumes it. The final shape is the block above.

### Layout components (Slice 4)

`CenterPane` props:
- **Removed:** `docs`, `activeDocId`, `previewIds` (Slice 1's pass-through), `flashTabId`
- **Added:**
  - `layout: CenterLayout`
  - `flashTab: { id: string; group: GroupIndex } | null`
  - `onFocusGroup(group: GroupIndex): void`
  - `onSplitRight(): void`
  - `splitDisabledReason: string | null`
  - `onGroupStripContextMenu?(e: React.MouseEvent, group: GroupIndex): void`
  - `editorSplitRatio: number`
  - `onSplitRatioCommit(ratio: number): void`
- **Group-aware callbacks:**
  - `onSelectDoc(id: string | null, group: GroupIndex)`
  - `onCloseDoc(id: string, group: GroupIndex)`
  - `onTabContextMenu?(e, doc, group)`
  - `onReorderDoc?(dragId, targetId, group)`
  - `onPinDoc?(id, group)`
- `onMoveTab(id: string, toGroup: GroupIndex, beforeId: string | null, duplicate: boolean): void`
  is added in Slice 6 (first caller there).

`DocTabs` props:
- **Slice 1 adds** `previewIds: ReadonlySet<string>`. It replaces the four `d.preview` reads,
  because `OpenDoc.preview` no longer exists.
- **Slice 4 adds:**
  - `group: GroupIndex`
  - `groupActive: boolean`
  - `showTerminal: boolean` (group 1 only)
  - `split: { disabledReason: string | null; onSplit(): void }`
  - `onStripContextMenu?(e: React.MouseEvent): void`
- **Unchanged:** `docs`, `activeId`, `terminalLabel`, `terminalIcon`, `onSelect`, `onClose`,
  `onTabContextMenu`, `onTerminalTabContextMenu`, `onReorder`, `onPinDoc`, `moveGrip`, `flashTabId`.

`EditorGroupPane` (`webview/components/editor-group-pane.tsx`). It is named `…Pane` because
`EditorGroup` is the state type in `doc-groups.ts`.
```ts
props: {
  group: GroupIndex;
  active: boolean;
  tabs: React.ReactNode;
  top?: React.ReactNode;
  children: React.ReactNode;
  onFocusGroup(g: GroupIndex): void;
}
```
- It renders `<section className="editor-group" role="group" aria-label={SPLIT_COPY.groupLabel(group, active)} data-group={group} data-active={active || undefined}>`.
- The section is a grid item spanning both rows of its column, with
  `grid-template-rows: subgrid`. Its strip goes in row 1 and its body in row 2.
- Inside: `{tabs}<div className="editor-group__body" tabIndex={-1}>{top}<EditorGroupContext.Provider value={group}>{children}</…></div>`.
- `onPointerDownCapture` and `onFocusCapture` → `onFocusGroup(group)`.

`EditorGroups` (`webview/components/editor-groups.tsx`):
```ts
props: {
  layout: CenterLayout;
  ratio: number;
  onRatioCommit(r: number): void;
  renderGroup(view: GroupView): React.ReactNode;           // returns an <EditorGroupPane>
  webDocs: OpenDoc[];
  webPlacement(id: string): { group: GroupIndex; visible: boolean } | null;
  renderWeb(doc: OpenDoc): React.ReactNode;
  onFocusGroup(g: GroupIndex): void;
}
```
- **Grid:** `<div className="editorgroups">` is a CSS grid with `grid-template-rows: auto 1fr`
  and `isolation: isolate`. Its columns are set inline from the ratio:
  - one group: `minmax(0, 1fr)`
  - two groups: `` `minmax(0, ${r}fr) auto minmax(0, ${1 - r}fr)` ``
  - Group 1 is in column 1, the divider in column 2, and group 2 in column 3 (placed by
    `[data-group]` rules).
- **Divider:** `<div className="editorgroups__divider" role="separator" aria-orientation="vertical" aria-valuenow={Math.round(ratio*100)} aria-label={SPLIT_COPY.divider} tabIndex={0}>`
  sits in column 2, spanning both rows.
  - Pointer drag uses the window-listener pattern from `git-history-view.tsx`'s `gh__resizer`. The
    live ratio is local state; it is clamped with `clampSplitRatio(ratio, grid.clientWidth)` and
    committed on release.
  - Keys go through `stepSplitRatio` and commit on each step.
- **Web hosts:** each is `<div key={doc.id} className="webhost" data-group={placement.group} hidden={!placement.visible}>`
  and is a **direct child of `.editorgroups` for its whole life** (D9, P7).
  - It sits in row 2 of its group's column (`.editorgroups > .webhost[data-group="2"] { grid-column: 3 }`).
  - It is never measured and never reparented.
  - `onFocusCapture` → `onFocusGroup(placement.group)`.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Per-group tabs/active/activeGroup | `docsReducer` (T1.2) | `app.tsx` selectors (T3.x), `centerLayout` → `CenterPane`/`DocTabs` (T4.x) | both |
| Tab preview flag (moved off `OpenDoc`) | reducer (`Tab.preview`) | `doc-tabs.tsx` (4 reads → `previewIds`), `app.tsx` ~2033 dirty-pins-preview effect and ~2321 Keep Open menu item. `test/unit/webview-guard.test.ts` also matches `.preview`, but it is not an `OpenDoc` read (verify during T1.2) | both (T1.2) |
| `activeBySession` (removed) | was the reducer | measured: no reader outside `webview/docs.ts` and `test/unit/docs.test.ts` (`grep -rn activeBySession webview src electron`) | both (T1.2) |
| `activeId` meaning (active group's active) | reducer | every `docState.activeId` reader in `app.tsx` (active-target, repo:context, palette editor cmds, save, nav) | producer; consumers are unchanged by design (P1). Measured: each reads "the doc the user is on" |
| `docs.json` `group` | `toPersistedDocs` (T1.2) → `persistDocs` → `electron/main.ts` `lastDocs` (stored unfiltered) → `serializeDocs` | `parseDocs`/`isRestorableDoc` (T1.3) → `restore` (T1.2) | both |
| Default open target | `openTargetGroup` | reducer `open*` default; `app.tsx` `openFile`/`openDiff` reveal staging (T3.1) | both |
| Reveal (group-tagged) | `app.tsx` `openFile`, `applyNav` (`setReveal`) | `code-viewer.tsx` mount + live subscription, `markdown-viewer.tsx` (`takeReveal`/`hasReveal`) | both (T2.2, T2.4, T3.1) |
| Definition opener group | `monaco-opener.ts` (`groupOfEditor(source)`), `ts-nav.ts` (editor in scope), `breadcrumb-bar.tsx` (context) | `app.tsx` `setDefinitionOpener` → `openFileRef` | both (T2.2, T2.4, T3.1) |
| Cursor bus (+group) | `code-viewer.tsx` `publishCursor` | `breadcrumb-bar.tsx` only (S1) | both (T2.2, T2.4) |
| Nav editor / live cursor | `code-viewer.tsx` `registerNavEditor` | `app.tsx` `currentNavEntry`/`applyNav`, `monaco-opener` | both |
| Selection / change-nav entries | `code-viewer.tsx`, `markdown-viewer.tsx` | `app.tsx` Mod+Shift+F seed, `nextChange`/`prevChange` action + palette | both |
| Save entry / dirty / baseline | `fileSaves` store (auto-save), per path | Ctrl+S, Save All, tab dots, close prompt | consumer gating only: `dispose` and save-on-close run on the **last** tab (T3.2). The store is unaffected by a second `attach` (idempotent; tested T2.1) |
| View state / HTML mode keys | viewers via `tabStateKey` (T2.4) | same viewer on remount; `app.tsx` toggles (T3.1), move/copy (T5.1) | both |
| Closed-tab stack (+group) | `app.tsx` per-tab close | `reopenClosedTab` | both (T3.2) |
| Background-open flash (+group) | `use-background-open-feedback.ts` `report` | `CenterPane` → the target group's `DocTabs` | both (T3.1, T4.4) |
| `editorSplitRatio` | divider (T4.4) → `update()` → host settings persist | `EditorGroups` layout; `resetLayout` | both |
| Web `<webview>` lifetime | `EditorGroups` grid (hosts are direct children, placed by `data-group`) | a moved web tab (E10) | both (T4.4, T5.3) |
| Auto-save `viewLeave` | `CodeViewer` unmount in one group | `fileSaves.trigger` (per path) | consumer only. P9: it saves under afterDelay / onFocusChange even while the other group shows the file (defined; e2e in T5.2) |
| Active doc for active-target | `activeId` | `activeTarget(activeDoc, centerView)` (changes-active-highlight) | producer only. `activeDoc = visibleDocs.find(id === docState.activeId)`, and `visibleDocs` still spans every session doc, so it resolves the active group's doc with no change |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `webview/doc-groups.ts` | create | group types, `splitBehavior`, selectors, `centerLayout` |
| `webview/docs.ts` | modify | symmetric `DocsState` (`layouts`, `activeId` cache); `OpenDoc.preview` removed; `finalize`; every case on `groups[g]`; new actions; `toPersistedDocs`/restore with `group` |
| `src/protocol.ts` | modify | `PersistedDoc.group?: 2` |
| `src/persistence.ts` | modify | `isRestorableDoc` validates `group` |
| `webview/path-registry.ts` | create | multi-entry per-path registry with group preference |
| `webview/selection-registry.ts` | modify | on `createPathRegistry`; group params |
| `webview/change-nav-registry.ts` | modify | on `createPathRegistry`; group params |
| `webview/nav-editors.ts` | modify | on `createPathRegistry`; group params; `groupOfEditor`; group-aware pending focus |
| `webview/project-index.ts` | modify | group-tagged reveal, opener and cursor event |
| `webview/monaco-opener.ts` | modify | pass `groupOfEditor(source)` to `openDefinitionFile` |
| `webview/ts-nav.ts` | modify | pass `groupOfEditor(editor)` where an editor is in scope |
| `webview/editor-group-context.ts` | create | `EditorGroupContext`, `useEditorGroup`, `tabStateKey` |
| `webview/components/code-viewer.tsx` | modify | registrations, reveal, cursor and view-state key by group |
| `webview/components/markdown-viewer.tsx` | modify | selection, reveal and view-state key by group |
| `webview/components/breadcrumb-bar.tsx` | modify | filter cursor by group; open definitions in own group |
| `webview/components/doc-view.tsx` | modify | pass `tabStateKey` to diff/code/markdown/html/plan viewers |
| `webview/components/plan-view.tsx` | modify | `plan-source:` key from the per-tab key |
| `webview/view-state-store.ts` | modify | `moveViewState`, `copyViewState` |
| `webview/html-view-store.ts` | modify | `moveHtmlView`, `copyHtmlView` |
| `webview/closed-tabs.ts` | modify | `ClosedTab.group?: GroupIndex` |
| `webview/use-background-open-feedback.ts` | modify | `report({…, group})`; `flashTab: {id, group} \| null` |
| `webview/app.tsx` | modify | group-aware tab commands, close/teardown, routing, nav, re-read, split/move/focus/close/join commands, layout wiring |
| `webview/components/center-pane.tsx` | modify | render `EditorGroups`; per-group doc body; web layer; group callbacks |
| `webview/components/editor-groups.tsx` | create | the groups grid, divider, web hosts as direct grid children |
| `webview/components/editor-group-pane.tsx` | create | one group's frame, focus tracking, context provider |
| `webview/components/doc-tabs.tsx` | modify | tablist per strip, Terminal `role="tab"`, split button, idle-active class, strip context menu, cross-strip drag (S6) |
| `webview/tab-drag.ts` | create (Slice 6) | module-level cross-strip tab drag state |
| `webview/editor-split.ts` | create | min width, `clampSplitRatio`, `stepSplitRatio` |
| `src/settings.ts` | modify | `editorSplitRatio` field, default, coerce |
| `webview/settings.tsx` | modify | `resetLayout` restores `editorSplitRatio` |
| `webview/shortcuts.ts` | modify | five actions; empty-combo handling |
| `webview/split-editor-copy.ts` | create | `SPLIT_COPY` |
| `webview/icons.tsx` | modify (only if `IconSplitRight` is missing) | the split-button glyph |
| `webview/components/web-view.tsx` | modify (only as the T5.3 pre-agreed fallback) | `onGuestFocus` prop |
| `webview/styles.css` | modify | `.editorgroups`, `.editor-group`, divider, web layer, `.tab--current`, drop overlays, vocabulary entries |
| `test/unit/doc-groups.test.ts` | create | selectors, I1–I9, new actions, split-mode parametrised core behaviours, persistence round trip, `dirtyPreviewTabs` |
| `test/unit/web-doc.test.ts` | modify (accessor-only, only if it reads `preview`/`activeBySession`) | unchanged expectations |
| `docs/specs/2026-09-28-split-editor.md` | already amended at plan time | §2.4 webview pointer-down note; §3.1 symmetric shape; §4 viewLeave row. No executor change |
| `test/unit/docs.test.ts` | modify (accessor-only) | the I7 guard: reads go through accessors; **no expected literal changes** |
| `test/unit/persistence.test.ts` | modify | `group` validation |
| `test/unit/path-registry.test.ts` | create | multi-entry semantics |
| `test/unit/selection-registry.test.ts` | modify | D1 repro + two-viewer survivor |
| `test/unit/change-nav-registry.test.ts` | create | D1 repro + two-viewer survivor |
| `test/unit/nav-editors.test.ts` | modify | D1 repro, group preference, `groupOfEditor`, pending focus by group |
| `test/unit/project-index-reveal.test.ts` | create | group-targeted reveal + cursor event (monaco mocked) |
| `test/unit/editor-group-context.test.ts` | create | `tabStateKey` |
| `test/unit/view-state-store.test.ts` | modify | move/copy |
| `test/unit/html-view-store.test.ts` | modify | move/copy |
| `test/unit/closed-tabs.test.ts` | modify | group carried |
| `test/unit/use-background-open-feedback.test.ts` | modify | flash carries group |
| `test/unit/editor-split.test.ts` | create | clamp/step |
| `test/unit/settings.test.ts`, `test/unit/coerce-settings.test.ts` | modify | ratio default/clamp |
| `test/unit/shortcuts.test.ts` | modify | new actions; empty combo |
| `test/unit/file-save-controller.test.ts` | modify | second `attach` keeps one registration (two-viewer seam) |
| `test/e2e/split-editor.e2e.mjs` | create | spec §7 E1–E16 |
| `test/e2e/split-editor-drag.e2e.mjs` | create (Slice 6) | v1 drag/join/duplicate |
| `CHANGELOG.md` | modify | Unreleased entry |

## Scripts

- **`%TEMP%\claude-scratch\split-regress.ps1`** (one-off, not in the repo).
  - Args: `-Terms <string[]>`, default the five regression terms.
  - For each term it runs `node test/e2e/run-smoke.mjs <term>` alone and serially. Output goes to
    `%TEMP%\claude-scratch\regress-<term>.log`, and it records `$LASTEXITCODE`.
  - It prints one `term: PASS|FAIL (exit n)` line per term and exits non-zero if any failed.
  - It replaces five hand-run invocations at the end of Slices 1–5.
  - It assumes `npm run build` already ran.
  - Delete it at handoff.

## Slices

### Slice 1: Symmetric group model in the reducer (a refactor with no UI change)

**Check:**
- `npx vitest run test/unit/docs.test.ts test/unit/doc-groups.test.ts test/unit/persistence.test.ts test/unit/web-doc.test.ts test/unit/doc-tabs-flash.test.ts test/unit/doc-tabs-drag.test.ts`
  passes.
- `git diff test/unit/docs.test.ts` changes **accessor expressions only**. No expected literal (the
  argument of any `toBe`/`toEqual`/`toHaveLength`/`toMatchObject`/`toBeNull`/…) changes, and no
  test is added, removed or renamed. The reviewer diffs it.
- `npm run typecheck` passes.
- Then `npm run build` and `split-regress.ps1` (five terms) all PASS.

**Parallel groups:** G1: T1.1 · G2: T1.3 · Serial: T1.2
**Claims (serial lane):** `webview/docs.ts` (T1.1 types, T1.2 reducer), `src/protocol.ts` (T1.3), `webview/app.tsx`, `webview/components/doc-tabs.tsx`, `webview/components/center-pane.tsx` (T1.2)

#### Task 1.1: Preconditions, state types and selectors

**Files:**
- Create: `webview/doc-groups.ts`. Everything in Contracts → Group model marked "Slice 1":
  - `GroupIndex`, `Tab`, `EditorGroup`, `SessionLayout`, `EMPTY_LAYOUT`
  - `SplitBehavior`, `splitBehavior`
  - `layoutOf`, `groupDocs`, `groupActive`, `tabPreview`, `previewIdsOf`
  - `openTargetGroup`, `resolveActivateGroup`, `dirtyPreviewTabs`
- Modify: `webview/docs.ts`, **types only**:
  - `OpenDoc` without `preview`
  - `DocsState` per Contracts
  - `initialDocs = { docs: [], layouts: {}, activeId: null }`
  - `webview/docs.ts` won't typecheck until T1.2; that is expected inside this serial pair.
- Test: `test/unit/doc-groups.test.ts` (selector describe block; states are hand-written literals)

**Interfaces:**
- Produces: the Slice 1 signatures in Contracts → Group model, verbatim, and the `DocsState` /
  `OpenDoc` types in Contracts → `webview/docs.ts`.
- Consumes: `DocKind`, `DocsState`, `OpenDoc` (type-only import from `./docs`; there is no runtime
  cycle).

**Steps:**
- [ ] Check the Preconditions at the top of this plan. If any fail, stop and report.
- [ ] Failing selector tests:
  - 'groupDocs returns registry docs by reference in tab order' (`toBe` per element)
  - 'tabPreview reads the tab, independently per group'
  - 'openTargetGroup is 2 while group 1 shows the Terminal and group 2 exists' (D5); also 1 with
    one group, and `activeGroup` otherwise
  - 'resolveActivateGroup prefers the active group when both hold the doc'
  - 'splitBehavior moves web, review and git-history'
  - 'dirtyPreviewTabs lists every preview tab of a dirty path in both groups and every session'
    (P8)
- [ ] `npx vitest run test/unit/doc-groups.test.ts` → FAIL (module missing). Implement it, and it
  passes.

#### Task 1.2: Reducer on `groups[g]`, finalize, accessor-only `docs.test.ts`, preview readers

**Files:**
- Modify: `test/unit/docs.test.ts`, **first**, accessor-only:
  - Add helpers at the top:
    - `tabs = (s, sid = 'S1') => groupDocs(s, sid, 1)`
    - `isPreview = (s, id, sid = 'S1') => tabPreview(s, sid, 1, id)`
    - `remembered = (s, sid) => groupActive(s, sid, 1)`
  - Rewrite **order-sensitive** `s.docs` reads (`.map`, `[i]`) as `tabs(s, …)`.
  - Rewrite `.preview` reads as `isPreview`, and `activeBySession.X` as `remembered(s, 'X')`.
  - `previewCount` counts `previewIdsOf` over group 1.
  - Length, `find` and `some` reads may stay on `s.docs` (the registry).
  - **No expected literal changes.**
- Modify: `webview/docs.ts`:
  - every case per Contracts → reducer rules
  - private `finalize`
  - `backgroundOpenOutcome`
  - `toPersistedDocs`
  - `restore`
  - the `splitRight` / `moveTab` (Slice 1 form) / `focusGroup` actions
- Modify: `webview/app.tsx`:
  - **~2025-2037, the effect that subscribes to dirty changes:** for each
    `dirtyPreviewTabs(docStateRef.current, dirty)`, dispatch `pinDoc { id, group }` (P8,
    critic blocker 2).
  - **~2321, the tab menu's "Keep Open":** show it when
    `tabPreview(docState, doc.sessionId, 1, doc.id)`.
  - Pass `previewIds={previewIdsOf(docState, activeId ?? '', 1)}` to `CenterPane`, and
    `docs={groupDocs(docState, activeId ?? '', 1)}` in place of `visibleDocs` (same order and
    contents with one group).
- Modify: `webview/components/center-pane.tsx`: a `previewIds: ReadonlySet<string>` prop, passed
  through to `DocTabs`.
- Modify: `webview/components/doc-tabs.tsx`: a `previewIds` prop; the four `d.preview` reads
  (~175, ~227, ~228, ~236) become `previewIds.has(d.id)`.
- Test: `test/unit/doc-groups.test.ts` (reducer blocks), `test/unit/web-doc.test.ts` (accessor-only
  if needed), `test/unit/doc-tabs-flash.test.ts` / `test/unit/doc-tabs-drag.test.ts` (prop fixtures
  only)

**Interfaces:**
- Consumes (from T1.1):
  - `GroupIndex`, `Tab`, `EditorGroup`, `SessionLayout`, `EMPTY_LAYOUT`
  - `splitBehavior(kind: DocKind): SplitBehavior`, `layoutOf(state, sessionId): SessionLayout`
  - `groupDocs(state, sessionId, group): OpenDoc[]`, `groupActive(state, sessionId, group): string | null`
  - `tabPreview(state, sessionId, group, id): boolean`, `previewIdsOf(state, sessionId, group): ReadonlySet<string>`
  - `openTargetGroup(state, sessionId): GroupIndex`, `resolveActivateGroup(state, sessionId, id): GroupIndex`
  - `dirtyPreviewTabs(state, dirty): readonly { id: string; group: GroupIndex }[]`
- Consumes (from T1.3): `PersistedDoc.group?: 2`.
- Produces:
  - the Slice 1 `DocsAction` union: `group?` on `open`, `openCommitFile`, `openReview`, `close`,
    `activate`, `pinDoc` and `reorder`, plus `splitRight`, `moveTab {sessionId, id, toGroup, beforeId?}`
    and `focusGroup`
  - `CenterPane.previewIds` and `DocTabs.previewIds: ReadonlySet<string>`

**Call sites:** every `dispatchDocs` in `webview/app.tsx` stays valid, because the new fields are
optional. `backgroundOpenOutcome` is called at `webview/app.tsx` `reportBackgroundOpen` (~784), and
its signature is unchanged. `grep -rn "activeBySession\|\.preview\b" webview src electron` must end
with no `OpenDoc` reads.

**Steps:**
- [ ] Do the accessor-only rewrite of `docs.test.ts` first. Run it against the **old** reducer
  (with the T1.1 types stashed if needed) → PASS, which proves the rewrite is a pure re-expression.
  Commit nothing.
- [ ] Failing reducer tests in `doc-groups.test.ts`:
  - **Split-mode parametrised core** (`describe.each([1, 2])`): set up with `splitRight`, then act
    with an explicit `group`.
    - 'preview open retargets this group's preview in place (same index)'
    - '≤1 preview per group'
    - 're-open activates the existing tab'
    - 'permanent open promotes the preview'
    - 'close falls back left, then right'
    - 'reorder promotes a dragged preview'
    - 'pinDoc clears only this group's preview'
    - 'background open never changes activeId or activeGroup'
  - **Invariants:**
    - **I1:** every tab id names a doc owned by the layout's session (checked after each step of a
      mixed script).
    - **I2:** 'splitRight on a web tab moves it; groupDocs(1) no longer holds it'.
    - **I3:** 'a preview open in group 2 leaves group 1's preview alone'.
    - **I4:** 'closing the last group-2 tab removes group 2, and activeId is group 1's active'.
    - **I5:** 'splitRight with the Terminal active returns the same state object'.
    - **I6:** 'closing the only tab of a group-2-only doc removes the doc from docs'.
    - **I8:** 'retargeting group 1's preview keeps the doc group 2 still shows'.
    - **I9:** 'a foreground open from B of A's only group-2 doc collapses A's group 2'.
  - **Actions:**
    - 'splitRight duplicates a file into group 2 and focuses it': `activeId === 'file:/b.ts'`,
      `layouts.S1.activeGroup === 2`, and both groups hold it
    - 'splitRight on a preview pins the group-2 tab; group 1 stays preview'
    - 'splitRight on the commit-diff @preview re-keys to the pinned id first'
    - 'splitRight with group 2 active returns the same state'
    - 'moveTab into group 1 inserts before beforeId, pinned'
    - 'focusGroup swaps activeId'
    - 'close {group} closes one tab of two and keeps the doc'
    - 'switchSession restores group 2 as active'
    - 'closeSession falls back to the last remaining doc's session active'
  - **Persistence:**
    - 'toPersistedDocs: group 1 then group:2 entries, per-tab preview and active'
    - 'restore rebuilds both groups; dedupe per (id, group); activeGroup 1; activeId null'
    - 'single-session toPersistedDocs is byte-identical' (`JSON.stringify` against literals copied
      from the pre-change output of the `docs.test.ts` fixtures)
  - **Background outcome:** 'backgroundOpenOutcome is opened for a file only in the other group'.
- [ ] Run → FAIL. Implement to the rules.
- [ ] Run `doc-groups.test.ts`, the rewritten `docs.test.ts` and `web-doc.test.ts` → PASS.
- [ ] If a `docs.test.ts` literal can only pass by being changed (for example a cross-session
  interleave, or today's "last sibling" close fallback against the spec's left-else-right),
  **stop and report**. Never edit the literal.

#### Task 1.3: Persisted `group` field and host validation

**Files:**
- Modify: `src/protocol.ts` (`PersistedDoc.group?: 2` with a one-line doc comment)
- Modify: `src/persistence.ts` (`isRestorableDoc`)
- Test: `test/unit/persistence.test.ts`

**Interfaces:**
- Produces: `PersistedDoc.group?: 2`.

**Steps:**
- [ ] Failing tests:
  - 'a group:2 entry survives parseDocs'
  - 'an entry with group 3 or "2" is dropped'
  - 'an old-format file (no group) parses unchanged'
- [ ] Run `npx vitest run test/unit/persistence.test.ts` → FAIL. Implement, and it passes.

### Slice 2: Two viewers on one path (§3.2), with no UI change

**Check:**
- `npx vitest run test/unit/path-registry.test.ts test/unit/selection-registry.test.ts test/unit/change-nav-registry.test.ts test/unit/nav-editors.test.ts test/unit/project-index-reveal.test.ts test/unit/editor-group-context.test.ts test/unit/file-save-controller.test.ts test/unit/lsp-nav.test.ts`
  passes.
- `npm run typecheck` passes.
- `npm run build`, then `split-regress.ps1` all PASS, then alone:
  - `node test/e2e/run-smoke.mjs markdown-viewer`
  - `… html-viewer`
  - `… breadcrumbs`
  - `… mouse-nav`

  Each term must match at least one scenario; `run-smoke` exits 1 on a term that matches nothing,
  and in that case drop the term and record it.

**Parallel groups:** G1: T2.1 · G2: T2.3 · Serial: T2.2, T2.4
**Claims (serial lane):** `webview/components/code-viewer.tsx` (T2.4)

#### Task 2.1: Reproduce D1, then multi-entry registries

**Files:**
- Create: `webview/path-registry.ts`, `test/unit/path-registry.test.ts`, `test/unit/change-nav-registry.test.ts`
- Modify: `webview/selection-registry.ts`, `webview/change-nav-registry.ts`, `webview/nav-editors.ts`
- Test: `test/unit/selection-registry.test.ts`, `test/unit/nav-editors.test.ts`, `test/unit/file-save-controller.test.ts`

**Interfaces:**
- Consumes: `GroupIndex` from `webview/doc-groups.ts`.
- Produces:
  - `createPathRegistry<T>(normalize?)`, `PathRegistry<T>`
  - `registerSelection(path, entry, group: GroupIndex = 1)`, `selectionInActiveDoc(docs, activeId, group: GroupIndex = 1)`
  - `registerChangeNav(path, entry, group: GroupIndex = 1)`, `goToChangeInActiveDoc(docs, activeId, direction, group: GroupIndex = 1)`
  - `registerNavEditor(path, editor, group: GroupIndex = 1)`, `liveCursor(path, group?)`,
    `revealInNavEditor(path, pos, group?)`, `requestNavFocus(path, group?)`,
    `groupOfEditor(editor: unknown): GroupIndex | undefined`

**Call sites (unchanged in this task; the defaults keep them compiling):**
- `code-viewer.tsx`: `registerSelection` ~272, `registerNavEditor` ~498, `registerChangeNav` ~724
- `markdown-viewer.tsx`: `registerSelection` ~854
- `app.tsx`:
  - `selectionInActiveDoc` ~283
  - `goToChangeInActiveDoc` ~994/996, ~3281/3291
  - `liveCursor` ~2817/2859
  - `revealInNavEditor` / `requestNavFocus` ~2853-2855, ~2867

**Steps:**
- [ ] **D1 reproduction first**, against the current single-slot modules. Write
  'second viewer on the same path: unmounting the newer one leaves the survivor registered' in
  `selection-registry.test.ts`, `nav-editors.test.ts` and `change-nav-registry.test.ts`: register A,
  register B, call B's unregister, then the lookup returns A.
- [ ] Run them → **expect FAIL** (the lookup is `undefined`). Paste the failing assertion line into
  the run report as the D1 measurement. If it passes, D1 measured false: record that and continue.
  The contract still applies.
- [ ] Failing `path-registry.test.ts` cases:
  - 'get prefers the requested group'
  - 'get falls back to the most recent entry'
  - 'unregister removes only its own entry'
  - 'normalize folds path spellings'
- [ ] Failing `nav-editors.test.ts` cases:
  - 'groupOfEditor returns the registering group'
  - 'requestNavFocus with a group focuses only that group's editor'
- [ ] Failing `file-save-controller.test.ts` case: 'a second attach on the same path keeps one save
  registration and one content subscription'. It counts `deps.register` and `onDidChangeContent`
  calls, 1 each.
- [ ] Implement `path-registry.ts` and move the three registries onto it. The D1 tests now PASS.

#### Task 2.2: Group-tagged reveal, opener and cursor; Monaco routes by source editor

**Files:**
- Modify: `webview/project-index.ts`, `webview/monaco-opener.ts`, `webview/ts-nav.ts`
- Create: `test/unit/project-index-reveal.test.ts` (with `vi.mock('monaco-editor', …)` as in `test/unit/lsp-nav.test.ts`)

**Interfaces:**
- Consumes:
  - `groupOfEditor(editor: unknown): GroupIndex | undefined` (T2.1)
  - `GroupIndex`
- Produces:
  - `setReveal(path, pos, group?)`, `takeReveal(path, group)`, `hasReveal(path, group?)`
  - `setDefinitionOpener(fn: (absPath, pos, group?) => void)`, `openDefinitionFile(absPath, pos, group?)`
  - `CursorEvent { path; offset; group }`

**Call sites:**
- `takeReveal`: `code-viewer.tsx` ~293, ~627; `markdown-viewer.tsx` ~783, ~799. These are updated
  in T2.4; until then pass `1`.
- `hasReveal`: `markdown-viewer.tsx` ~817.
- `publishCursor`: `code-viewer.tsx` ~406, ~410 (add `group: 1` here; T2.4 makes it real).
- `openDefinitionFile`:
  - `monaco-opener.ts` ~41 → `groupOfEditor(source)`
  - `ts-nav.ts` ~158, ~178, ~419 → `groupOfEditor(<the editor in that function's scope>)`; where no
    editor is in scope, omit it
  - `breadcrumb-bar.tsx` ~279 (T2.4)
- `setDefinitionOpener`: `app.tsx` ~2000 (it keeps compiling; T3.1 uses the group).

**Steps:**
- [ ] Failing tests:
  - 'a reveal staged for group 2 is not consumed by group 1'
  - 'an ungrouped reveal is consumed by the first taker'
  - 'openDefinitionFile forwards the group'
- [ ] Run → FAIL. Implement → PASS. `npx vitest related webview/project-index.ts webview/monaco-opener.ts webview/ts-nav.ts --run`.

#### Task 2.3: Group context and per-tab key

**Files:**
- Create: `webview/editor-group-context.ts`, `test/unit/editor-group-context.test.ts`

**Interfaces:**
- Produces: `EditorGroupContext` (default `1`), `useEditorGroup(): GroupIndex`,
  `tabStateKey(docId: string, group: GroupIndex): string`.

**Steps:**
- [ ] Failing test: 'tabStateKey is the doc id for group 1 and g2-prefixed for group 2'. Run →
  FAIL. Implement → PASS.

#### Task 2.4: Viewers read their group

**Files:**
- Modify: `webview/components/code-viewer.tsx`
  - `const group = useEditorGroup()`
  - pass `group` to `registerSelection`, `registerNavEditor` and `registerChangeNav`
  - `takeReveal(doc.path, group)` at mount and in the live subscription
  - `publishCursor({ path, offset, group })`
  - add `group` to the effect deps
- Modify: `webview/components/markdown-viewer.tsx`
  - selection registration and `takeReveal`/`hasReveal` with the group
  - its view-state key becomes the `viewStateId` prop when given, else `` `file:${doc.path}` ``
  - add a `viewStateId?: string` prop
- Modify: `webview/components/breadcrumb-bar.tsx`: ignore cursor events whose `group` isn't its own;
  `openDefinitionFile(filePath, pos, group)`
- Modify: `webview/components/doc-view.tsx`: `const key = tabStateKey(doc.id, useEditorGroup())`, passed as:
  - `viewStateId` to `DiffViewer`, `CodeViewer` and `MarkdownViewer`
  - `docId` to `HtmlViewer` and to `getHtmlView`
  - a new `viewStateId` prop to `PlanView`
- Modify: `webview/components/plan-view.tsx`: the `plan-source:` key uses the `viewStateId` prop

**Interfaces:**
- Consumes (repeated from T2.1–T2.3):
  - `useEditorGroup(): GroupIndex`, `tabStateKey(docId, group): string`
  - `takeReveal(path, group)`, `hasReveal(path, group?)`
  - `CursorEvent { path; offset; group }`
  - `registerSelection(path, entry, group)`, `registerNavEditor(path, editor, group)`, `registerChangeNav(path, entry, group)`
  - `openDefinitionFile(absPath, pos, group?)`

**Steps:**
- [ ] Port-style task: with no provider, every key equals today's. The existing suite and the
  Slice 2 e2e list stay green. That is the proof, and no new failing test is required.
- [ ] Typecheck, related units, build, and the Slice 2 Check list.

### Slice 3: App consumers group-aware (single group still renders)

**Check:**
- `npx vitest run test/unit/closed-tabs.test.ts test/unit/use-background-open-feedback.test.ts test/unit/doc-groups.test.ts test/unit/tab-close-selection.test.ts`
  passes.
- `npm run typecheck` passes.
- `npm run build`, then `split-regress.ps1` all PASS, then alone: `auto-save`, `changes-active-highlight`,
  `html-viewer`. With one group, the app behaves exactly as today (E14 / I7 at the app level).

**Parallel groups:** Serial: T3.1 → T3.2 → T3.3
**Claims (serial lane):** `webview/app.tsx`

#### Task 3.1: Routing, nav history, reveal staging, flash

**Files:**
- Modify: `webview/doc-groups.ts` (add `tabGroupsOf`, `activeGroupOf` per Contracts)
- Modify: `webview/use-background-open-feedback.ts`:
  - `report(r: { id; title; outcome; sessionName; group: GroupIndex })`
  - the return value `flashTab: { id: string; group: GroupIndex } | null` replaces `flashTabId`
- Modify: `webview/app.tsx`:
  - **`openFile` / `openDiff` / `openWeb` / `openCommitFile` / `openReview*`** take an optional
    `group?: GroupIndex` in their options, and compute
    `const g = group ?? openTargetGroup(docStateRef.current, targetSessionId)`. Then
    `setReveal(path, pos, g)` and dispatch with `group: g`. The background skip test compares
    `groupActive(state, s, g)`.
  - **`setDefinitionOpener`**: `(abs, pos, group) => openFileRef.current(abs, undefined, 'preview', { reveal: pos, group })`.
    When `group` is given, a `focusGroup` dispatch precedes the open (spec §2.5).
  - **`reportBackgroundOpen`** passes `group`. `CenterPane` gets
    `flashTabId={flashTab?.group === 1 ? flashTab.id : null}` until T4.4 replaces the prop.
  - **Nav history:**
    - `currentNavEntry` uses `liveCursor(path, activeGroupOf(state, s))`.
    - `applyNav`:
      - `const g = resolveActivateGroup(state, s, doc.id)`
      - dispatch `activate {id, sessionId, group: g}`
      - `revealInNavEditor(path, pos, g)` when it was already that group's active; else
        `setReveal(path, pos, g)` + `requestNavFocus(path, g)`
    - `isNavOnScreen` is unchanged. It compares against `currentNavEntry`, which is the active
      group's.
  - **The Mod+Shift+F seed**, `nextChange` / `prevChange` (action map and palette) and `save`
    pass `activeGroupOf(...)`.
- Test: `test/unit/use-background-open-feedback.test.ts`, `test/unit/doc-groups.test.ts` (the two new selectors)

**Interfaces:**
- Consumes:
  - `openTargetGroup(state, sessionId): GroupIndex`, `resolveActivateGroup(state, sessionId, id): GroupIndex`
  - `groupActive(state, sessionId, group): string | null`, `GroupIndex`
  - `setReveal(path, pos, group?)`, `setDefinitionOpener(fn: (absPath, pos, group?) => void)`
  - `liveCursor(path, group?)`, `revealInNavEditor(path, pos, group?)`, `requestNavFocus(path, group?)`
  - `selectionInActiveDoc(docs, activeId, group)`, `goToChangeInActiveDoc(docs, activeId, direction, group)`
- Produces:
  - `tabGroupsOf(state, id): GroupIndex[]`, `activeGroupOf(state, sessionId): GroupIndex`
  - `flashTab: { id: string; group: GroupIndex } | null`

**Steps:**
- [ ] Failing unit tests:
  - 'report carries the group into flashTab'
  - 'edit-promotes per tab (P8)': a composition test in `doc-groups.test.ts`. Build a state with a
    group-2 preview of `x.ts` and a pinned group-1 tab of `x.ts`. Apply every
    `pinDoc { id, group }` from `dirtyPreviewTabs(state, new Set(['/x.ts']))` → group 2's tab is
    pinned and group 1 is unchanged. The effect itself landed in T1.2, because removing
    `OpenDoc.preview` forced the rewrite; this is the critic's requested unit test. Its e2e
    counterpart is in T5.2.
  - 'tabGroupsOf lists both groups for a duplicated doc'
  - 'activeGroupOf defaults to 1'
- [ ] Implement. Typecheck. Run the related units.

#### Task 3.2: Per-tab close vs last-tab teardown; tab commands on the group's order

**Files:**
- Modify: `webview/closed-tabs.ts`: `ClosedTab.group?: GroupIndex`, set by `toClosedTab(doc, group?)`
- Modify: `webview/app.tsx`:
  - **New `closeTab(id: string, group: GroupIndex)`:**
    - If `tabGroupsOf(state, id).length > 1`, close only that tab, with no prompt:
      - `markClosing(tabStateKey(id, group))` and `clearHtmlView(tabStateKey(id, group))`
      - `pushClosedTab(toClosedTab(doc, group))`
      - dispatch `close {id, group}`
    - Otherwise call today's `closeDoc(id)`: the dirty prompt, auto-save save-on-close, then
      `forceCloseDoc`.
  - **`forceCloseDoc(id)`** keeps its whole-doc teardown (`fileSaves.dispose`, `clearDirty`,
    `clearReveal`) and adds `markClosing` / `clearHtmlView` for **both** `tabStateKey(id, 1)` and
    `tabStateKey(id, 2)`. It records `group` from `tabGroupsOf` (the first group) on the closed tab.
  - **The `closeTab` action (Mod+W)** calls `closeTab(activeId, activeGroupOf(...))`.
  - **`cycleTab`** stops are `[...(g === 1 ? [null] : []), ...groupDocs(state, s, g).map(d => d.id)]`,
    where `g = activeGroupOf`.
  - **`navGoToTab`** indexes `groupDocs(state, s, activeGroupOf(...))`.
  - **`onTabContextMenu(e, doc, group)`**: `closeTabSelection(groupDocs(state, s, group).map(d => d.id), doc.id, mode)`,
    then `closeTab(id, group)` for each (S6). The menu signature gains `group`. `CenterPane` passes
    `1` until Slice 4.
  - **`cmd:closeOthers`** acts on the active group's ids.
  - **The terminal-tab "Close editor tabs"** closes group 1's tabs only.
  - **`reopenClosedTab`** passes `group: tab.group` when `activeGroupOf` shows that group still
    exists (`tab.group === 1`, or group 2 exists). Otherwise it passes nothing.
  - **`setDocCloser`** (auto-save) stays `forceCloseDoc(d.id)`: a deleted file closes every tab.
- Test: `test/unit/closed-tabs.test.ts` ('toClosedTab carries the group')

**Interfaces:**
- Consumes:
  - `tabGroupsOf(state, id): GroupIndex[]`, `activeGroupOf(state, sessionId): GroupIndex`
  - `groupDocs(state, sessionId, group): OpenDoc[]`, `tabStateKey(docId, group): string`
  - the `close` action with `group`
  - `closeTabSelection(paths: readonly string[], anchor: string, mode: TabCloseMode): string[]`
    (signature unchanged; ids are passed)
- Produces: `closeTab(id: string, group: GroupIndex): Promise<boolean>` (inside `App`; resolves
  `true` once the tab is closed, `false` if a prompt was cancelled or a save failed).
  `closeDoc(id): Promise<boolean>` gets the same return contract. `ClosedTab.group?: GroupIndex`.

**Call sites:** `closeDoc` callers keep calling `closeDoc` for whole-doc closes:
- `closeReviewTab` (~1951)
- the `dropDocsFor` family
- the terminal-tab menu

The tab strip's close, middle-click, Mod+W and the tab context menu switch to `closeTab`.

**Steps:**
- [ ] Failing unit test (closed-tabs). Implement. Typecheck. Run the Slice 3 regress terms.

#### Task 3.3: Review mode, re-read and palette editor commands for two groups

**Files:**
- Modify: `webview/app.tsx`:
  - **`reviewMode`** = `centerView === 'editor'` and some group's active doc is the Review doc (D6).
    Compute the group actives via `groupActive` for groups 1 and 2.
  - **`visibleFilePaths`** (memo) = the file paths of both groups' active docs. The "re-read on
    activate" effect re-reads each path that newly appears in the set. `rereadActiveFile` on window
    focus/visibility re-reads **every** visible file path.
  - **The palette's active-doc commands** (~3203) resolve
    `docState.docs.find(d => d.id === docState.activeId)`. That is unchanged: `activeId` is the
    active group's. Toggle HTML view / reload act on `tabStateKey(activeId, activeGroupOf(...))`, and
    the tab menu's HTML toggle (~2391-2396) on `tabStateKey(doc.id, group)`.

**Interfaces:**
- Consumes: `groupActive(state, sessionId, group): string | null`, `activeGroupOf(state, sessionId): GroupIndex`,
  `tabStateKey(docId, group): string`, `REVIEW_DOC_ID`.

**Steps:**
- [ ] No new pure logic. The proof is the Slice 3 Check (single group unchanged) plus E-cases in
  Slice 5 (two groups). Implement. Typecheck. Build. Run the Slice 3 Check.

### Slice 4: Two groups on screen: layout, strips, divider, Split Right, focus

**Check:**
- `npx vitest run test/unit/editor-split.test.ts test/unit/settings.test.ts test/unit/coerce-settings.test.ts test/unit/shortcuts.test.ts test/unit/state-vocabulary.test.ts test/unit/doc-tabs-flash.test.ts test/unit/doc-tabs-drag.test.ts`
  passes.
- `npm run typecheck` passes.
- `npm run build`, then `node test/e2e/run-smoke.mjs split-editor` passes the Slice 4 scenarios
  (E1, E2, E3, E6, E8, E12, E13).
- Then `split-regress.ps1` all PASS, then alone: `web-view`, `middle-click-web`, `web-blank-link`,
  `scrollback`, `attention`. `scrollback` and `attention` guard the terminal stack now living in
  group 1's body; re-run a failure alone before believing it.

**Parallel groups:** G1: T4.1 · G2: T4.2 · Serial: T4.3 → T4.4 → T4.5
**Claims (serial lane):** `src/settings.ts` (T4.1), `webview/shortcuts.ts` (T4.2), `webview/components/doc-tabs.tsx` (T4.3), `webview/components/center-pane.tsx` (T4.4), `webview/app.tsx`, `webview/styles.css` (T4.5)

#### Task 4.1: Ratio setting and clamp math

**Files:**
- Create: `webview/editor-split.ts`, `test/unit/editor-split.test.ts`
- Modify: `src/settings.ts` (field, default `0.5`, coerce with `clampNum(…, 0.15, 0.85, …)`),
  `webview/settings.tsx` (`resetLayout`)
- Test: `test/unit/settings.test.ts`, `test/unit/coerce-settings.test.ts`

**Interfaces:**
- Produces: `EDITOR_GROUP_MIN_PX`, `clampSplitRatio(ratio, widthPx): number`,
  `stepSplitRatio(ratio, widthPx, key, shift): number`, `AppSettings.editorSplitRatio: number`.

**Steps:**
- [ ] Failing tests:
  - 'clamp keeps each side ≥ 240px at 1000px': `clampSplitRatio(0.1, 1000) === 0.24`
  - 'narrower than 480px returns the ratio unchanged'
  - 'ArrowLeft steps 16px; Shift steps 64px; Home is the min'
  - 'coerce clamps 0.95 to 0.85 and defaults garbage to 0.5'
- [ ] Run → FAIL. Implement → PASS.

#### Task 4.2: Shortcut actions and copy

**Files:**
- Modify: `webview/shortcuts.ts` (five actions; `matchCombo` / `formatCombo` empty-combo handling)
- Create: `webview/split-editor-copy.ts` with the keys Slice 4 consumes: `splitRight`,
  `splitButton`, `focusLeft`, `focusRight`, `groupLabel`, `tablistLabel`, `divider`, `capReached`,
  `terminalCantSplit`, `splitOpened`. Later keys are added by T5.1 (`moveToOther`, `moved`), T5.2
  (`closeGroup`, `groupClosed`) and T6.2 (`joinGroups`).
- Test: `test/unit/shortcuts.test.ts`

**Interfaces:**
- Produces:
  - action ids `splitEditorRight`, `moveTabNextGroup`, `moveTabPrevGroup`, `focusLeftGroup`, `focusRightGroup`
  - `SPLIT_COPY` (Contracts)

**Steps:**
- [ ] Failing tests:
  - 'Ctrl+\\ matches splitEditorRight on non-mac'. The event is `{key:'\\', ctrlKey:true}`.
  - 'an empty combo never matches'
  - 'formatCombo of empty is Unassigned'
  - 'Mod+Alt+ArrowRight matches moveTabNextGroup'
- [ ] Run → FAIL. Implement → PASS. If the Shortcuts settings list (`settings-modal.tsx` or the
  nav-keybindings `shortcuts-tab.tsx`) breaks on an empty default, **stop and report**. Don't
  special-case it.

#### Task 4.3: `DocTabs` per group

**Files:**
- Modify: `webview/components/doc-tabs.tsx`:
  - **New props per Contracts.**
  - **`.tabbar`** gets `role="tablist"` and `aria-label={SPLIT_COPY.tablistLabel(group)}`.
  - **The Terminal tab** renders only when `showTerminal`, and becomes `role="tab"`,
    `aria-selected`, `tabIndex=0`.
  - **The active tab class** is `tab--active` when `groupActive`, else `tab--current`.
    `aria-selected` is true for both.
  - **The split button** (`.tabbar__split`) comes after the overflow button:
    - `aria-label={SPLIT_COPY.splitButton}`
    - `aria-disabled` + `title={disabledReason ?? SPLIT_COPY.splitRight}` when disabled; its click
      is ignored while disabled
    - icon: `IconSplitRight` from `webview/icons.tsx` if it exists; otherwise add
      `IconSplitRight = glyph('split-right', …)` there (two rectangles, 16-unit stroke style)
  - **`onContextMenu`** on the strip background (not on a tab) calls `onStripContextMenu`.
- Modify: `webview/icons.tsx` (only if `IconSplitRight` is missing)
- Test: `test/unit/doc-tabs-flash.test.ts`, `test/unit/doc-tabs-drag.test.ts` (keep green; update
  prop fixtures only where the props changed)

**Interfaces:**
- Consumes: `GroupIndex`, `SPLIT_COPY.tablistLabel`, `SPLIT_COPY.splitButton`, `SPLIT_COPY.splitRight`.
- Produces: the `DocTabs` props in Contracts.

**Steps:**
- [ ] Implement. Typecheck. Run the related units. (The visual and ARIA proof is the T4.5 e2e.)

#### Task 4.4: `EditorGroupPane`, `EditorGroups` and `CenterPane`

**Files:**
- Create: `webview/components/editor-group-pane.tsx`, `webview/components/editor-groups.tsx` (Contracts)
- Modify: `webview/doc-groups.ts` (add `GroupView`, `CenterLayout`, `centerLayout`)
- Modify: `webview/components/center-pane.tsx`:
  - The props change per Contracts. `previewIds` and `docs` give way to `layout`.
  - Extract the active-doc body chain (Review / GitHistory / CommitDiff / DocView,
    ~383-443) into `renderDocBody(doc: OpenDoc, group: GroupIndex)`. Pass
    `viewStateId={tabStateKey(doc.id, group)}` to `ReviewView` / `GitHistoryView`. Use
    `key={tabStateKey(doc.id, group)}` on `DocView` so two groups never share a React key.
  - Group 1's body holds today's `.termwrap` content: terminals, stale/exited cards, the session
    split pane (`splitId`), and group 1's doc body. `TrustPrompt` goes in group 1's `top` slot.
  - Group 2's body holds only its doc body.
  - Web docs leave `.termwrap` and become direct children of `.editorgroups` (P7). The placement:
    ```ts
    webPlacement = (id) => {
      const v = layout.groups.find(v => v.docs.some(d => d.id === id));
      return v ? { group: v.group, visible: v.activeDocId === id } : null;
    }
    ```
  - Both groups' `DocTabs` get `moveGrip`, and `previewIds` from their `GroupView`.
  - `flashTabId` goes per strip from `flashTab`.
- Modify: `webview/styles.css`:
  - **`.editorgroups`:** `display:grid`, `grid-template-rows:auto 1fr`, `isolation:isolate`,
    `min-height:0`, `flex:1`. The columns are set inline (Contracts).
  - **Placement:**
    - `.editor-group` spans rows 1–2, with `display:grid`, `grid-template-rows:subgrid` and
      `min-width:0`.
    - `.editorgroups > [data-group="1"]` goes in `grid-column:1`, and `[data-group="2"]` in
      `grid-column:3`.
    - `.editorgroups > .webhost` goes in `grid-row:2`, with `position:relative`, `z-index:6`
      (above Monaco's `.minimap{z-index:5}`, contained by `isolation`) and `min-width:0`.
    - `.webhost[hidden]` is not displayed, through the UA default. No rule is added for it.
    - Move the existing `.webhost` `position:absolute; inset:0` (~12611) onto this grid placement.
      Don't override it; replace it.
  - **`.editor-group__body`:** `position:relative`, `min-height:0`, `overflow:hidden`.
  - **`.editor-group[data-active] > .tabbar-wrap`:** a 2px `--accent` inset box-shadow bottom rule
    (a shape, not hue alone).
  - **`.tab--current`:** `--state-sel-bg` / `--state-sel-fg`.
  - **`.editorgroups__divider`:** `grid-row:1 / span 2`, `grid-column:2`, a hairline `--border`,
    `--accent` on hover/drag/`:focus-visible`, and `cursor: col-resize`.
  - **`.tabbar__split`.**
  - **Vocabulary:** add `.tab--current`, `.tabbar__split` and `.editorgroups__divider` to the
    interaction-state vocabulary section at the foot.

**Interfaces:**
- Consumes:
  - `CenterLayout`, `GroupView` (including `previewIds`), `GroupIndex`, `tabStateKey(docId, group)`,
    `EditorGroupContext`
  - `clampSplitRatio(ratio, widthPx)`, `stepSplitRatio(ratio, widthPx, key, shift)`
  - `SPLIT_COPY.groupLabel`, `SPLIT_COPY.divider`
  - the `DocTabs` props (T4.3)
- Produces: `centerLayout(state, sessionId): CenterLayout`; the `CenterPane` props (Contracts).

**Steps:**
- [ ] Implement. Typecheck. The proof is T4.5's e2e plus the web and terminal scenarios in the
  Slice 4 Check. `web-view` / `middle-click-web` must stay green with web hosts now placed by the
  grid.

#### Task 4.5: App wiring, Split Right, focus, strings, and the Slice 4 e2e

**Files:**
- Modify: `webview/app.tsx`:
  - `const layout = useMemo(() => centerLayout(docState, activeId), [docState, activeId])`, passed
    to `CenterPane` along with the new callbacks.
    - `onFocusGroup` → dispatch `focusGroup`.
    - `onSelectDoc(id, group)` → `activateDocByUser(id, session, group)`, where `activateDocByUser`
      gains `group` and dispatches `activate {…, group}`.
    - `onCloseDoc` → `closeTab`.
    - `onReorderDoc(…, group)` → `reorder {…, group}`.
    - `onPinDoc(id, group)` → `pinDoc {id, group}`.
  - **`splitRight()`:**
    - If the active group is 2 → announce `SPLIT_COPY.capReached` through `navLiveRef`.
    - Else if group 1's active is `null` → do nothing.
    - Else dispatch `splitRight`, announce `SPLIT_COPY.splitOpened(title)`, then
      `requestNavFocus(path, 2)` for a file doc, or else focus group 2's body.
  - **`splitDisabledReason`:**
    - Terminal active → `SPLIT_COPY.terminalCantSplit`
    - active group is 2 → `SPLIT_COPY.capReached`
    - else `null`
  - **Action map:**
    - `splitEditorRight` → `splitRight()`
    - `focusLeftGroup` / `focusRightGroup` → `focusGroup`
    - `moveTabNextGroup` / `moveTabPrevGroup` are wired in T5.1
  - **The tab context menu** adds "Split Right" (disabled on Terminal and when the active group
    is 2).
  - **Palette:** Split Editor Right, Focus Left Editor Group, Focus Right Editor Group.
  - **`onSplitRatioCommit`** → `update({ editorSplitRatio })`.
  - **Focus after a collapse (spec §10):** an effect watches `layout.groups.length`. On 2 → 1, if
    `document.activeElement` is not inside group 1, call `requestNavFocus(path, 1)` for group 1's
    active file doc. Otherwise focus group 1's active tab (`[data-group="1"] [role="tab"][aria-selected="true"]`).
- Create: `test/e2e/split-editor.e2e.mjs`:
  - Fixture: a temp git repo with `a.ts` exporting `export const answer = 42;`, `b.ts` doing
    `import { answer } from './a';` with a use, and `note.md`.
  - Setup follows `test/e2e/editor-tabs-persist.e2e.mjs` (its own `--user-data-dir`, reused for
    the restart) and `runScenario`/`launchApp`/`openSession`/`closeApp` from `harness.mjs`.
  - Scenarios, with each key assertion:
    - **E1:** `.editor-group` count 2; `[data-group="2"][data-active="true"] .tab--active` holds
      `b.ts`; `[data-group="1"]` has no `data-active`.
    - **E2:** type `X` in group 2's editor → group 1's first line starts with `X`; two `.tab--dirty`;
      Ctrl+S → zero `.tab--dirty`.
    - **E3:** wheel-scroll group 2's editor 30 lines → group 1's `.monaco-scrollable-element`
      scrollTop is unchanged.
    - **E6:** close group 2's only tab → one `.editor-group`, and group 1 is `data-active`.
    - **E8:** drag the divider 200px left → widths change; neither is `< 240`; restart →
      ratio ±1% (compare the two `.editor-group` `getBoundingClientRect().width`s). ArrowLeft ×3 on the
      focused divider also changes it.
    - **E12:** Terminal tab active + focus on the strip → Ctrl+\ changes nothing; the menu's
      "Split Right" is disabled; focus in xterm + Ctrl+\ → still one group.
    - **E13:** with group 2 active the split button is `aria-disabled="true"`; Ctrl+\ → the polite
      region text is `Only two editor groups are supported.`

**Interfaces:**
- Consumes: everything T4.1–T4.4 produced, plus `splitRight` / `focusGroup` actions,
  `requestNavFocus(path, group?)` and `SPLIT_COPY`.

**Steps:**
- [ ] Write the e2e first. `npm run build` → run `split-editor` → FAIL (only one group exists).
- [ ] Implement. Build. Run the Slice 4 Check list.
- [ ] Screenshot the split in Neon, Aero and the third theme to `%TEMP%\claude-scratch\` (or
  `npm run shots` if it has a split fixture). Look at them: the active rule, `.tab--current`, the
  divider focus ring, and the split button.

### Slice 5: Move, close group, routing, persistence, web, PDF

**Check:**
- `npx vitest run test/unit/view-state-store.test.ts test/unit/html-view-store.test.ts` passes.
- `npm run build`, then `node test/e2e/run-smoke.mjs split-editor` passes every MVP scenario:
  E1–E13, E15, E16, plus Move / Close group / PDF.
- Then `split-regress.ps1` all PASS. Then alone: `pdf-viewer`, `web-view`, `review`. Use the term
  that matches the Review scenarios in `test/e2e`; list them with `ls test/e2e | grep review` and
  run each alone.

**Parallel groups:** Serial: T5.1 → T5.2 → T5.3
**Claims (serial lane):** `webview/app.tsx`, `test/e2e/split-editor.e2e.mjs`

#### Task 5.1: Move to Other Group, and view-state re-key (I10)

**Files:**
- Modify: `webview/view-state-store.ts`, `webview/html-view-store.ts` (move/copy per Contracts)
- Modify: `webview/app.tsx`:
  - **`moveTabToGroup(id, toGroup, beforeId: string | null)`:**
    - `moveViewState` / `moveHtmlView` from `tabStateKey(id, from)` to `tabStateKey(id, toGroup)`.
    - Then dispatch `moveTab`, and announce `SPLIT_COPY.moved(title, toGroup)`.
    - Focus: `requestNavFocus(path, toGroup)` for a file, else the target body.
  - **Split Right** (T4.5) also copies (duplicate) or moves (move-only) the view state before its
    dispatch.
  - **Action map:** `moveTabNextGroup` → to 2 from 1; `moveTabPrevGroup` → to 1 from 2. Neither
    works on the Terminal.
  - **The tab context menu** adds "Move to Other Group" (disabled on Terminal).
  - **Palette:** "Move Editor to Other Group".
  - With one group, Move to Other Group (keyboard, menu, palette) creates group 2, as VS Code's
    "Move Editor into Right Group" does (amended in the review round).
- Modify: `webview/split-editor-copy.ts` (add `moveToOther`, `moved`)
- Test: `test/unit/view-state-store.test.ts` ('move carries state and clears the target tombstone'),
  `test/unit/html-view-store.test.ts` ('move and copy notify subscribers')

**Interfaces:**
- Consumes: `moveTab` action `{sessionId, id, toGroup, beforeId?}`,
  `tabStateKey(docId, group)`, `requestNavFocus(path, group?)`, `SPLIT_COPY.moved`.
- Produces:
  - `moveViewState(from, to)`, `copyViewState(from, to)`, `moveHtmlView(from, to)`, `copyHtmlView(from, to)`
  - `moveTabToGroup(id: string, toGroup: GroupIndex, beforeId: string | null): void` (inside `App`;
    Slice 6 extends it with `duplicate`)

**Steps:**
- [ ] Failing unit tests → implement → PASS.
- [ ] e2e scenarios added to `split-editor.e2e.mjs`:
  - 'Move to Other Group via Mod+Alt+ArrowRight': the tab leaves group 1, is active in group 2,
    and group 2 is active.
  - 'Review moves and keeps its scroll anchor': scroll Review, move it, then its list scrollTop is
    within ±2px.

#### Task 5.2: Close Editor Group, routing and persistence e2e

**Files:**
- Modify: `webview/app.tsx`:
  - **`closeEditorGroup()`:** iterate a snapshot of group 2's tab ids through `closeTab(id, 2)`,
    awaiting each dirty prompt. Stop at the first cancel. Announce `SPLIT_COPY.groupClosed` when
    group 2 is gone.
  - **Group 2 strip-background context menu:** "Close Editor Group". Also a palette entry.
  - The loop relies on `closeTab`'s `Promise<boolean>` (T3.2).
- Modify: `webview/split-editor-copy.ts` (add `closeGroup`, `groupClosed`)
- Modify: `test/e2e/split-editor.e2e.mjs`, adding scenarios:
  - **E4:** click into group 1's `b.ts` on `answer`, press F12 → group 1's active tab is `a.ts` at
    line 1, and group 2 is unchanged.
  - **E5:** explorer open with group 2 active → it opens in group 2. Terminal active in group 1
    plus a split → it opens in group 2.
  - **E7:** dirty `b.ts` in both groups, close one → no `.modal`, and the remaining tab is dirty.
  - **E9:** restart → same tabs per group, same order, same active tab per group.
  - **E11:** Ctrl+W, Ctrl+Tab and Ctrl+2 affect only the active group's strip.
  - **E15:** close one of two `b.ts` tabs, then Ctrl+S and Alt+F5 in the survivor → the file saves,
    and the cursor moves to the next change.
  - **E16:** `x.ts` pinned in group 2, a preview in group 1, single-click `x.ts` then `y.ts` in the
    explorer with group 1 active → group 2 still holds `x.ts`, and group 1's preview is `y.ts`.
  - **Close Editor Group** with one dirty group-2-only doc → the prompt appears. Cancel → group 2
    remains; Discard → group 2 is gone.
  - **Edit-promotes per tab (P8, critic blocker 2):** open `x.ts` as a preview in group 2, type
    in it, then single-click `y.ts` in the explorer with group 2 active → group 2 still holds
    `x.ts` (pinned, dirty), and `y.ts` opens as a new preview.
  - **viewLeave (P9):** seed `settings.json` with `autoSave: 'onFocusChange'`. With `b.ts` in both
    groups and group 2 active, type in group 2, then activate `a.ts` in group 2 → `b.ts` on disk
    has the edit, and group 1 still shows `b.ts` (not dirty).

**Interfaces:**
- Consumes: `closeTab(id, group)`, `SPLIT_COPY.closeGroup`, `SPLIT_COPY.groupClosed`.

**Steps:**
- [ ] Write the scenarios → build → run (the failures show what's unwired) → implement → PASS.

#### Task 5.3: Web tab move without reload (D9), and PDF in two groups (D8)

**Files:**
- Modify: `test/e2e/split-editor.e2e.mjs`:
  - **E10:** serve a page over `127.0.0.1`, following `test/e2e/web-view.e2e.mjs`. Set
    `window.__marker = 1` in the guest through the webview's `executeJavaScript`, move the web tab
    to group 2, then read `__marker` again → `1`.
  - **Web focus:** click inside the guest while group 1 is active → group 2 becomes `data-active`.
    This measures the `focusin`-from-`<webview>` assumption (Decisions Needed #4).
  - **D8:** copy `test/e2e/fixtures/sample.pdf` into the repo, open it, and split. Close group 2's
    PDF tab → group 1's `.pdfview` still renders a page. Then open a second fresh PDF → it renders
    (no "corrupt or invalid PDF").
- Modify: `webview/app.tsx` / `webview/components/editor-groups.tsx`, only if a scenario fails on a
  real defect.

**Steps:**
- [ ] Build and run.
- [ ] **If E10 shows a reload, don't reparent and don't hack a restore.** Record it (D9 ruling):
  ship it, and in T7.1 add a CHANGELOG line and a run-report note.
- [ ] If web focus fails, bind the `<webview>`'s own `focus` event in `WebView` to an
  `onGuestFocus` prop, and route it to `onFocusGroup`. The file is
  `webview/components/web-view.tsx`: add it to the file map in the run report, since it's the
  pre-agreed fallback.

### Slice 6: v1: drag between strips, drag to the right edge, Ctrl-drag duplicate, Join

**Check:**
- `npx vitest run test/unit/doc-groups.test.ts test/unit/docs.test.ts` passes.
- `npm run build`, then `node test/e2e/run-smoke.mjs split-editor-drag` passes.
- `split-editor` still passes, and `split-regress.ps1` all PASS.

**Parallel groups:** Serial: T6.1 → T6.2 → T6.3
**Claims (serial lane):** `webview/docs.ts` (T6.1), `webview/components/doc-tabs.tsx`, `webview/components/editor-groups.tsx`, `webview/app.tsx`

#### Task 6.1: Reducer v1 actions (moved out of Slice 1 by the conductor)

**Files:**
- Modify: `webview/docs.ts`:
  - **`moveTab.duplicate?: boolean`:** on a `duplicate` kind, the source tab stays and a pinned tab
    is added to the target (or the existing one is activated).
  - **`moveTab` with `toGroup: 2` and no group 2:** creates group 2 (edge drop). The source tab is
    removed, or kept under `duplicate`.
  - **New action `{ type: 'joinGroups'; sessionId: string }`:**
    - For each group-2 tab in order: if it's already in group 1, drop it; else append it to group 1,
      pinned.
    - Remove group 2 and set `activeGroup = 1`.
    - Group 1's active becomes the previous `activeId` when that was group 2's active; otherwise
      it's unchanged.
    - Focus `s`, through `finalize`.
- Test: `test/unit/doc-groups.test.ts`:
  - 'moveTab duplicate leaves the source tab'
  - 'moveTab to group 2 with one group creates it'
  - 'joinGroups appends group-2-only tabs to group 1, drops duplicates, removes group 2'

**Interfaces:**
- Produces: `moveTab { sessionId; id; toGroup; beforeId?; duplicate?: boolean }` and
  `{ type: 'joinGroups'; sessionId: string }`.

**Steps:**
- [ ] Failing tests → implement → PASS. `docs.test.ts` stays untouched.

#### Task 6.2: Cross-strip drag state and drop targets

**Files:**
- Create: `webview/tab-drag.ts`:
  - `beginTabDrag(d: { id: string; group: GroupIndex; sessionId: string }): void`
  - `currentTabDrag(): { id: string; group: GroupIndex; sessionId: string } | null`
  - `endTabDrag(): void`
  - It replaces `DocTabs`' local `dragIdRef`, so the other strip can see the drag.
- Modify: `webview/components/doc-tabs.tsx`: dragstart and dragend use `tab-drag`. A drop from the
  other group calls `onMoveTab(id, group, targetId|null, e.ctrlKey)`. Within a group, `onReorder`
  is unchanged. The new prop is `onMoveTab?(id: string, toGroup: GroupIndex, beforeId: string | null, duplicate: boolean): void`.
- Modify: `webview/components/editor-groups.tsx`:
  - A body drop zone per group is active only while `currentTabDrag()` is non-null:
    - a drop from the other group → append
    - a drop from its own group → no-op
  - A right-edge zone (right third of group 1's body) shows only when there is one group; it has a
    half-width `.editorgroups__drop--edge` overlay and drops call `onMoveTab(id, 2, null, ctrl)`.
  - A session switch or a center-view change calls `endTabDrag()`.
- Modify: `webview/components/center-pane.tsx`: forward `onMoveTab`.
- Modify: `webview/styles.css`:
  - `.editorgroups__drop` (whole-group tint) and `.editorgroups__drop--edge` (right half), using
    the `--accent` tint alpha of `.tabbar__tail--over`
  - z-index 7 (above the web hosts' 6, inside `.editorgroups`' isolation)
  - static, with no transition (reduced motion)
- Test: `test/unit/doc-tabs-drag.test.ts` (keep green)
- Modify: `webview/app.tsx`. Extend `moveTabToGroup` to
  `(id, toGroup, beforeId: string | null, duplicate: boolean)`. `duplicate` means
  `copyViewState` / `copyHtmlView` instead of move. It dispatches `moveTab {…, duplicate}`, and a
  target of group 2 with one group creates it (T6.1).

**Interfaces:**
- Consumes: `moveTab {…, duplicate?}` (T6.1), `copyViewState(from, to)`, `copyHtmlView(from, to)`,
  and `moveTabToGroup` (T5.1, extended here), wired as `CenterPane.onMoveTab`.
- Produces: the `tab-drag.ts` API above; `CenterPane.onMoveTab`.

**Steps:**
- [ ] Create `test/e2e/split-editor-drag.e2e.mjs`, using real `mouse.down`/`move`/`up` drags as
  in `test/e2e/explorer-dnd*.e2e.mjs` (find the precedent by `ls test/e2e | grep dnd`):
  - 'drag a tab onto the other strip inserts at the drop position'
  - 'drag onto the right edge creates group 2'
  - 'Ctrl-drag duplicates'
  - 'Esc mid-drag changes nothing'
  - 'panel re-dock drag from the strip background still re-docks' (`.centerpane--droptarget`
    appears)
- [ ] Build → FAIL → implement → PASS.

#### Task 6.3: Join Editor Groups

**Files:**
- Modify: `webview/app.tsx`:
  - dispatch `joinGroups`
  - for each moved group-2-only tab, `moveViewState(tabStateKey(id, 2), tabStateKey(id, 1))`
  - add the palette entry and the group-2 strip menu item "Join Editor Groups"
- Modify: `webview/split-editor-copy.ts` (add `joinGroups`)
- Modify: `test/e2e/split-editor-drag.e2e.mjs`: 'Join moves group 2's tabs to the end of group 1
  and drops duplicates'.

**Interfaces:**
- Consumes: `joinGroups` action (T6.1), `moveViewState(from, to)`, `tabStateKey(docId, group)`,
  `SPLIT_COPY.joinGroups`.

**Steps:**
- [ ] Scenario → build → FAIL → implement → PASS.

### Slice 7: Changelog and the gate

**Check:** `npm run verify` exits 0 (log + `$LASTEXITCODE`), and `git status` shows only File map
paths.

**Claims (serial lane):** `CHANGELOG.md`

#### Task 7.1: Changelog, cleanup, verify

**Files:**
- Modify: `CHANGELOG.md`. Add an Unreleased `### Added` entry: Split editor (two groups, Ctrl+\,
  move, drag, resize, persisted); plus any D9 reload note from T5.3.

**Steps:**
- [ ] Run `npm run verify` through the heavy-lock wrapper. Output goes to
  `%TEMP%\claude-scratch\split-verify.log`; read `$LASTEXITCODE` and expect 0. Fix the code, never
  the check.
- [ ] Delete `%TEMP%\claude-scratch\split-regress.ps1` and its logs. Check `git status`.

## Verification

- **Per task:** `npx vitest related <touched files> --run` + `npm run typecheck`.
- **Per slice:** that slice's Check. Every e2e term runs alone, after `npm run build`, serially.
  The regression set goes through `split-regress.ps1`.
- **Once, at the end:** `npm run verify` (Slice 7). Never the full e2e suite.

## Deviation rule

If a task's assumption turns out wrong (a precondition missing, a signature that doesn't fit, a
dependency that merged in a different shape, an e2e that shows the mechanism differs), that task
**stops**, and fixing the misaligned piece becomes the work. Never a shim, second copy, special
case, widened type, fallback, or an override patched in place of its semantic source. In
particular:
- never a second save or dirty path beside `fileSaves`
- never a per-group copy of a doc
- never a `<webview>` reparent "just this once"

Report leads with the fix that keeps the locked decision.

## Decisions Needed

- **[resolved] #1 P1 representation.** The conductor locked the architecture critic's symmetric
  state (`docs` registry + `layouts` + an `activeId` cache written by `finalize`). `docs.test.ts` is
  rewritten accessor-only with no literal changes. The earlier asymmetric P1 is withdrawn.
- **[normal] #2 D1 ordering.** Spec D1 asks the *first* slice to reproduce the registry failure.
  The conductor ordered the reducer refactor first, so the reproduction is the red first step of
  Slice 2 (T2.1), before any registry change. Default: as planned.
- **[normal] #3 Peek-open group.** A navigation whose `source` is a peek widget's embedded editor
  (not registered) has no group, so it lands in the active group. Normally that's the peeked
  editor's group, because the click focused it. Default: accept.
- **[normal] #4 Web-tab focus.** Assumption: `focusin` bubbles from `<webview>` to the host `div`
  when the guest takes focus. Measured in T5.3, with a pre-agreed fallback of an `onGuestFocus` prop
  on `WebView`.
- **[normal] #5 Moved tabs are pinned (P4).** VS Code keeps preview on some moves. Default: pin
  (matches split-on-preview).
- **[normal] #6 Copy module.** `SPLIT_COPY` in one module instead of spec §10's per-component
  `STR`, following the newer `AUTO_SAVE_COPY` precedent. Default: one module.
- **[normal] #7 Join's active tab.** After Join, group 1's active is whatever was active before.
  The spec is silent. Default: keep the user's current tab.
- **[normal] #8 Unbound focus-group actions** render as "Unassigned" in Settings → Shortcuts. If
  the nav-keybindings item's `shortcuts-tab.tsx` can't show an empty default, T4.2 stops and
  reports.
- **[normal] #9 Close Editor Group prompts** run sequentially through the existing close-dirty
  flow, and the first Cancel stops the loop (tabs already closed stay closed). Default: accept.
- **[normal] #10 D9.** If T5.3 measures a reload despite the no-reparent grid placement, ship it
  and record it (conductor ruling).
- **[normal] #11 Cross-session persisted order.** `toPersistedDocs` groups entries per session
  instead of today's interleaved `docs[]` order. Single-session output is byte-identical, and
  restore is equivalent for any input. If a `docs.test.ts` literal encodes an interleave, T1.2
  stops and reports.
- **[normal] #12 Close fallback.** Spec §2.5's left-else-right replaces today's "last sibling"
  remembered-doc fallback when closing the first tab. If a `docs.test.ts` literal pins the old
  rule, T1.2 stops and reports rather than editing it.
- **[normal] #13 `subgrid`.** The web-host placement relies on `grid-template-rows: subgrid`
  (Chromium ≥117; Electron 43.3.0 is well past it). If the strip rows misalign, the fix is a fixed
  strip-row height token, never measured rects.

## Run notes

Build run 2026-09-28 (unattended), branch `feat/split-editor`, base `de36575`. Evidence and logs:
`G:\awby\projects\conduit\.autoloop\evidence\split-editor\`. Baseline `npm run verify` at the base: exit 0.

- **Slice 1 — done** (`621eb56`, `976f38a`, `d4e2165`). The Check is green, including the five regress terms.
  `docs.test.ts` was rewritten accessor-only. The whole-map identity checks
  `next.activeBySession toBe prev.activeBySession` became `remembered(next,'S1') toBe remembered(prev,'S1')`
  (4 places), because a background pin now changes `layouts`. Deviations:
  - (a) `cycleTab`, `navGoToTab` and the tab-menu close lists already read group 1's tab order. T3.2 swaps `1` for
    `activeGroupOf`.
  - (b) `doc-tabs-conflict.test.ts` got the `previewIds` fixture.
  - (c) The `splitRight` contract line "pin x's group-1 tab" was built as spec §4: the group-2 tab is pinned and
    group 1 stays preview. Only the commit-diff `@preview` slot is re-keyed first.
  - (d) `finalize` with focus `null` takes the shown session's active group's active tab, rather than keeping a
    stale `activeId`.
  - (e) `restore` skips ids owned by another session, and gives group 2 an active tab when the file names none.
- **Slice 2 — done** (`ce242dc`, `1dc9fc1`, `ff59038`, `ddac9aa`). The Check is green; `breadcrumbs` matches no
  e2e scenario, so it was dropped. **D1 measured TRUE**: all three single-slot registries lost the survivor
  (`evidence\split-editor\slice2-d1-repro.log`). Deviations:
  - (a) `groupOfEditor` uses a module-local editor→group map in `nav-editors.ts`, because `PathRegistry` has
    no whole scan.
  - (b) `requestNavFocus(path, g)` has no fallback to the other group.
  - (c) Open: MarkdownViewer's "View source" CodeViewer key `markdown-source:${path}` is still shared across
    groups. It is picked up in Slice 4 as a per-tab key.
- **Slice 3 — done** (`284379c`, `f13eb4a`, `c83a638`). The Check is green: the regress terms, `auto-save`,
  `changes-active-highlight` and `html-viewer`. Deviations:
  - (a) `save` takes no group. `saveActiveDoc` is per path and acts on `activeId` (S2).
  - (b) The Terminal-tab "Close editor tabs" uses `closeTab(id, 1)`.
  - (c) `fileChanged` bumps the HTML reload for each group holding the tab, and session close tombstones both
    groups' keys.
  - (d) `closeDoc` on an unknown id resolves `true`.
  - (e) `CenterPane` still receives group-1 wiring (`closeTab(id,1)`, menu group 1) until Slice 4.
- **Slice 4 — built** (`da0a8e7`, `6513df8`, `b7de49e`, `351fdc1`, `2fefc7e`, `05fb063`, `3c8cb6a`). `split-editor`
  (E1/E2/E3/E6/E8/E12/E13), `web-view`, `middle-click-web`, `web-blank-link`, `scrollback` and `attention` pass.
  **The regress set was RED (4/5)** because spec §9 makes the Terminal button `role="tab"`, and 25 e2e files
  read `.tabbar [role="tab"]` as "doc tabs". Session ruling (queued as a decision): the Terminal stays a plain
  button, as today, which keeps E14 "unchanged e2e". Adopting §9 later means updating those selectors. Fix-ups
  in Slice 4b:
  - `findConflicts` ignores an unbound (`''`) combo.
  - The TrustPrompt gets its own grid row, so a group-1 web host can't cover it.
  Other deviations:
  - The clamp also caps to [0.15, 0.85].
  - The icon reuses `IconSplit`.
  - The accent rule shows only while split.
  - `.webhost` joined the Aero ink-token scope.
  - `context-menu-order` expectations gained "Split Right".
  - `comboLabel` returns undefined for unbound.
  - The markdown source key is `tabStateKey('markdown-source:'+path, g)`. **T5.1 must move this key too.**
  - The focus-group commands are listed only while split.
- **Slice 4b/4c — done.**
  - `c44b73d`: the Terminal stays a plain button.
  - `436812d`: `findConflicts` ignores `''`.
  - `2a76469`: the trust prompt gets its own grid row. `.editorgroups` rows are `auto auto 1fr`. Group 2's body
    and web host span rows 2–3.
  - `6a965d1`: merge of main `8466702` (file-integrity). `moveFiles` is ported onto `layouts[s].groups[g]`, and
    main's `docs.test.ts` cases are accessor-only.
  - `11c3238`: the theme-tokens lookup string gains `.webhost`.
  - `3adf2fb`: **root cause of the nav-history AC3 regression.** The `switchSession` resync of the cached
    `activeId` ran in a passive effect. The per-group strip reads the layout directly, so for one frame Back
    was judged against a stale `null`. It is now a `useLayoutEffect`.
  - The regress set is 5/5 green again.
- **Slice 5 — done** (`c498daa`, `f4b892b`, `ad1a1cf`). The Check is green: `split-editor` plus
  `split-editor-surfaces`, the regress set, `pdf-viewer`, `web-view`, `file-integrity`, 21 review scenarios and
  `context-menu-order`. Measurements and deviations:
  - **E10:** no reload (D9 holds).
  - **#4:** the web guest focus reaches the host as neither a `focusin` nor a `<webview>` `focus`, only a window
    `blur` with `activeElement === <webview>`. `WebView.onGuestFocus` fires on that event, and `center-pane`
    routes it by `webPlacement`.
  - **D8:** it holds.
  - `html-viewer`'s source key is per tab, as markdown's is.
  - The e2e was split into `split-editor-surfaces.e2e.mjs` plus `split-editor-helpers.mjs` because of the 210s
    runner cap.
  - The RV assertion compares the card and offset across groups of different widths.
  - The palette entry title uses `SPLIT_COPY.moveToOther`.
- **Slice 6 — done** (`c156ebc`, `5a3e87e`, `83e1fa4`, `db42638`). The Check is green: `split-editor-drag`
  (ED/BD/SI/CD/OB/ES/JG/PD), all three `split-editor` files, `dnd` and `sidebar-dnd`, and the regress set.
  Deviations:
  - `tab-drag.ts` also exports `subscribeTabDrag` and `acceptTabDrop`.
  - `endTabDrag` on a session or center-view switch lives in `app.tsx`.
  - `EditorGroups` and `CenterPane` take `onMoveTab`.
  - A duplicate into the left group is not announced.
  - Join also clears the view state of the duplicates it drops.
  - The drop zones use `--accent-soft` plus a dashed `--accent` outline.
- **Slice 7 — done.** CHANGELOG (`988a538`). The first `npm run verify` was red on
  `files-drop-claim.test.ts`: `editor-groups.tsx` gained a dragover handler that needs a listed audit entry.
  The entry was added (`9e5cf8d`), and `npm run verify` then exited 0
  (`evidence\split-editor\final-verify.log`). No existing test was deleted, and no gate config changed.
