import type { RefEndpoint } from '../src/git-range';
import type { DiffTabScope, PersistedDoc } from '../src/protocol';
import { moveBefore } from '../src/reorder';
import { diffTabTitle } from './diff-tab-scope';
import {
  type EditorGroup,
  EMPTY_LAYOUT,
  type GroupIndex,
  layoutOf,
  openTargetGroup,
  resolveActivateGroup,
  type SessionLayout,
  splitBehavior,
  type Tab,
  tabPreview,
} from './doc-groups';
import type { ReviewScope } from './review-scope';
import { displayTitleForUrl } from './web-url';

// 'web' is an in-app browser tab; its `path` is the URL (id = `web:<url>`). It has no
// backing file — the viewer renders straight from the URL — so it reuses the doc
// id/ownership/persistence machinery with no extra state.
// 'git-history' is the commit-graph view (git-history Slice A): one per session, scoped
// to that session's repo, with a sentinel path like review — no backing file. A selected
// commit's detail (message + changed files) renders INLINE in the history view's bottom
// pane, not as a tab.
// 'commit-diff' is a history-originated editor tab: one file's diff for a commit. It
// supports PREVIEW (a single reused tab that retargets on single-click) vs PINNED (a
// per-identity persistent tab on double-click). A preview doc's id is the sentinel
// `commit-diff:@preview` while its `path` carries the live target (`<sha> <file>`);
// pinning re-keys it to `commit-diff:${path}`.
export type DocKind = 'file' | 'diff' | 'review' | 'web' | 'git-history' | 'commit-diff';

// What the singleton Review tab is scoped to: the live working tree (default), one commit's
// diff (vs. its first parent), or a comparison of two refs (base...head — spec
// 2026-06-29-review-changes-polish item 4). Rides the review doc so the tab stays a singleton —
// nothing is encoded in the doc id. See docs/specs/2026-06-29-review-commit-source.md §3.1.
export type { RefEndpoint } from '../src/git-range';
export type ReviewSource =
  // `repoRoot` pins the review to a SPECIFIC repo; what its absence means per kind is
  // docs/specs/archive/2026-09-23-mf-review.md §2.1.
  // `scope` narrows the working tree to the staged or unstaged side (spec
  // 2026-08-27-review-supercharge §2 Lane D). Absent ⇒ 'all' — a fresh Review always opens
  // on All, and it is never persisted.
  | { kind: 'working'; scope?: ReviewScope; repoRoot?: string }
  | { kind: 'commit'; sha: string; subject?: string; repoRoot?: string }
  | { kind: 'range'; base: RefEndpoint; head: RefEndpoint; repoRoot?: string };

export interface OpenDoc {
  id: string; // `${kind}:${path}` (preview commit/commit-diff docs use `${kind}:@preview`)
  kind: DocKind;
  path: string;
  title: string;
  // The session that was active when this doc was opened. The doc is "owned" by it,
  // so it only shows while that session is active, and closing that session closes the
  // doc. Re-opening under a different session transfers ownership.
  sessionId: string;
  // Review-only: which changeset the singleton Review tab is showing. Absent ⇒ working tree.
  // Never persisted (Review isn't a persisted doc); see review-commit-source spec §3.4.
  reviewSource?: ReviewSource;
  // diff docs only: open side-by-side regardless of the diffSideBySide setting; never persisted.
  sideBySide?: boolean;
  // diff docs only: which side the tab shows (absent = HEAD→worktree). Part of the doc's
  // identity; see spec 2026-09-22-scoped-diff-tabs §3.
  diffScope?: DiffTabScope;
  // git-history: the repo the view shows; commit-diff: the repo its commit was read from.
  // Never persisted — a restored doc falls back per docs/specs/archive/2026-09-23-mf-changes.md §2.5.
  repoRoot?: string;
}

// Whether a file-open opens a reusable preview tab (single-click / nav) or a permanent
// tab (double-click / OS open). See the entry-point classification in the spec §9.
// 'background' = pinned and NOT activated (middle-click; spec 2026-09-22-middle-click-new-tab §3).
export type OpenMode = 'preview' | 'permanent' | 'background';

export type BackgroundOutcome = 'opened' | 'pinned' | 'already-open';
export interface BackgroundOpenResult {
  outcome: BackgroundOutcome;
  /** The session whose strip holds the tab after the open (existing owner, or the target). */
  ownerSessionId: string;
  /** The doc id after the dispatch (a commit-diff preview slot re-keys to its pinned id). */
  id: string;
  title: string;
}

// The Review-changes view is a singleton editor tab (R5.5) rather than a center-pane
// overlay. It has no backing file, so it uses a sentinel path (the leading "@" can't
// collide with a real working-tree path) and a fixed, human title.
export const REVIEW_DOC_PATH = '@review';
export const REVIEW_DOC_ID = `review:${REVIEW_DOC_PATH}`;
const REVIEW_DOC_TITLE = 'Review Changes';

// The git-history graph is a singleton center-pane doc (git-history Slice A), like Review:
// a sentinel path (the "@" can't collide with a real working-tree path), a fixed human
// title, and a single doc id whose ownership transfers to the session that opened it so
// it scopes to that session's repo.
export const GIT_HISTORY_DOC_PATH = '@git-history';
const GIT_HISTORY_DOC_TITLE = 'History';

// Preview-slot sentinel for the history-originated commit-diff tab: one preview doc whose
// `path` carries the live target while the tab stays put. A '@' leader can't collide with a
// real `<sha> <file>` target.
const PREVIEW_PATH = '@preview';
const previewId = (kind: 'commit-diff') => `${kind}:${PREVIEW_PATH}`;
const shortSha = (sha: string) => sha.slice(0, 7);
/** A commit-diff target encodes `<sha> <file>` in `path` (a sha never contains a space). */
export const commitDiffPath = (sha: string, file: string) => `${sha} ${file}`;
export function parseCommitDiffPath(path: string): { sha: string; file: string } {
  const i = path.indexOf(' ');
  return i === -1 ? { sha: path, file: '' } : { sha: path.slice(0, i), file: path.slice(i + 1) };
}

// see docs/plans/2026-09-28-split-editor.plan.md P1
export interface DocsState {
  /** The doc registry; its order carries no meaning (tab order lives in `layouts`). */
  docs: OpenDoc[];
  layouts: Readonly<Record<string, SessionLayout>>;
  /** A cache of the shown session's active group's active tab, written only by `finalize`. */
  activeId: string | null;
}

export type DocsAction =
  // `mode` (file/diff only) chooses a reusable preview tab vs a permanent one; defaults to
  // permanent so callers/kinds that don't opt in keep today's behavior.
  | {
      type: 'open';
      kind: DocKind;
      path: string;
      sessionId: string;
      mode?: OpenMode;
      sideBySide?: boolean;
      diffScope?: DiffTabScope;
      repoRoot?: string;
      group?: GroupIndex;
    }
  // Update a doc's tab label. Used by the web view to adopt the live page <title>.
  | { type: 'setTitle'; id: string; title: string }
  // Consume the one-time `sideBySide` override once the diff tab's own toggle has fired
  // (spec 2026-09-05-review-mode §2.5) — otherwise it re-forces the override on every remount.
  | { type: 'clearSideBySide'; id: string }
  // With `group`, closes that group's tab only; without it, the doc (every tab).
  | { type: 'close'; id: string; group?: GroupIndex }
  | { type: 'closeSession'; sessionId: string }
  // `sessionId` names the session whose Terminal an `id: null` selects; omit it only where
  // the owning session is unknown (the shown session is used).
  | { type: 'activate'; id: string | null; sessionId?: string; group?: GroupIndex }
  // Restore the now-active session's remembered doc (a closed or transferred-away doc
  // falls back to the Terminal).
  | { type: 'switchSession'; sessionId: string }
  // Open one of a commit's file diffs (`commit-diff`) as an editor tab. 'preview' = reuse the
  // preview slot (single-click); 'permanent' = a per-identity persistent tab (double-click /
  // keyboard Enter); 'background' = that persistent tab without activating it.
  | {
      type: 'openCommitFile';
      sha: string;
      file: string;
      sessionId: string;
      mode: OpenMode;
      repoRoot?: string;
      group?: GroupIndex;
    }
  // Open/retarget the singleton Review tab to a source (working tree or a commit). Keeps the
  // stable REVIEW_DOC_ID so it stays a singleton; transfers ownership to `sessionId`.
  | { type: 'openReview'; sessionId: string; source: ReviewSource; group?: GroupIndex }
  // Promote a preview tab to a pinned one (double-click the tab).
  | { type: 'pinDoc'; id: string; group?: GroupIndex }
  | { type: 'reorder'; dragId: string; targetId: string | null; group?: GroupIndex }
  | { type: 'splitRight'; sessionId: string }
  | {
      type: 'moveTab';
      sessionId: string;
      id: string;
      toGroup: GroupIndex;
      beforeId?: string | null;
      duplicate?: boolean;
    }
  | { type: 'focusGroup'; sessionId: string; group: GroupIndex }
  | { type: 'joinGroups'; sessionId: string }
  // One-shot startup seed from persisted docs.json (editor-tabs-persist). Rebuilds docs[] +
  // layouts from `docs`, dropping any whose sessionId isn't in `knownSessionIds` (orphan).
  | { type: 'restore'; docs: PersistedDoc[]; knownSessionIds: string[] }
  // Files were renamed/moved on disk: each listed file tab (by its exact path) follows its file
  // in place — same slot in every group, owner and preview flag. The caller decides which tabs move.
  | { type: 'moveFiles'; moves: readonly { from: string; to: string }[] };

export const initialDocs: DocsState = { docs: [], layouts: {}, activeId: null };

const idOf = (kind: DocKind, path: string, diffScope?: DiffTabScope) =>
  kind === 'diff' && diffScope ? `diff@${diffScope}:${path}` : `${kind}:${path}`;
const scopeField = (kind: DocKind, diffScope: DiffTabScope | undefined) =>
  kind === 'diff' && diffScope ? { diffScope } : {};
// A re-open that omits the key keeps the singleton's repo; one that names it (even as
// undefined) replaces it.
const historyRepoField = (action: Extract<DocsAction, { type: 'open' }>) =>
  action.kind === 'git-history' && 'repoRoot' in action ? { repoRoot: action.repoRoot } : {};
const titleOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

// A web doc's title starts as the URL's host/path (until the page <title> loads); a
// file/diff title is its basename; review has a fixed human title.
function initialTitle(kind: DocKind, path: string, diffScope?: DiffTabScope): string {
  if (kind === 'review') return REVIEW_DOC_TITLE;
  if (kind === 'git-history') return GIT_HISTORY_DOC_TITLE;
  if (kind === 'web') return displayTitleForUrl(path);
  if (kind === 'commit-diff') {
    const { sha, file } = parseCommitDiffPath(path);
    return `${titleOf(file)} @ ${shortSha(sha)}`;
  }
  if (kind === 'diff' && diffScope) return diffTabTitle(titleOf(path), diffScope);
  return titleOf(path);
}

const EMPTY_GROUP: EditorGroup = { tabs: [], active: null };
const otherGroup = (g: GroupIndex): GroupIndex => (g === 1 ? 2 : 1);
const isPreviewable = (kind: DocKind | undefined) => kind === 'file' || kind === 'diff';
const holds = (group: EditorGroup | undefined, id: string) =>
  group?.tabs.some((t) => t.id === id) ?? false;
const groupAt = (layout: SessionLayout, g: GroupIndex) => layout.groups[g - 1] ?? EMPTY_GROUP;

function setGroup(layout: SessionLayout, g: GroupIndex, group: EditorGroup): SessionLayout {
  if (g === 2) return { ...layout, groups: [layout.groups[0], group] };
  return { ...layout, groups: layout.groups.length === 2 ? [group, layout.groups[1]] : [group] };
}

function mapGroups(layout: SessionLayout, fn: (group: EditorGroup) => EditorGroup): SessionLayout {
  const [g1, g2] = layout.groups;
  return { ...layout, groups: g2 ? [fn(g1), fn(g2)] : [fn(g1)] };
}

const sameGroups = (a: SessionLayout, b: SessionLayout) =>
  a.groups.length === b.groups.length && a.groups.every((g, i) => g === b.groups[i]);

/** Removes `id`'s tab; an active one falls back to its left neighbour, else its right, else null. */
function removeTab(group: EditorGroup, id: string): EditorGroup {
  const i = group.tabs.findIndex((t) => t.id === id);
  if (i === -1) return group;
  const tabs = group.tabs.filter((t) => t.id !== id);
  if (group.active !== id) return { tabs, active: group.active };
  return { tabs, active: (group.tabs[i - 1] ?? group.tabs[i + 1])?.id ?? null };
}

const removeEverywhere = (layout: SessionLayout, id: string) =>
  mapGroups(layout, (group) => removeTab(group, id));

function unpreview(group: EditorGroup, id: string): EditorGroup {
  if (!group.tabs.some((t) => t.id === id && t.preview)) return group;
  return { ...group, tabs: group.tabs.map((t) => (t.id === id ? { id } : t)) };
}

function renameTab(group: EditorGroup, from: string, to: string): EditorGroup {
  if (!holds(group, from)) return group;
  const active = group.active === from ? to : group.active;
  if (holds(group, to)) return { tabs: group.tabs.filter((t) => t.id !== from), active };
  return { tabs: group.tabs.map((t) => (t.id === from ? { id: to } : t)), active };
}

/** Re-keys tab refs and the active tab in place, keeping each tab's slot and preview flag. */
function retargetTabs(group: EditorGroup, follow: (id: string) => string): EditorGroup {
  if (!group.tabs.some((t) => follow(t.id) !== t.id)) return group;
  return {
    tabs: group.tabs.map((t) => ({ ...t, id: follow(t.id) })),
    active: group.active === null ? null : follow(group.active),
  };
}

/** ≤1 file/diff preview per group: a file/diff preview replaces it at its index. The commit-diff
 *  slot is a preview of its own and never replaces, nor is replaced by, a file/diff one. */
function placeTab(group: EditorGroup, id: string, preview: boolean, docs: OpenDoc[]): EditorGroup {
  const tab: Tab = preview ? { id, preview: true } : { id };
  const kindOf = (tabId: string) => docs.find((d) => d.id === tabId)?.kind;
  if (preview && isPreviewable(kindOf(id))) {
    const i = group.tabs.findIndex((t) => t.preview && isPreviewable(kindOf(t.id)));
    if (i !== -1) return { ...group, tabs: group.tabs.map((t, j) => (j === i ? tab : t)) };
  }
  return { ...group, tabs: [...group.tabs, tab] };
}

function insertBefore(tabs: readonly Tab[], tab: Tab, beforeId: string | null): Tab[] {
  const at = beforeId === null ? -1 : tabs.findIndex((t) => t.id === beforeId);
  return at === -1 ? [...tabs, tab] : [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

const withLayout = (state: DocsState, sessionId: string, layout: SessionLayout): DocsState => ({
  ...state,
  layouts: { ...state.layouts, [sessionId]: layout },
});

/**
 * The only writer of `activeId`, and the enforcer of I4 (an empty group 2 collapses) and I6 (a
 * doc no tab references is dropped). `focus` is the session now shown; `null` keeps the shown
 * session. See docs/plans/2026-09-28-split-editor.plan.md "finalize".
 */
function finalize(
  state: DocsState,
  touched: readonly string[],
  focus: string | null,
  onVanish: 'owner' | 'lastDoc' = 'owner',
): DocsState {
  let layouts = state.layouts;
  for (const s of touched) {
    const l = layouts[s];
    if (l?.groups.length === 2 && l.groups[1].tabs.length === 0) {
      layouts = { ...layouts, [s]: { groups: [l.groups[0]], activeGroup: 1 } };
    }
  }
  const referenced = new Set<string>();
  for (const l of Object.values(layouts)) {
    for (const g of l.groups) for (const t of g.tabs) referenced.add(t.id);
  }
  const docs = state.docs.every((d) => referenced.has(d.id))
    ? state.docs
    : state.docs.filter((d) => referenced.has(d.id));
  const activeOf = (sessionId: string) => {
    const l = layouts[sessionId];
    return l ? (l.groups[l.activeGroup - 1]?.active ?? null) : null;
  };
  let activeId: string | null;
  if (focus !== null) activeId = activeOf(focus);
  else if (state.activeId === null) activeId = null;
  else if (onVanish === 'lastDoc') {
    const last = docs[docs.length - 1];
    activeId = referenced.has(state.activeId)
      ? state.activeId
      : last
        ? activeOf(last.sessionId)
        : null;
  } else {
    const shown = state.docs.find((d) => d.id === state.activeId)?.sessionId ?? touched[0];
    activeId = shown === undefined ? null : activeOf(shown);
  }
  return { docs, layouts, activeId };
}

interface OpenSpec {
  sessionId: string;
  group: GroupIndex | undefined;
  id: string;
  kind: DocKind;
  create: () => OpenDoc;
}

/** Foreground open: see docs/plans/2026-09-28-split-editor.plan.md "open, foreground" (P1b). */
function openForeground(
  state: DocsState,
  o: OpenSpec & { preview: boolean; patch: (doc: OpenDoc) => OpenDoc },
): DocsState {
  const s = o.sessionId;
  const g = o.group ?? openTargetGroup(state, s);
  const layouts: Record<string, SessionLayout> = { ...state.layouts };
  const touched = [s];
  const existing = state.docs.find((d) => d.id === o.id);
  const transferred = existing !== undefined && existing.sessionId !== s;
  let docs: OpenDoc[];
  if (existing) {
    if (transferred) {
      layouts[existing.sessionId] = removeEverywhere(layoutOf(state, existing.sessionId), o.id);
      touched.push(existing.sessionId);
    }
    const doc = o.patch({ ...existing, sessionId: s });
    docs = state.docs.map((d) => (d === existing ? doc : d));
  } else {
    docs = [...state.docs, o.create()];
  }
  let layout = layouts[s] ?? EMPTY_LAYOUT;
  const target = groupAt(layout, g);
  const other = otherGroup(g);
  let next: EditorGroup;
  if (holds(target, o.id)) {
    next = o.preview ? target : unpreview(target, o.id);
  } else if (holds(layout.groups[other - 1], o.id) && splitBehavior(o.kind) === 'move') {
    layout = setGroup(layout, other, removeTab(groupAt(layout, other), o.id));
    next = placeTab(target, o.id, false, docs);
  } else {
    // A transferred file/diff tab lands pinned: it never downgrades, nor evicts this group's
    // preview (review B4). The commit-diff slot is a preview wherever it goes.
    next = placeTab(target, o.id, o.preview && !(transferred && isPreviewable(o.kind)), docs);
  }
  layouts[s] = { ...setGroup(layout, g, { ...next, active: o.id }), activeGroup: g };
  return finalize({ docs, layouts, activeId: state.activeId }, touched, s);
}

/** Pinned and never activated; an existing tab keeps its place and its owner (unlike a
 *  foreground open, which transfers ownership). */
function openInBackground(
  state: DocsState,
  o: OpenSpec & { patch?: (doc: OpenDoc) => OpenDoc },
): DocsState {
  const existing = state.docs.find((d) => d.id === o.id);
  const owner = existing?.sessionId ?? o.sessionId;
  const layout = layoutOf(state, owner);
  let next: SessionLayout;
  if (existing && owner !== o.sessionId) {
    next = mapGroups(layout, (group) => unpreview(group, o.id));
  } else {
    const g = o.group ?? openTargetGroup(state, owner);
    const target = groupAt(layout, g);
    if (holds(target, o.id)) next = setGroup(layout, g, unpreview(target, o.id));
    else if (existing && splitBehavior(o.kind) === 'move') {
      next = mapGroups(layout, (group) => unpreview(group, o.id));
    } else {
      next = setGroup(layout, g, {
        tabs: [...target.tabs, { id: o.id }],
        active: g === 2 ? (target.active ?? o.id) : target.active,
      });
    }
  }
  const patch = o.patch;
  const docs = !existing
    ? [...state.docs, o.create()]
    : patch
      ? state.docs.map((d) => (d === existing ? patch(d) : d))
      : state.docs;
  if (docs === state.docs && sameGroups(next, layout)) return state;
  return finalize({ ...withLayout(state, owner, next), docs }, [owner], null);
}

/** Re-keys the `commit-diff` preview slot `from` to its pinned id `to` in the registry and in
 *  every tab ref and active naming it (pinned there). An existing `to` owned by another
 *  session keeps its owner, so the slot's tabs close instead. */
function rekeySlot(
  state: DocsState,
  from: string,
  to: string,
  fields: Partial<OpenDoc>,
): DocsState {
  const slot = state.docs.find((d) => d.id === from);
  if (!slot) return state;
  const target = state.docs.find((d) => d.id === to);
  const layout = layoutOf(state, slot.sessionId);
  if (target && target.sessionId !== slot.sessionId) {
    return withLayout(state, slot.sessionId, removeEverywhere(layout, from));
  }
  const docs = target
    ? state.docs.filter((d) => d !== slot)
    : state.docs.map((d) => (d === slot ? { ...d, ...fields, id: to } : d));
  return {
    ...withLayout(
      state,
      slot.sessionId,
      mapGroups(layout, (g) => renameTab(g, from, to)),
    ),
    docs,
  };
}

/** Split and move land a pinned tab (P4): a `commit-diff` slot is re-keyed to its pinned id first. */
function pinSlotForMove(state: DocsState, id: string): { state: DocsState; id: string } {
  const doc = state.docs.find((d) => d.id === id);
  if (doc?.kind !== 'commit-diff' || id !== previewId('commit-diff')) return { state, id };
  const pinned = idOf(doc.kind, doc.path);
  return { state: rekeySlot(state, id, pinned, {}), id: pinned };
}

function openCommitDiff(
  state: DocsState,
  action: Extract<DocsAction, { type: 'openCommitFile' }>,
): DocsState {
  const kind = 'commit-diff';
  const path = commitDiffPath(action.sha, action.file);
  const title = `${titleOf(action.file)} @ ${shortSha(action.sha)}`;
  const { sessionId, repoRoot } = action;
  const pinnedId = idOf(kind, path);
  const slotId = previewId(kind);
  const slot = state.docs.find((d) => d.id === slotId);
  const pinnedExists = state.docs.some((d) => d.id === pinnedId);
  const spec: OpenSpec = {
    sessionId,
    group: action.group,
    id: pinnedId,
    kind,
    create: () => ({ id: pinnedId, kind, path, title, sessionId, repoRoot }),
  };
  const keep = (d: OpenDoc) => d;

  if (action.mode === 'background') {
    if (!pinnedExists && slot && slot.path === path) {
      return finalize(rekeySlot(state, slotId, pinnedId, { title }), [slot.sessionId], null);
    }
    return openInBackground(state, spec);
  }
  if (pinnedExists) return openForeground(state, { ...spec, preview: false, patch: keep });
  if (action.mode === 'permanent') {
    const base =
      slot && slot.path === path ? rekeySlot(state, slotId, pinnedId, { title, repoRoot }) : state;
    return openForeground(base, { ...spec, preview: false, patch: keep });
  }
  const g = action.group ?? openTargetGroup(state, sessionId);
  const inPlace =
    slot?.sessionId === sessionId && holds(groupAt(layoutOf(state, sessionId), g), slotId);
  const base =
    slot && !inPlace
      ? withLayout(state, slot.sessionId, removeEverywhere(layoutOf(state, slot.sessionId), slotId))
      : state;
  return openForeground(base, {
    ...spec,
    group: g,
    id: slotId,
    preview: true,
    create: () => ({ id: slotId, kind, path, title, sessionId, repoRoot }),
    patch: (d) => ({ ...d, kind, path, title, sessionId, repoRoot }),
  });
}

/** What a background open of this target will do, read from the state BEFORE the dispatch. */
export function backgroundOpenOutcome(
  state: DocsState,
  kind: DocKind,
  path: string,
  targetSessionId: string,
  diffScope?: DiffTabScope,
): BackgroundOpenResult {
  const id = idOf(kind, path, diffScope);
  const existing = state.docs.find((d) => d.id === id);
  if (existing) {
    const owner = existing.sessionId;
    const previewIn = (g: GroupIndex) => tabPreview(state, owner, g, id);
    let outcome: BackgroundOutcome;
    if (owner !== targetSessionId) {
      outcome = previewIn(1) || previewIn(2) ? 'pinned' : 'already-open';
    } else {
      const g = openTargetGroup(state, owner);
      if (holds(layoutOf(state, owner).groups[g - 1], id)) {
        outcome = previewIn(g) ? 'pinned' : 'already-open';
      } else if (splitBehavior(kind) === 'duplicate') outcome = 'opened';
      else outcome = previewIn(otherGroup(g)) ? 'pinned' : 'already-open';
    }
    return { outcome, ownerSessionId: owner, id, title: existing.title };
  }
  const slot =
    kind === 'commit-diff' ? state.docs.find((d) => d.id === previewId(kind)) : undefined;
  if (slot && slot.path === path) {
    return { outcome: 'pinned', ownerSessionId: slot.sessionId, id, title: slot.title };
  }
  return {
    outcome: 'opened',
    ownerSessionId: targetSessionId,
    id,
    title: initialTitle(kind, path, diffScope),
  };
}

// Every case works on `groups[g]` with no split-mode fork; see
// docs/plans/2026-09-28-split-editor.plan.md "webview/docs.ts changes".
export function docsReducer(state: DocsState, action: DocsAction): DocsState {
  switch (action.type) {
    case 'open': {
      const id = idOf(action.kind, action.path, action.diffScope);
      const sideBySide = action.sideBySide !== undefined ? { sideBySide: action.sideBySide } : {};
      const repo = historyRepoField(action);
      const spec: OpenSpec = {
        sessionId: action.sessionId,
        group: action.group,
        id,
        kind: action.kind,
        create: () => ({
          id,
          kind: action.kind,
          path: action.path,
          title: initialTitle(action.kind, action.path, action.diffScope),
          sessionId: action.sessionId,
          ...sideBySide,
          ...scopeField(action.kind, action.diffScope),
          ...repo,
        }),
      };
      const patch = (d: OpenDoc): OpenDoc => ({ ...d, ...sideBySide, ...repo });
      if (action.mode === 'background') {
        const changesDoc = action.sideBySide !== undefined || 'repoRoot' in repo;
        return openInBackground(state, { ...spec, patch: changesDoc ? patch : undefined });
      }
      const preview = isPreviewable(action.kind) && action.mode === 'preview';
      return openForeground(state, { ...spec, preview, patch });
    }
    case 'setTitle': {
      const idx = state.docs.findIndex((d) => d.id === action.id);
      if (idx === -1 || state.docs[idx].title === action.title) return state;
      const title = action.title.trim();
      if (!title) return state;
      const docs = state.docs.map((d) => (d.id === action.id ? { ...d, title } : d));
      return { ...state, docs };
    }
    case 'clearSideBySide': {
      const idx = state.docs.findIndex((d) => d.id === action.id);
      if (idx === -1 || state.docs[idx].sideBySide === undefined) return state;
      const docs = state.docs.map((d) =>
        d.id === action.id ? { ...d, sideBySide: undefined } : d,
      );
      return { ...state, docs };
    }
    case 'closeSession': {
      const s = action.sessionId;
      const docs = state.docs.filter((d) => d.sessionId !== s);
      if (docs.length === state.docs.length && !(s in state.layouts)) return state;
      const { [s]: _gone, ...layouts } = state.layouts;
      return finalize({ docs, layouts, activeId: state.activeId }, [], null, 'lastDoc');
    }
    case 'close': {
      const doc = state.docs.find((d) => d.id === action.id);
      if (!doc) return state;
      const s = doc.sessionId;
      const layout = layoutOf(state, s);
      const g = action.group;
      if (g !== undefined && !holds(layout.groups[g - 1], action.id)) return state;
      const holding = layout.groups.filter((group) => holds(group, action.id)).length;
      const next =
        g !== undefined && holding > 1
          ? setGroup(layout, g, removeTab(groupAt(layout, g), action.id))
          : removeEverywhere(layout, action.id);
      return finalize(withLayout(state, s, next), [s], null);
    }
    case 'moveFiles': {
      const target = new Map(action.moves.map((m) => [m.from, m.to]));
      const ids = new Map<string, string>();
      const taken = new Set(state.docs.map((d) => d.id));
      const docs = state.docs.map((d) => {
        const path = d.kind === 'file' ? target.get(d.path) : undefined;
        if (path === undefined || path === d.path) return d;
        const id = idOf('file', path);
        if (taken.has(id)) return d;
        taken.add(id);
        ids.set(d.id, id);
        return { ...d, id, path, title: initialTitle('file', path) };
      });
      if (ids.size === 0) return state;
      const follow = (id: string) => ids.get(id) ?? id;
      const layouts = Object.fromEntries(
        Object.entries(state.layouts).map(([sid, l]) => [
          sid,
          mapGroups(l, (g) => retargetTabs(g, follow)),
        ]),
      );
      const activeId = state.activeId === null ? null : follow(state.activeId);
      return finalize({ docs, layouts, activeId }, [], null);
    }
    case 'activate': {
      if (action.id === null) {
        const s = action.sessionId ?? state.docs.find((d) => d.id === state.activeId)?.sessionId;
        if (s === undefined) return state;
        const layout = layoutOf(state, s);
        const next = setGroup(layout, 1, { ...layout.groups[0], active: null });
        return finalize(withLayout(state, s, { ...next, activeGroup: 1 }), [s], s);
      }
      const id = action.id;
      const doc = state.docs.find((d) => d.id === id);
      if (!doc) return state;
      const owner = doc.sessionId;
      const g = action.group ?? resolveActivateGroup(state, owner, id);
      const layout = layoutOf(state, owner);
      const group = layout.groups[g - 1];
      if (!group || !holds(group, id)) return state;
      const next = setGroup(layout, g, { ...group, active: id });
      return finalize(withLayout(state, owner, { ...next, activeGroup: g }), [owner], owner);
    }
    case 'switchSession':
      return finalize(state, [], action.sessionId);
    case 'openReview': {
      // The unscoped working source is canonically stored as ABSENT (label treats absent ===
      // working, All). A scoped or repo-narrowed one has to survive — it is what the Review reads.
      const reviewSource =
        action.source.kind === 'working' &&
        (action.source.scope ?? 'all') === 'all' &&
        action.source.repoRoot === undefined
          ? undefined
          : action.source;
      return openForeground(state, {
        sessionId: action.sessionId,
        group: action.group,
        id: REVIEW_DOC_ID,
        kind: 'review',
        preview: false,
        create: () => ({
          id: REVIEW_DOC_ID,
          kind: 'review',
          path: REVIEW_DOC_PATH,
          title: REVIEW_DOC_TITLE,
          sessionId: action.sessionId,
          reviewSource,
        }),
        patch: (d) => ({ ...d, reviewSource }),
      });
    }
    case 'openCommitFile':
      return openCommitDiff(state, action);
    case 'pinDoc': {
      const doc = state.docs.find((d) => d.id === action.id);
      if (!doc) return state;
      const owner = doc.sessionId;
      const isPreviewTab = (g: GroupIndex) => tabPreview(state, owner, g, action.id);
      const g = action.group ?? ([1, 2] as const).find(isPreviewTab);
      if (g === undefined || !isPreviewTab(g)) return state;
      // file/diff previews already carry their stable identity in the id, so promotion is
      // just clearing the tab's flag — no re-key, no activeId/ownership churn.
      if (doc.kind !== 'commit-diff') {
        const layout = layoutOf(state, owner);
        const next = setGroup(layout, g, unpreview(groupAt(layout, g), action.id));
        return finalize(withLayout(state, owner, next), [owner], null);
      }
      return finalize(rekeySlot(state, action.id, idOf(doc.kind, doc.path), {}), [owner], null);
    }
    case 'reorder': {
      const doc = state.docs.find((d) => d.id === action.dragId);
      if (!doc) return state;
      const owner = doc.sessionId;
      const g = action.group ?? resolveActivateGroup(state, owner, action.dragId);
      const layout = layoutOf(state, owner);
      const group = groupAt(layout, g);
      if (!holds(group, action.dragId)) return state;
      const byId = new Map(group.tabs.map((t) => [t.id, t]));
      const order = moveBefore(
        group.tabs.map((t) => t.id),
        action.dragId,
        action.targetId,
      );
      const tabs = order.flatMap((id) => {
        const tab = byId.get(id);
        if (!tab) return [];
        // Dragging a preview tab promotes it (VS Code parity, spec §3.1).
        return [id === action.dragId ? { id } : tab];
      });
      const next = setGroup(layout, g, { ...group, tabs });
      return finalize(withLayout(state, owner, next), [owner], null);
    }
    case 'splitRight': {
      const s = action.sessionId;
      const layout = state.layouts[s];
      const x = layout?.activeGroup === 1 ? layout.groups[0].active : null;
      if (x === null) return state;
      const pinned = pinSlotForMove(state, x);
      const l = layoutOf(pinned.state, s);
      const id = pinned.id;
      const doc = pinned.state.docs.find((d) => d.id === id);
      if (!doc || !holds(l.groups[0], id)) return finalize(pinned.state, [s], s);
      const g2 = groupAt(l, 2);
      // see split-editor spec §2.3: the group-2 tab is pinned, a group-1 preview stays one.
      const groups: [EditorGroup, EditorGroup] = holds(g2, id)
        ? [l.groups[0], { ...unpreview(g2, id), active: id }]
        : [
            splitBehavior(doc.kind) === 'duplicate' ? l.groups[0] : removeTab(l.groups[0], id),
            { tabs: [...g2.tabs, { id }], active: id },
          ];
      return finalize(withLayout(pinned.state, s, { groups, activeGroup: 2 }), [s], s);
    }
    case 'moveTab': {
      const s = action.sessionId;
      const layout = state.layouts[s];
      const from = otherGroup(action.toGroup);
      if (!layout || !holds(layout.groups[from - 1], action.id)) return state;
      const pinned = pinSlotForMove(state, action.id);
      const l = layoutOf(pinned.state, s);
      const id = pinned.id;
      if (!holds(groupAt(l, from), id)) return finalize(pinned.state, [s], s);
      const kind = pinned.state.docs.find((d) => d.id === id)?.kind;
      const keepSource =
        action.duplicate === true && kind !== undefined && splitBehavior(kind) === 'duplicate';
      const src = keepSource ? groupAt(l, from) : removeTab(groupAt(l, from), id);
      const dst = groupAt(l, action.toGroup);
      const moved: EditorGroup = holds(dst, id)
        ? { ...unpreview(dst, id), active: id }
        : { tabs: insertBefore(dst.tabs, { id }, action.beforeId ?? null), active: id };
      const groups: [EditorGroup, EditorGroup] = from === 1 ? [src, moved] : [moved, src];
      const next: SessionLayout = { groups, activeGroup: action.toGroup };
      return finalize(withLayout(pinned.state, s, next), [s], s);
    }
    case 'joinGroups': {
      const s = action.sessionId;
      const layout = state.layouts[s];
      if (layout?.groups.length !== 2) return state;
      const [g1, g2] = layout.groups;
      const joined = g2.tabs.filter((t) => !holds(g1, t.id)).map((t) => ({ id: t.id }));
      const active = layout.activeGroup === 2 ? g2.active : g1.active;
      const next: SessionLayout = {
        groups: [{ tabs: [...g1.tabs, ...joined], active }],
        activeGroup: 1,
      };
      return finalize(withLayout(state, s, next), [s], s);
    }
    case 'focusGroup': {
      const s = action.sessionId;
      const layout = state.layouts[s];
      if (!layout?.groups[action.group - 1] || layout.activeGroup === action.group) return state;
      return finalize(withLayout(state, s, { ...layout, activeGroup: action.group }), [s], s);
    }
    case 'restore': {
      const known = new Set(action.knownSessionIds);
      const docs: OpenDoc[] = [];
      const layouts: Record<string, SessionLayout> = {};
      const seen = new Set<string>();
      for (const pd of action.docs) {
        // Drop orphans whose owning session didn't restore (spec §3.2).
        if (!known.has(pd.sessionId)) continue;
        const id = idOf(pd.kind, pd.path, pd.diffScope);
        const g: GroupIndex = pd.group ?? 1;
        // The singleton kinds (review/git-history) share a sentinel id; a stray duplicate in
        // docs.json must not spawn a second tab — first occurrence wins ownership.
        const owner = docs.find((d) => d.id === id)?.sessionId;
        if (seen.has(`${g}:${id}`) || (owner !== undefined && owner !== pd.sessionId)) continue;
        seen.add(`${g}:${id}`);
        if (owner === undefined) {
          docs.push({
            id,
            kind: pd.kind,
            path: pd.path,
            title: initialTitle(pd.kind, pd.path, pd.diffScope),
            sessionId: pd.sessionId,
            ...scopeField(pd.kind, pd.diffScope),
          });
        }
        const layout = layouts[pd.sessionId] ?? EMPTY_LAYOUT;
        const group = groupAt(layout, g);
        const tab: Tab = pd.preview ? { id, preview: true } : { id };
        // Group 2 never shows the Terminal (I5), so an entry with no `active` still gets one.
        const active = pd.active || (g === 2 && group.active === null) ? id : group.active;
        const next = setGroup(layout, g, { tabs: [...group.tabs, tab], active });
        layouts[pd.sessionId] = pd.focus && g === 2 ? { ...next, activeGroup: 2 } : next;
      }
      // activeId stays null (Terminal) here; the renderer's switchSession effect resolves the
      // active session's layout once a session is selected.
      return { docs, layouts, activeId: null };
    }
  }
}

/**
 * Derive the persisted-relevant slice of docState for docs.json (editor-tabs-persist). Every
 * deterministically-reopenable kind persists; a transient `@preview` commit-diff with no real
 * `<sha> <file>` target is dropped (there's nothing to reopen). `reviewSource` is intentionally
 * not carried — a restored Review reopens in working-tree mode (PersistedDoc doc). Entries go
 * per session (split-editor plan, Decisions Needed #11): group 1's tabs in order, then group
 * 2's with `group: 2`, each with its tab's preview flag and whether it is its group's active.
 */
export function toPersistedDocs(state: DocsState): PersistedDoc[] {
  const byId = new Map(state.docs.map((d) => [d.id, d]));
  const sessions = [...new Set(state.docs.map((d) => d.sessionId))];
  return sessions.flatMap((sessionId) => {
    const layout = layoutOf(state, sessionId);
    return layout.groups.flatMap((group, i) =>
      group.tabs.flatMap((tab): PersistedDoc[] => {
        const d = byId.get(tab.id);
        if (!d || (d.kind === 'commit-diff' && parseCommitDiffPath(d.path).file === '')) return [];
        return [
          {
            kind: d.kind,
            path: d.path,
            sessionId: d.sessionId,
            ...(tab.preview ? { preview: true } : {}),
            ...scopeField(d.kind, d.diffScope),
            ...(group.active === d.id ? { active: true } : {}),
            ...(i === 1 ? { group: 2 as const } : {}),
            ...(i === 1 && layout.activeGroup === 2 && group.active === d.id
              ? { focus: true as const }
              : {}),
          },
        ];
      }),
    );
  });
}

/** File paths of the file tabs that close with `sessionId` (a path has one file tab, keyed
 *  `file:${path}`). Each must be released exactly as a closed tab is (dirty flag, save entry), or
 *  an orphaned buffer can still be written by Save All. */
export function filePathsClosedWithSession(docs: readonly OpenDoc[], sessionId: string): string[] {
  return docs.filter((d) => d.kind === 'file' && d.sessionId === sessionId).map((d) => d.path);
}
