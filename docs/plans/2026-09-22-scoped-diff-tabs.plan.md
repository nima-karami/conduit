# Scoped diff tabs — implementation plan

**Spec:** `docs/specs/2026-09-22-scoped-diff-tabs.md`  **Tier:** FULL

Tier reason: multi-module (host protocol + persistence, docs reducer, viewer, app wiring, mock
bridge), a new persisted contract field, and parallel executors intended.

## Goal

A Changes row under **Staged** opens `<name> (Index)` (HEAD→index), a row under **Changes** opens
`<name> (Working Tree)` (index→worktree); both tabs coexist, stay current as the tree changes, and
survive a restart.

## Architecture

The scope is part of a diff doc's identity (`OpenDoc.diffScope`, id `diff@<scope>:<path>`) and
selects the cache key the tab reads (`diffKey(path, scope ?? 'all')`), which Review already writes.
All re-reads of open diff tabs go through one renderer-side queue that keeps at most one `readDiff`
in flight per key and coalesces later triggers into a single re-post. The viewer updates its Monaco
models in place so a refresh never flashes `Loading diff…` or loses the cursor; which of the
states in spec §2 renders is decided by one pure function. The host is untouched except for
persistence (`parseDocs` accepts diff docs) and a `readDiff` handler that always replies.

## Data flow

```
Changes row (right-pane ChangeRow)            Review card "Open side-by-side diff"
  diffScopeForChange(change) ─┐                 (review-view, at Review's scope) ─┐
                              ▼                                                   ▼
                app.tsx openDiff(path, session, { diffScope, sideBySide })
                  ├─ dispatchDocs({type:'open', kind:'diff', path, diffScope})   docs.ts: id/title
                  └─ diffReadQueue.request({path, diffScope})
                         │ post readDiff {path, ...scopeDiffArgs(diffScope ?? 'all')}
                         ▼
          electron/main.ts case 'readDiff' → readDiffReply(...) (never throws; error → DTO.error)
                         │ fileDiff {doc, base?, side?}
                         ▼
     app.tsx fileDiff handler: diffs.set(diffKey(path, scopeFromDiffArgs(msg))) ; queue.settle(key)
                         ▼
     center-pane: live = diffs.get(diffTabKey(doc)); held[doc.id] = last live; DocView(diff = live ?? held)
                         ▼
     doc-view: diffTabState(diff, scope) → notice | DiffViewer (models updated in place)

Refresh triggers → rereadOpenDiffs(match) → queue.request(target) for each distinct open-tab key:
  (a) fsChanged{root}        match: isUnderRoot(root, doc.path)
  (b) runGit / discardAll    match: isUnderRoot(gitRoot, doc.path)
  (c) invalidateDiff(abs)    match: doc.path === canonicalPath(abs)   (eviction stays as today)
  (e) activeId change        match: doc.sessionId === activeId
Missing-key effect (covers (d) restore, reopen, and eviction): queue.ensure(target) for every open
diff doc whose key is absent from `diffs`.
Persistence: docs.ts toPersistedDocs → persistDocs → host docs.json → parseDocs → restoreDocs →
reducer restore → missing-key effect.
```

## Settled decisions — do not re-litigate

- Scope values `'staged' | 'unstaged'`; absent = unscoped (HEAD→worktree). `readDiff` args come
  from `scopeDiffArgs` in `webview/review-scope.ts`.
- Doc id: unscoped `diff:<path>` (unchanged); scoped `diff@staged:<path>`, `diff@unstaged:<path>`.
  Ids are opaque — nothing parses them.
- Titles: `<name>`, `<name> (Index)`, `<name> (Working Tree)`, built only in `docs.ts`
  `initialTitle`.
- Routing: Staged-group row → `staged`; Changes-group row → `unstaged`; conflicted row (either
  group) → unscoped (D3). Review card → Review's scope (`all` → unscoped), side-by-side. Every
  other opener (context-menu "Open diff", file tree, palette file entries) stays unscoped.
- Every diff open is permanent (`openDiff` never passes `mode`).
- **D1 (conductor ruling): no hunk Stage/Unstage/Discard in diff tabs.** Recorded in the spec as a
  follow-up. No `review-hunks`/`applyHunkAction` wiring in the diff tab, no current-hunk logic.
- **D2:** diff tabs (scoped and unscoped) persist through `PersistedDoc.diffScope` and
  `parseDocs`; `DOCS_VERSION` stays 1. `test/unit/persistence.test.ts`'s file-only assertion is
  updated to the new contract, not deleted.
- **D3** conflicted rows unscoped · **D4** refresh covers unscoped tabs too · **D5** scoped
  empty-side notice added, unscoped tabs don't get it · **D6** Changes-row keyboard operability
  not addressed · **D7** measured below; failure maps to the Error state via `FileDiffDTO.error`.
- Render precedence for a diff tab: loading → error → conflicted → oversize → image → binary →
  empty side (scoped only) → populated.
- `invalidateDiff` keeps evicting every scope's key for the path (Review's request-once guard
  depends on it).
- `sideBySide` is still not persisted.
- `forceCloseDoc` calls `clearDirty` only for `kind:'file'`.

## Spec staleness

- **§3 "Hunks and navigation", "Current hunk", "Hunk actions", §8/§9 hunk-control rows, the
  hunk Gherkin scenario, the current-hunk unit test:** removed by the D1 ruling; the spec is
  amended in the same commit as this plan. `hasChanges` is still re-derived (spec §3 said "from
  the hunk list"); this plan derives it from Monaco's `onDidUpdateDiff` instead, since there is
  no hunk list without D1.
- **D7 — how `readDiff` fails (measured by source):** `src/file-service.ts:221` `readDiff`
  swallows every read failure (`gitShow(...).catch(() => '')`, the worktree read's `try/catch`,
  `electron/main.ts:833` `gitShow` returns `''` when the path is outside any repo). The only
  escape is a throw, which `electron/main.ts:3399` turns into a path-less `{type:'error'}` modal
  and leaves the tab on `Loading diff…` forever. The plan adds `readDiffReply` so a throw becomes
  `fileDiff` with `doc.error`. Consequence: spec §4 "The repo is gone or unreadable on restore →
  Error state" does not hold — a vanished repo reads as empty blobs, so a scoped tab shows the
  empty-side notice and an unscoped one an empty diff. Recorded under Decisions Needed; the spec
  row is amended.
- **§3 "Refresh … (d) restore":** implemented as a missing-key effect rather than a restore hook;
  the observable behavior is identical and it also covers reopen and eviction.
- **§10 focus "If the tab moves to a notice, focus goes to the notice container"**: that rule
  existed for in-tab hunk ops (D1). A background refresh must never move focus, so the rule is
  narrowed to Retry (the only in-tab action that changes state).

## Global constraints

- Gate: `npm run verify` (format-check, lint, dead-code, duplication, typecheck both tsconfigs,
  unit tests, security). Green before a slice is claimed done. Never disable or narrow a check.
- Unit tests: `npx vitest run test/unit/<name>.test.ts`. E2E: `npm run build` then
  `node test/e2e/run-smoke.mjs scoped-diff-tabs` — hidden (the runner sets `CONDUIT_E2E=1`),
  serial, never alongside another e2e. A PTY-looking failure is re-run alone before it is believed.
- Comments: WHY only; a decision already in the spec gets a one-line pointer
  (`// see spec 2026-09-22-scoped-diff-tabs §3`), never a re-explanation.
- Renderer code may not import `node:*` or `src/path-guard.ts`; path containment in the renderer
  is `isUnderRoot` from `src/repo-rel.ts` (node-free, case-folds Windows roots).
- CI runs on ubuntu: no test may rely on `\` separators or drive-letter casing behaving the
  win32 way. Unit fixtures use POSIX paths.
- Naming: files kebab-case in `webview/` (pure modules) and `webview/components/` (React);
  exported copy constants SCREAMING_SNAKE; types PascalCase.
- No `as any`, `@ts-ignore`, `!important`, or widened types to route around a mismatch.
- `CHANGELOG.md` is owned by the pipeline's ship stage, not by any task here.

## Out of scope

Host `readDiff` itself; Review's scopes and its request-once guard; `commit-diff`; the editor
gutter/change peek; hunk actions in diff tabs (D1); rename detection; a scope switcher inside a
tab; Changes-row keyboard access (D6); watching a linked worktree's external index.

## Contracts

```ts
// src/protocol.ts
export type DiffTabScope = 'staged' | 'unstaged';
export interface PersistedDoc {
  kind: 'file' | 'diff' | 'commit-diff' | 'review' | 'git-history' | 'web';
  path: string;
  sessionId: string;
  preview?: boolean;
  active?: boolean;
  /** diff docs only; absent = unscoped. */
  diffScope?: DiffTabScope;
}
export interface FileDiffDTO {
  /* …existing fields unchanged… */
  /** The host could not produce this diff at all. head/work are ''. */
  error?: string;
}

// src/persistence.ts — parseDocs keeps an entry iff:
//   kind ∈ {'file','diff'} && typeof path === 'string' && typeof sessionId === 'string'
//   && (diffScope === undefined || (kind === 'diff' && (diffScope === 'staged' || diffScope === 'unstaged')))
// A present-but-invalid diffScope, or a diffScope on a file entry, drops the entry.

// src/file-service.ts
export async function readDiffReply(
  absPath: string,
  gitShow: (p: string, ref: DiffBase) => Promise<string | Unmerged>,
  gitShowBuffer: ((p: string, ref: DiffBase) => Promise<Buffer | null | Unmerged>) | undefined,
  scope: DiffScope,
): Promise<FileDiffDTO>;
// = readDiff(...) ; on throw → { path: absPath, head: '', work: '', binary: false, error: message }

// webview/docs.ts
export interface OpenDoc { /* …existing… */ diffScope?: DiffTabScope; }   // kind 'diff' only
type DocsAction = …
  | { type: 'open'; kind: DocKind; path: string; sessionId: string; mode?: OpenMode;
      sideBySide?: boolean; diffScope?: DiffTabScope }
const idOf = (kind: DocKind, path: string, diffScope?: DiffTabScope): string =>
  // kind === 'diff' && diffScope ? `diff@${diffScope}:${path}` : `${kind}:${path}`
function initialTitle(kind: DocKind, path: string, diffScope?: DiffTabScope): string;
  // diff + scope → diffTabTitle(titleOf(path), diffScope)
// 'restore' reads pd.diffScope; toPersistedDocs writes diffScope when present.

// webview/diff-tab-scope.ts  (new — what a scope means for a diff tab; pure)
import type { ChangeDTO, DiffTabScope, FileDiffDTO } from '../src/protocol';
export const DIFF_SCOPE_SUFFIX: Record<DiffTabScope, string> = { staged: ' (Index)', unstaged: ' (Working Tree)' };
export function diffTabTitle(name: string, scope: DiffTabScope): string;          // `${name}${suffix}`
export function diffScopeForChange(change: Pick<ChangeDTO, 'staged' | 'conflicted'>): DiffTabScope | undefined;
  // conflicted → undefined; staged → 'staged'; else 'unstaged'
export function changeRowTooltip(change: Pick<ChangeDTO, 'staged' | 'conflicted'>): string;
  // 'Open diff' | 'Open staged diff' | 'Open unstaged diff'
export function diffTabKey(doc: { path: string; diffScope?: DiffTabScope }): string;
  // diffKey(doc.path, doc.diffScope ?? 'all')
export type DiffTabState =
  | 'loading' | 'error' | 'conflicted' | 'oversize' | 'image' | 'binary' | 'empty' | 'populated';
export function diffTabState(diff: FileDiffDTO | undefined, scope: DiffTabScope | undefined): DiffTabState;
  // precedence: !diff→loading; diff.error→error; scope&&diff.unmerged→conflicted; oversize; image;
  // binary; scope && head===work → empty; else populated
export function emptySideNotice(scope: DiffTabScope, name: string): string;
  // 'No staged changes in {name}.' | 'No unstaged changes in {name}.'  (one whole template per scope)
export const CONFLICTED_NOTICE = 'Conflicted file — there is no staged version to compare against.';
export const DIFF_READ_ERROR_NOTICE = "Couldn't read this diff.";

// webview/closed-tabs.ts
export interface ClosedTab { kind: ReopenableKind; path: string; sessionId: string; diffScope?: DiffTabScope }
export function toClosedTab(doc: Pick<OpenDoc, 'kind' | 'path' | 'sessionId' | 'diffScope'>): ClosedTab | null;

// webview/recent-docs.ts  (new — the palette's per-session recents list; pure)
export interface RecentDoc { kind: 'file' | 'diff'; path: string; diffScope?: DiffTabScope }
export const RECENT_DOC_LIMIT = 10;
export function pushRecentDoc(list: readonly RecentDoc[], entry: RecentDoc): RecentDoc[];
  // entry first; dedupe on (kind, path, diffScope ?? 'all'); cap RECENT_DOC_LIMIT
export function recentPaletteId(entry: RecentDoc): string;   // `recent:${kind}:${diffScope ?? 'all'}:${path}`
export function recentSubtitle(entry: RecentDoc): string | undefined;
  // file → undefined; diff → 'diff' | 'diff (Index)' | 'diff (Working Tree)'

// webview/diff-read-queue.ts  (new — at most one readDiff in flight per open-tab key)
import type { DiffTabScope } from '../src/protocol';
import type { OpenDoc } from './docs';
export interface DiffReadTarget { path: string; diffScope?: DiffTabScope }
export interface DiffReadQueue {
  /** Content may be stale: post now if idle, else mark dirty (one re-post when the reply lands). */
  request(target: DiffReadTarget): void;
  /** Content is missing: post only if nothing is in flight for this key; never marks dirty. */
  ensure(target: DiffReadTarget): void;
  /** A fileDiff for `key` arrived: re-post once if dirty, else go idle. Unknown keys are ignored. */
  settle(key: string): void;
}
export function createDiffReadQueue(send: (target: DiffReadTarget) => void): DiffReadQueue;
export function diffReadTargets(
  docs: readonly OpenDoc[],
  match: (doc: OpenDoc) => boolean,
): DiffReadTarget[];   // kind==='diff' && match, deduped by diffTabKey, in docs order

// webview/mock.ts
export function mockDiffFor(path: string, scope: DiffScope): { head: string; work: string };
  // leaf lookup as bridge does today; mockIndex[leaf] (new, for 'page.tsx') is the index blob.
  // unscoped: {head, work} byte-identical to today (fallback 'const a = 1;\n' / 'const a = 2;\n')
  // staged:   {head, work: index}   unstaged: {head: index, work}   index defaults to head

// webview/app.tsx
openDiff(path: string, targetSessionId?: string,
         opts?: { sideBySide?: boolean; diffScope?: DiffTabScope }): void
  // path = canonicalPath(path); queue.request({path, diffScope}); dispatch open; pushRecent
onOpenReviewDiff(path: string, scope: ReviewScope): void
  // openDiff(path, undefined, { sideBySide: true, diffScope: scope === 'all' ? undefined : scope })
rereadOpenDiffs(match: (doc: OpenDoc) => boolean): void   // useCallback, reads docsRef.current

// webview/components/right-pane.tsx — every `onOpenDiff` prop (ChangeRow, ChangesView, RightPane)
onOpenDiff: (relPath: string, diffScope: DiffTabScope | undefined) => void;

// webview/components/review-view.tsx
onOpenDiff?: (absPath: string, scope: ReviewScope) => void;   // ReviewView prop only; the card's
                                                               // own prop keeps (absPath) => void
// webview/components/center-pane.tsx
onOpenReviewDiff: (absPath: string, scope: ReviewScope) => void;
onRetryDiff: (doc: OpenDoc) => void;      // → queue.request({ path: doc.path, diffScope: doc.diffScope })
onOpenFullDiff: (doc: OpenDoc) => void;   // → openDiff(doc.path, doc.sessionId)

// webview/components/doc-view.tsx — new optional props passed through to the diff branch
onRetryDiff?: (doc: OpenDoc) => void;
onOpenFullDiff?: (doc: OpenDoc) => void;

// webview/components/diff-viewer.tsx
DiffViewer props gain: showWhitespace?: boolean   // true → ignoreTrimWhitespace: false
```

Invariants: a scoped tab never reads the unscoped key; `diffKey(p,'all') === p` still holds; no
two docs share an id; the queue never has two requests in flight for one key it posted.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Row → scope | `right-pane.tsx` ChangeRow (`diffScopeForChange`) from host `ChangeDTO.staged/conflicted` | `app.tsx` `openDiff` | Renderer both sides; host `src/project-info.ts` unchanged (spec measured MM → two rows) |
| Review card → scope | `review-view.tsx` (`scope = scopeOfSource(source)`) | `center-pane` → `app.tsx` `onOpenReviewDiff` | Both |
| Scoped `readDiff`/`fileDiff` | `openDiff`, queue re-posts; host echoes base/side | `app.tsx` fileDiff handler → `diffs` → center-pane → DocView | Both; host `readDiff` unchanged, handler wraps it |
| Cache key eviction | `invalidateDiff` (hunk ops from Review / change peek) | Review cards (request-once) and diff tabs (missing-key effect + explicit request) | Both; Review unchanged |
| `FileDiffDTO.error` | `readDiffReply` (host) | `diffTabState` → Error notice | Both. Other `FileDiffDTO` consumers (Review cards, commit view, editor gutter) never see it set except on a thrown read; they already treat empty head/work as "no diff" — checked: `review-view.tsx`, `commit-view.tsx`, `use-change-markers.ts` read only head/work/binary/image/oversize/unmerged |
| `OpenDoc.diffScope` / id / title | `docs.ts` reducer | tab strip (title), center-pane key, view-state (`doc.id`), persistence, closed tabs, recents | All in plan |
| `PersistedDoc.diffScope` + diff kind restore | `docs.ts` `toPersistedDocs` (already emits diff docs; gains diffScope) | host `parseDocs` → `restoreDocs` → reducer `restore` | Both |
| Recents entry shape | `app.tsx` `pushRecent` → `pushRecentDoc` | `app.tsx` `recentItems` | Both |
| Closed-tab descriptor | `forceCloseDoc` → `toClosedTab` | `reopenClosedTab` | Both |
| Dirty flag on close | `forceCloseDoc` | `dirty-store` consumers | Producer only; consumers unchanged (they just stop losing a file's flag when a diff tab closes) |
| Mock `readDiff` | `webview/bridge.ts` via `mockDiffFor` | same renderer paths as the host reply | Both |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/protocol.ts` | modify | `DiffTabScope`; `PersistedDoc.diffScope`; `FileDiffDTO.error` |
| `src/persistence.ts` | modify | `parseDocs` accepts `diff` with a valid optional `diffScope` |
| `src/file-service.ts` | modify | `readDiffReply` (never-throwing wrapper over `readDiff`) |
| `electron/main.ts` | modify | `case 'readDiff'` calls `readDiffReply` |
| `webview/diff-tab-scope.ts` | create | scope routing, titles, cache key, render-state precedence, notice copy |
| `webview/diff-read-queue.ts` | create | per-key in-flight/dirty coalescing and open-tab target selection |
| `webview/recent-docs.ts` | create | recents list push/dedupe, palette id, subtitle |
| `webview/docs.ts` | modify | `diffScope` in `OpenDoc`, `open`, `idOf`, `initialTitle`, `restore`, `toPersistedDocs` |
| `webview/closed-tabs.ts` | modify | `ClosedTab.diffScope`, `toClosedTab` carries it |
| `webview/app.tsx` | modify | openDiff/onOpenReviewDiff/reopen/recents/forceCloseDoc; queue + triggers; retry/full-diff handlers |
| `webview/components/right-pane.tsx` | modify | ChangeRow scope routing + tooltip; `onOpenDiff` signature through ChangesView/RightPane |
| `webview/components/review-view.tsx` | modify | `onOpenDiff(abs, scope)` |
| `webview/components/center-pane.tsx` | modify | read by `diffTabKey`; last-rendered hold; new prop pass-through |
| `webview/components/doc-view.tsx` | modify | diff branch switches on `diffTabState`; notices, Retry, Open full diff, live region |
| `webview/components/diff-viewer.tsx` | modify | editor created once per path; models updated in place; `hasChanges` from `onDidUpdateDiff`; `showWhitespace` |
| `webview/mock.ts` | modify | `mockIndex`, `mockDiffFor` |
| `webview/bridge.ts` | modify | mock `readDiff` uses `mockDiffFor` |
| `test/unit/persistence.test.ts` | modify | new parseDocs contract |
| `test/unit/file-service-diff.test.ts` | modify | `readDiffReply` error mapping |
| `test/unit/diff-tab-scope.test.ts` | create | routing, title, key, state precedence, copy |
| `test/unit/docs.test.ts` | modify | scoped identity, title, restore, toPersistedDocs |
| `test/unit/closed-tabs.test.ts` | modify | scope round-trip |
| `test/unit/recent-docs.test.ts` | create | dedupe, cap, palette id, subtitle |
| `test/unit/diff-read-queue.test.ts` | create | coalescing and target selection |
| `test/unit/mock-diff.test.ts` | create | mock output per scope |
| `test/e2e/scoped-diff-tabs.e2e.mjs` | create | the spec §7 Gherkin (amended) in the real app |

`webview/components/diff-controls-bar.tsx` is **not** modified (D1).

## Scripts

None. No routine repeats across more than a handful of files; the e2e fixture repo is built
inline in the scenario, as `test/e2e/review-scope.e2e.mjs` does.

## Slices

### Slice 1: Host contract — persistence and a readDiff that always replies

**Check:** `npx vitest run test/unit/persistence.test.ts test/unit/file-service-diff.test.ts`
green, and `npm run typecheck` green.

**Parallel groups:** Serial: T1.1, T1.2
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`

#### Task 1.1: Protocol types and parseDocs

**Files:**
- Modify: `src/protocol.ts` (add `DiffTabScope` beside `PersistedDoc`; `PersistedDoc.diffScope?`;
  `FileDiffDTO.error?`)
- Modify: `src/persistence.ts` (`parseDocs` predicate)
- Test: `test/unit/persistence.test.ts`

**Interfaces:**
- Produces: `export type DiffTabScope = 'staged' | 'unstaged'`; `PersistedDoc.diffScope?: DiffTabScope`;
  `FileDiffDTO.error?: string`; `parseDocs(blob: string | undefined): PersistedDoc[]` with the
  predicate in Contracts.
- Consumes: nothing new.

**Call sites:** `parseDocs` — `electron/main.ts` (restoreDocs path); unchanged signature.

**Steps:**
- [ ] Failing tests: rename "drops malformed entries (non-file kind / missing fields)" to "drops
      malformed entries (unknown kind / bad diffScope / missing fields)"; the blob gains
      `{kind:'diff',path:'/x.ts',sessionId:'S1'}` (kept), `{kind:'diff',path:'/s.ts',sessionId:'S1',diffScope:'staged'}`
      (kept), `{kind:'diff',path:'/b.ts',sessionId:'S1',diffScope:'bogus'}` (dropped),
      `{kind:'file',path:'/f.ts',sessionId:'S1',diffScope:'staged'}` (dropped),
      `{kind:'review',path:'@review',sessionId:'S1'}` (dropped) — key assertion: `parseDocs(blob)`
      equals exactly the three kept entries in order. New test "round-trips scoped diff docs with
      preview/active" — `parseDocs(serializeDocs(docs))` equals docs for
      `[{kind:'diff',path:'/a.ts',sessionId:'S1',diffScope:'unstaged',active:true}, {kind:'diff',path:'/a.ts',sessionId:'S1'}]`.
- [ ] Run `npx vitest run test/unit/persistence.test.ts` — expect FAIL (diff entries dropped).
- [ ] Implement the types and the predicate.

#### Task 1.2: readDiffReply

**Files:**
- Modify: `src/file-service.ts` (export `readDiffReply` below `readDiff`)
- Modify: `electron/main.ts` (`case 'readDiff'`, ~line 2263: `doc: await readDiffReply(m.path, gitShow, gitShowBuffer, scope)`)
- Test: `test/unit/file-service-diff.test.ts`

**Interfaces:**
- Produces: `readDiffReply(absPath, gitShow, gitShowBuffer, scope): Promise<FileDiffDTO>` (Contracts).
- Consumes: `FileDiffDTO.error?: string` (T1.1).

**Call sites:** `readDiff` keeps its only production caller replaced by `readDiffReply`; the
existing `readDiff` unit tests stay as they are. Check with `npm run fallow:check` that `readDiff`
is still referenced (it is, by `readDiffReply` and tests).

**Steps:**
- [ ] Failing test: 'readDiffReply maps a thrown read to an error DTO' — `gitShow = () => { throw new Error('boom') }`
      (synchronous throw, which `readDiff`'s `.catch` can't absorb) — key assertion: result equals
      `{ path: '/r/a.ts', head: '', work: '', binary: false, error: 'boom' }`. Second test
      'readDiffReply passes a normal read through' — equals `await readDiff(...)` for the same fakes.
- [ ] Run `npx vitest run test/unit/file-service-diff.test.ts` — expect FAIL (export missing).
- [ ] Implement; wire `electron/main.ts`.

### Slice 2: Scoped doc identity and routing

**Check:** `npx vitest run test/unit/diff-tab-scope.test.ts test/unit/docs.test.ts test/unit/closed-tabs.test.ts test/unit/recent-docs.test.ts`
green; `npm run build && node test/e2e/run-smoke.mjs scoped-diff-tabs` passes scenarios 1–3 and
"Conflicted row opens unscoped".

**Parallel groups:** Serial (first): T2.1 · G1: T2.2 · G2: T2.3 · G3: T2.4 · Serial: T2.5, T2.6
(T2.2–T2.4 all import from T2.1's module, so T2.1 lands before the groups fan out.)
**Claims (serial lane):** `webview/app.tsx`, `webview/components/center-pane.tsx`, `test/e2e/scoped-diff-tabs.e2e.mjs`

#### Task 2.1: diff-tab-scope routing, title, key

**Files:**
- Create: `webview/diff-tab-scope.ts` (only `DIFF_SCOPE_SUFFIX`, `diffTabTitle`,
  `diffScopeForChange`, `changeRowTooltip`, `diffTabKey` in this task)
- Test: `test/unit/diff-tab-scope.test.ts`

**Interfaces:**
- Produces: `diffTabTitle(name: string, scope: DiffTabScope): string`;
  `diffScopeForChange(change: Pick<ChangeDTO,'staged'|'conflicted'>): DiffTabScope | undefined`;
  `changeRowTooltip(change: Pick<ChangeDTO,'staged'|'conflicted'>): string`;
  `diffTabKey(doc: { path: string; diffScope?: DiffTabScope }): string`.
- Consumes: `DiffTabScope` from `src/protocol.ts`; `diffKey` from `webview/review-scope.ts`.

**Steps:**
- [ ] Failing tests: 'routes a staged row to staged, an unstaged or untracked row to unstaged, a
      conflicted row to unscoped' — `diffScopeForChange({staged:true,conflicted:true}) === undefined`;
      'tooltips name the side' — `'Open staged diff'` / `'Open unstaged diff'` / `'Open diff'`;
      'title suffixes' — `diffTabTitle('both.ts','staged') === 'both.ts (Index)'`;
      'unscoped key is the bare path' — `diffTabKey({path:'/r/a.ts'}) === '/r/a.ts'` and
      `diffTabKey({path:'/r/a.ts',diffScope:'staged'}) === diffKey('/r/a.ts','staged')`.
- [ ] Run `npx vitest run test/unit/diff-tab-scope.test.ts` — expect FAIL (module missing).
- [ ] Implement.

#### Task 2.2: docs reducer and closed tabs carry the scope

**Files:**
- Modify: `webview/docs.ts` (`OpenDoc.diffScope`, `'open'` action field, `idOf`, `initialTitle`,
  `'open'` case, `'restore'` case, `toPersistedDocs`)
- Modify: `webview/closed-tabs.ts` (`ClosedTab.diffScope?`, `toClosedTab` Pick + copy)
- Test: `test/unit/docs.test.ts`, `test/unit/closed-tabs.test.ts`

**Interfaces:**
- Produces: `OpenDoc.diffScope?: DiffTabScope`; `DocsAction 'open'` with `diffScope?: DiffTabScope`;
  `ClosedTab.diffScope?: DiffTabScope`;
  `toClosedTab(doc: Pick<OpenDoc,'kind'|'path'|'sessionId'|'diffScope'>): ClosedTab | null`.
- Consumes: `DiffTabScope`, `PersistedDoc.diffScope` (T1.1);
  `diffTabTitle(name: string, scope: DiffTabScope): string` (T2.1) — `initialTitle` returns
  `diffTabTitle(titleOf(path), diffScope)` for a scoped diff. The import cycle
  docs → diff-tab-scope → review-scope → docs is type-only on the last edge and erased.

**Call sites:** `toClosedTab` — `webview/app.tsx` `forceCloseDoc` (passes a full `OpenDoc`,
compatible). `idOf` — `open`, `restore`, `pinDoc` (commit-diff only; passes no scope).

**Steps:**
- [ ] Failing tests in `docs.test.ts`: 'scoped diff docs have distinct ids and titles' — opening
      `/r/both.ts` as staged, unstaged and unscoped yields 3 docs with ids `diff@staged:/r/both.ts`,
      `diff@unstaged:/r/both.ts`, `diff:/r/both.ts` and titles `both.ts (Index)`,
      `both.ts (Working Tree)`, `both.ts`; 'reopening a scoped diff activates it' — second open
      with the same scope leaves `docs.length` unchanged and `activeId` on it; 'restore keeps the
      scope' — restore of a persisted `{kind:'diff',path:'/r/a.ts',sessionId:'S1',diffScope:'staged',active:true}`
      yields id `diff@staged:/r/a.ts`, title `a.ts (Index)`, `diffScope:'staged'`,
      `activeBySession.S1` = that id; 'toPersistedDocs writes diffScope and active' — round trip
      through `toPersistedDocs` then `restore` equals the original docs' `{id,title,diffScope}`.
      In `closed-tabs.test.ts`: 'a scoped diff keeps its scope' —
      `toClosedTab({kind:'diff',path:'/a',sessionId:'s1',diffScope:'unstaged'})` equals
      `{kind:'diff',path:'/a',sessionId:'s1',diffScope:'unstaged'}`, and an unscoped one has no
      `diffScope` key.
- [ ] Run `npx vitest run test/unit/docs.test.ts test/unit/closed-tabs.test.ts` — expect FAIL.
- [ ] Implement. `diffScope` is only ever set on `kind:'diff'` docs; spread it only when defined
      (the reducer's existing `...(x !== undefined ? {x} : {})` style).

#### Task 2.3: recent-docs

**Files:**
- Create: `webview/recent-docs.ts`
- Test: `test/unit/recent-docs.test.ts`

**Interfaces:**
- Produces: `RecentDoc`, `RECENT_DOC_LIMIT = 10`, `pushRecentDoc(list, entry): RecentDoc[]`,
  `recentPaletteId(entry): string`, `recentSubtitle(entry): string | undefined` (Contracts).
- Consumes: `DiffTabScope` (T1.1); `DIFF_SCOPE_SUFFIX: Record<DiffTabScope, string>` (T2.1) —
  `recentSubtitle` returns `diff${DIFF_SCOPE_SUFFIX[scope]}` for a scoped diff.

**Steps:**
- [ ] Failing tests: 'dedupes on kind, path and scope' — pushing diff `/a` staged, then diff `/a`
      unstaged, then diff `/a` staged gives `[staged, unstaged]` (length 2, staged first);
      'caps at 10'; 'palette ids differ per scope' — `recentPaletteId({kind:'diff',path:'/a',diffScope:'staged'}) === 'recent:diff:staged:/a'`
      and unscoped `'recent:diff:all:/a'`; 'subtitle' — `'diff (Index)'`, `'diff'`, `undefined` for file.
- [ ] Run `npx vitest run test/unit/recent-docs.test.ts` — expect FAIL.
- [ ] Implement.

#### Task 2.4: Changes rows and Review card pass the scope

**Files:**
- Modify: `webview/components/right-pane.tsx` (ChangeRow `onClick` → `onOpenDiff(change.path, diffScopeForChange(change))`,
  `title={changeRowTooltip(change)}`; the `onOpenDiff` prop type on ChangeRow (~line 120),
  ChangesView (~172) and RightPane (~1719))
- Modify: `webview/components/review-view.tsx` (ReviewView prop `onOpenDiff?: (absPath: string, scope: ReviewScope) => void`;
  a `useCallback` `openDiffAtScope = (abs: string) => onOpenDiff?.(abs, scope)` handed to the card
  at ~line 1963 only when `onOpenDiff` is defined; the card's own prop type is unchanged)

**Interfaces:**
- Produces: `onOpenDiff: (relPath: string, diffScope: DiffTabScope | undefined) => void` (right-pane);
  `ReviewView.onOpenDiff?: (absPath: string, scope: ReviewScope) => void`.
- Consumes: `diffScopeForChange`, `changeRowTooltip` (T2.1).

**Call sites:** RightPane's `onOpenDiff` is supplied at `webview/app.tsx:3096`; ReviewView's at
`webview/components/center-pane.tsx:330` — both updated in T2.5 (typecheck is red between T2.4
and T2.5; T2.5 is the serial task that closes it).

**Steps:**
- [ ] No unit test (React wiring; the routing rule is T2.1's test). Proof is T2.6's e2e.
- [ ] Implement.

#### Task 2.5: App wiring for scoped open, reopen, recents, close

**Files:**
- Modify: `webview/app.tsx` — `openDiff` (~1469): `canonicalPath`, `opts.diffScope`, post
  `readDiff` with `...scopeDiffArgs(diffScope ?? 'all')`, dispatch `diffScope`, `pushRecent`;
  `onOpenReviewDiff` (~1488) signature `(path, scope)`; `reopenClosedTab` (~1507) passes
  `{ diffScope: tab.diffScope }`; `recentsBySession` state typed `Record<string, RecentDoc[]>`,
  `pushRecent(entry: RecentDoc, sessionId)` via `pushRecentDoc`, `recentItems` (~2476) use
  `recentPaletteId`/`recentSubtitle` and `run: () => r.kind === 'file' ? openFile(r.path) : openDiff(r.path, undefined, { diffScope: r.diffScope })`;
  `forceCloseDoc` (~1346) `if (doc.kind === 'file') clearDirty(doc.path)`; RightPane
  `onOpenDiff` (~3096) `(rel, scope) => active && openDiff(joinPath(gitRootForSession(active), rel), undefined, { diffScope: scope })`.
  The context-menu "Open diff" (~2180) stays unscoped.
- Modify: `webview/components/center-pane.tsx` — `onOpenReviewDiff` prop type
  `(absPath: string, scope: ReviewScope) => void`; DocView `diff={diffs.get(diffTabKey(activeDoc))}`.

**Interfaces:**
- Produces: `openDiff(path, targetSessionId?, opts?: { sideBySide?: boolean; diffScope?: DiffTabScope })`;
  `onOpenReviewDiff(path: string, scope: ReviewScope)`.
- Consumes: T2.1 `diffTabKey`; T2.2 `DocsAction 'open'.diffScope`, `ClosedTab.diffScope`;
  T2.3 `RecentDoc`, `pushRecentDoc`, `recentPaletteId`, `recentSubtitle`; T2.4 prop signatures.

**Call sites of `openDiff`:** `app.tsx` 1489 (onOpenReviewDiff), 1507 (reopen), 2180 (context
menu), 2483 (recents), 3096 (RightPane). `pushRecent` callers: `openFile` (~1456, becomes
`pushRecent({kind:'file', path}, sid)`) and `openDiff`.

**Steps:**
- [ ] `npm run typecheck` green (closes T2.4's open signatures).
- [ ] `npx vitest run` green.

#### Task 2.6: E2E — routing scenarios

**Files:**
- Create: `test/e2e/scoped-diff-tabs.e2e.mjs`

**Interfaces:** consumes the built app only.

**Steps:**
- [ ] Scaffold on `test/e2e/harness.mjs` exactly like `test/e2e/review-scope.e2e.mjs`
      (`runScenario`, `openSession`, `execFileSync('git', …)`, temp repo under `tmpdir()`), plus a
      dedicated `--user-data-dir` from `mkdtempSync` as `test/e2e/editor-tabs-persist.e2e.mjs`
      does (Slice 3 relaunches on it). Background per spec §7: 20-line `both.ts`, line 2 →
      `MARK_STAGED_SIDE` staged, line 18 → `MARK_UNSTAGED_SIDE` unstaged; assert
      `git status --porcelain both.ts` starts with `MM`.
- [ ] Helpers: `tabTitles(page)` (exact strings of the tab strip), `activeTabTitle(page)`,
      `changedSides(page)` reading `monaco.editor.getModels()` of the active diff editor and
      computing changed lines per side (not whole-text contains — the unstaged side's context
      contains the staged marker).
- [ ] Scenarios: "Staged and unstaged sides open as separate tabs"; "Unscoped opener is
      unchanged" (context menu → tab titled exactly `both.ts` with both markers changed);
      "Review card opens at Review's scope" (Review → Unstaged → card's `Open side-by-side diff`
      → active tab `both.ts (Working Tree)` and the diff editor is side-by-side);
      "Conflicted row opens unscoped" (a second temp repo with a real `git merge` conflict on
      `conflicted.ts`; click its row; active title exactly `conflicted.ts`).
- [ ] Run `npm run build` then `node test/e2e/run-smoke.mjs scoped-diff-tabs` — before T2.5 the
      first and third scenarios fail (one `both.ts` tab); after, all pass.

### Slice 3: Refresh — queue, triggers, in-place models, last-rendered hold, restart

**Check:** `npx vitest run test/unit/diff-read-queue.test.ts` green; e2e scenarios "An edit on
disk refreshes the scoped tab" and "Scope survives restart and reopen" pass, and the no-flash
observer records nothing during "Staging empties the Working Tree tab" steps that don't depend on
Slice 4's notice (assert `both.ts (Index)` gains `MARK_UNSTAGED_SIDE` after staging).

**Parallel groups:** G4: T3.1 · G5: T3.2 · Serial: T3.3, T3.4
**Claims (serial lane):** `webview/app.tsx`, `webview/components/center-pane.tsx`, `test/e2e/scoped-diff-tabs.e2e.mjs`

#### Task 3.1: diff-read-queue

**Files:**
- Create: `webview/diff-read-queue.ts`
- Test: `test/unit/diff-read-queue.test.ts`

**Interfaces:**
- Produces: `DiffReadTarget`, `DiffReadQueue { request; ensure; settle }`,
  `createDiffReadQueue(send)`, `diffReadTargets(docs, match)` (Contracts).
- Consumes: `diffTabKey` (T2.1), `OpenDoc` (T2.2).

**Steps:**
- [ ] Failing tests: 'two requests while one is in flight produce one re-post' — request, request,
      request → `send` called once; `settle(key)` → called twice total; `settle(key)` again → still
      twice; 'ensure never marks dirty' — request, ensure, settle → send called once; 'ensure posts
      when idle' — ensure → once; 'keys are independent per scope' — request staged + request
      unstaged of one path → two sends; 'settle of an unknown key is a no-op';
      'diffReadTargets dedupes by key and skips non-diff docs' — two docs with the same key (ids
      differ only by session ownership can't happen, so use a file doc and two diff docs of one
      path, one scoped) → 2 targets in docs order.
- [ ] Run `npx vitest run test/unit/diff-read-queue.test.ts` — expect FAIL.
- [ ] Implement with a `Map<string, 'inFlight' | 'dirty'>`.

#### Task 3.2: DiffViewer updates in place

**Files:**
- Modify: `webview/components/diff-viewer.tsx` (TextDiffViewer only)

**Interfaces:**
- Produces: `DiffViewer` props gain `showWhitespace?: boolean` (default `false`, which keeps
  `ignoreTrimWhitespace` at Monaco's default for every existing caller, including
  `webview/components/commit-view.tsx`).
- Consumes: nothing new.

**Steps:**
- [ ] Split the creation effect: create the diff editor and both models once per
      `[doc.path, doc.binary, viewStateId]` (seeded with the current `head`/`work`); a second
      effect on `[doc.head, doc.work]` skips its first run, then does
      `const vs = modified.saveViewState(); original.setValue(head) (only if changed); modified.setValue(work) (only if changed); if (vs) modified.restoreViewState(vs);`
      — Monaco clamps a restored position to the new line count. Scroll view-state capture stays
      as today.
- [ ] Replace the one-shot `setHasChanges(getLineChanges()…)` with
      `editor.onDidUpdateDiff(() => setHasChanges((editor.getLineChanges()?.length ?? 0) > 0))`,
      disposed in the cleanup.
- [ ] Pass `ignoreTrimWhitespace: !showWhitespace` at creation (Monaco's default is `true`).
- [ ] Proof: `npm run typecheck`, and T3.4's cursor assertion; the image-diff and
      commit-review e2e scenarios stay green (`node test/e2e/run-smoke.mjs image-diff`, then
      `node test/e2e/run-smoke.mjs commit-review-bounds`, serially).

#### Task 3.3: Refresh wiring and the last-rendered hold

**Files:**
- Modify: `webview/app.tsx`:
  - `const diffReadQueueRef = useRef(createDiffReadQueue((t) => post({ type: 'readDiff', path: t.path, ...scopeDiffArgs(t.diffScope ?? 'all') })))`
    declared before the message subscription (~line 250).
  - fileDiff handler (~343): compute `key`, set it, then `diffReadQueueRef.current.settle(key)`.
  - `openDiff`: replace the direct `post` with `diffReadQueueRef.current.request({ path, diffScope })`.
  - `rereadOpenDiffs(match)` (`useCallback`, reads `docsRef.current`).
  - (a) the `fsChanged` subscription (~1247): also `rereadOpenDiffs((d) => isUnderRoot(msg.root, d.path))`.
  - (b) `runGit` (~2239) and `discardAll` (~2250): after `refreshChanges()`,
    `rereadOpenDiffs((d) => isUnderRoot(root, d.path))`.
  - (c) `invalidateDiff` (~1303): keep the eviction; replace the bare `post({type:'readDiff'…})`
    and its comment with `rereadOpenDiffs((d) => d.path === canonicalPath(absPath))`.
  - (e) the `activeId` effect (~1045): `rereadOpenDiffs((d) => d.sessionId === activeId)`.
  - Missing-key effect: `useEffect(() => { for (const t of diffReadTargets(docState.docs, (d) => !diffs.has(diffTabKey(d)))) diffReadQueueRef.current.ensure(t); }, [docState.docs, diffs])`.
- Modify: `webview/components/center-pane.tsx`: `heldDiffsRef = useRef(new Map<string, FileDiffDTO>())`;
  in render `const liveDiff = diffs.get(diffTabKey(activeDoc))`; pass
  `diff={liveDiff ?? heldDiffsRef.current.get(activeDoc.id)}`; a `useEffect` with deps
  `[liveDiff, activeDoc?.id, docs]` stores `liveDiff` under the doc id when defined and deletes
  held entries whose id is no longer in `docs` (the existing `docs: OpenDoc[]` prop).

**Interfaces:**
- Consumes: T3.1 `createDiffReadQueue`, `diffReadTargets`, `DiffReadQueue`; T2.1 `diffTabKey`;
  `isUnderRoot(root: string, absPath: string): boolean` from `src/repo-rel.ts`;
  `canonicalPath` from `webview/project-index.ts`.

**Steps:**
- [ ] `npm run typecheck` and `npx vitest run` green.

#### Task 3.4: E2E — refresh and restart

**Files:**
- Modify: `test/e2e/scoped-diff-tabs.e2e.mjs`

**Steps:**
- [ ] "An edit on disk refreshes the scoped tab": open `both.ts (Working Tree)`, put the cursor on
      modified line 18 via Monaco's API on the modified editor, append `MARK_LATER_EDIT` with
      `appendFileSync`, wait (≤15 s) until the modified model contains it; assert the modified
      editor's `getPosition().lineNumber === 18`.
- [ ] Arm a `MutationObserver` on `.center` (the center pane root) that records any text node
      containing `Loading diff…`, then stage `both.ts` with the row's Stage action; wait until
      `both.ts (Index)`'s modified model contains `MARK_UNSTAGED_SIDE`; assert the recording is
      empty. (The empty-side assertion is added in T4.4.)
- [ ] "Scope survives restart and reopen": with both scoped tabs open, `closeApp`, relaunch with
      the same `--user-data-dir`, assert both exact titles return and each shows its scoped
      content after activating it; close `both.ts (Index)`, press Mod+Shift+T, assert it reopens
      with the staged content.
- [ ] Run `npm run build` then `node test/e2e/run-smoke.mjs scoped-diff-tabs`.

### Slice 4: Tab states — error, conflicted, empty side

**Check:** `npx vitest run test/unit/diff-tab-scope.test.ts` green (incl. `diffTabState`);
e2e "Staging empties the Working Tree tab without a Loading flash" (full, with the notice) and
"Untracked file" pass.

**Parallel groups:** Serial: T4.1, T4.2, T4.3, T4.4
**Claims (serial lane):** `webview/app.tsx`, `webview/components/center-pane.tsx`, `test/e2e/scoped-diff-tabs.e2e.mjs`

#### Task 4.1: diffTabState and notice copy

**Files:**
- Modify: `webview/diff-tab-scope.ts` (add `DiffTabState`, `diffTabState`, `emptySideNotice`,
  `CONFLICTED_NOTICE`, `DIFF_READ_ERROR_NOTICE`)
- Test: `test/unit/diff-tab-scope.test.ts`

**Interfaces:**
- Produces: signatures exactly as in Contracts.
- Consumes: `FileDiffDTO` (with `error`, `unmerged`) from `src/protocol.ts`.

**Steps:**
- [ ] Failing tests: 'state precedence' — table-driven: `undefined`→loading; `{error}`→error even
      with `unmerged`; scoped `{unmerged:true, head:'', work:''}`→conflicted (not empty); unscoped
      `{unmerged:true}`→populated precedence continues (unscoped never shows conflicted);
      `{oversize}`→oversize; `{image}`→image; `{binary:true}`→binary; scoped `head===work`→empty;
      unscoped `head===work`→populated; scoped differing→populated. 'a scoped tab that becomes
      unmerged' — same doc state goes populated → conflicted when `unmerged:true` is injected.
      'empty-side copy is one template per scope' — `emptySideNotice('staged','both.ts') === 'No staged changes in both.ts.'`.
- [ ] Run `npx vitest run test/unit/diff-tab-scope.test.ts` — expect FAIL.
- [ ] Implement.

#### Task 4.2: DocView renders the states

**Files:**
- Modify: `webview/components/doc-view.tsx` (diff branch in `DocBody`; new props
  `onRetryDiff?`, `onOpenFullDiff?` threaded from `DocView` to `DocBody`)

**Interfaces:**
- Consumes: T4.1 `diffTabState`, `emptySideNotice`, `CONFLICTED_NOTICE`, `DIFF_READ_ERROR_NOTICE`;
  T3.2 `DiffViewer.showWhitespace`.
- Produces: `DocView` props `onRetryDiff?: (doc: OpenDoc) => void`, `onOpenFullDiff?: (doc: OpenDoc) => void`.

**Steps:**
- [ ] `switch (diffTabState(diff, doc.diffScope))`: `loading` → existing `Loading diff…` notice;
      `error` → `.viewer__notice` with `tabIndex={-1}` holding `DIFF_READ_ERROR_NOTICE` and a
      `.viewer__notice-action` **Retry** button that focuses its notice container, then calls
      `onRetryDiff(doc)`; `conflicted` → `CONFLICTED_NOTICE` + **Open full diff** →
      `onOpenFullDiff(doc)`; `empty` → `emptySideNotice(doc.diffScope, name)` where `name`
      is the basename of `doc.path` (not `doc.title`, which carries the suffix); `oversize`/`image`/
      `binary`/`populated` → `DiffViewer` as today plus `showWhitespace={doc.diffScope !== undefined}`.
- [ ] A persistent `<div className="sr-only" aria-live="polite">` in the diff branch whose text is
      the notice copy for `error`/`conflicted`/`empty` and `''` otherwise, so entering one of
      those states is announced (it is mounted before its text changes).
- [ ] No unit test (the decision is T4.1's); proof is T4.4.

#### Task 4.3: Retry and Open full diff wiring

**Files:**
- Modify: `webview/components/center-pane.tsx` (props `onRetryDiff`, `onOpenFullDiff`, passed to DocView)
- Modify: `webview/app.tsx` (`onRetryDiff = (doc) => diffReadQueueRef.current.request({ path: doc.path, diffScope: doc.diffScope })`;
  `onOpenFullDiff = (doc) => openDiff(doc.path, doc.sessionId)`)

**Steps:**
- [ ] `npm run typecheck`; `npm run verify` green (end of the renderer work).

#### Task 4.4: E2E — states

**Files:**
- Modify: `test/e2e/scoped-diff-tabs.e2e.mjs`

**Steps:**
- [ ] Extend the staging scenario from T3.4: after staging, activate `both.ts (Working Tree)` and
      assert its notice text is exactly `No unstaged changes in both.ts.` and the tab is still in
      the strip; the Loading observer (armed before staging) still recorded nothing.
- [ ] "Untracked file": write `new.ts`, click its row under Changes, assert active title exactly
      `new.ts (Working Tree)` and every modified line is an insertion (original model empty).
- [ ] Run `npm run build` then `node test/e2e/run-smoke.mjs scoped-diff-tabs` — every scenario
      in the amended spec §7 passes.

### Slice 5: Mock bridge serves scoped diffs

**Check:** `npx vitest run test/unit/mock-diff.test.ts` green.

**Parallel groups:** G6: T5.1 (file-disjoint from Slices 1–4; may run alongside any of them)
**Claims (serial lane):** none

#### Task 5.1: mockDiffFor

**Files:**
- Modify: `webview/mock.ts` (add `mockIndex: Record<string, string>` with an intermediate
  `page.tsx` blob — the head with only the `Nav` import line added — and `mockDiffFor`)
- Modify: `webview/bridge.ts` (the `readDiff` branch ~981 uses `mockDiffFor(msg.path, msg)`)
- Test: `test/unit/mock-diff.test.ts`

**Interfaces:**
- Produces: `mockDiffFor(path: string, scope: DiffScope): { head: string; work: string }`.
- Consumes: `DiffScope` from `src/protocol.ts` (existing).

**Steps:**
- [ ] Failing tests: 'unscoped output is byte-identical to the corpus' — for every key of
      `mockDiffs`, `mockDiffFor('/p/'+k, {})` equals `mockDiffs[k]`, and an unknown leaf gives
      `{head:'const a = 1;\n', work:'const a = 2;\n'}`; 'page.tsx differs per scope and the
      index is consistent' — staged, unstaged and unscoped results are pairwise different and
      `staged.work === unstaged.head`; 'a file with no index entry has no staged side' —
      `mockDiffFor('/p/layout.tsx', {base:'head', side:'index'})` has `head === work`.
- [ ] Run `npx vitest run test/unit/mock-diff.test.ts` — expect FAIL.
- [ ] Implement; `bridge.ts` keeps echoing `base`/`side` as today.

## Verification

- Per task: the task's named test command (exit code read directly, never piped through `tail`).
- Per slice: the slice's Check, then `npm run typecheck`.
- End of Slice 4 and on the merged tree: `npm run verify` green, then `npm run build` and
  `node test/e2e/run-smoke.mjs scoped-diff-tabs`, then the neighbours this touches, one at a time:
  `review-scope`, `hunk-staging`, `editor-tabs-persist`, `image-diff`, `live-watch`. A PTY-looking
  failure is re-run alone on a quiet machine before it is believed.
- `npm run shots` for the three themes' notice rendering (no new tokens; `.viewer__notice`).
- `git status` shows only the files in the File map plus the plan/spec.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never
a shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. The report leads with the fix that keeps the locked decision.

## Decisions Needed

- [normal] **A vanished or unreadable repo reads as empty, not as an error** (D7 measured).
  `readDiff` maps every missing blob to `''` by design, so the spec §4 "repo gone on restore →
  Error state" row cannot be met without changing `readDiff`'s contract, which the spec rules out.
  Default taken: the Error state covers a thrown read only (`readDiffReply`); a vanished repo
  shows the empty-side notice (scoped) or an empty diff (unscoped). Spec §4 amended.
- [normal] **Diff tab `hasChanges` comes from Monaco, not a hunk list.** With D1 out there is no
  hunk list; `onDidUpdateDiff` fixes the "read once, synchronously" defect the spec measured.
  Default taken as stated.
