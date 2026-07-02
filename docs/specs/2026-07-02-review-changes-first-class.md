---
status: active
date: 2026-07-02
tier: FULL
type: UI
---

# Review Changes — first-class review surface

## Problem

Review Changes today is a flat, vertical scroll of per-file diff cards. It renders the
diff well (syntax highlight, word-level emphasis, folds, windowing, three sources:
working / commit / two-ref range), but it gives you **no sense of the shape of a
changeset and no way to navigate it**:

- There is **no summary**. The header shows a bare `"N files changed"` (`review-view.tsx`
  ~438). For a two-ref compare especially, you want to know *how big* the change is —
  files, insertions, deletions — **before** you start scrolling through cards.
- There is **no way to jump to a file**. A 40-file changeset is one long scroll; to reach
  the 30th file you scroll past the other 29. Every other review tool (GitHub, VS Code)
  has a file list/tree for exactly this.

The user's framing: "develop this a lot further… before viewing the diff I need to see how
many files and how many lines changed." This spec makes Review a surface you can *survey
and navigate*, not just scroll.

## Goals

1. **Diffstat summary** — a roll-up shown above the file cards: total files changed,
   `+insertions` / `−deletions`, for all three sources (working, commit, range). This is
   the headline the user asked for.
2. **File navigator** — a toggleable list of the changed files (status + path + per-file
   `+/−`); clicking one scrolls its card into view (expanding it if collapsed). Makes a
   large changeset navigable in one click.

Both are additive, read-only, and reuse the data the view already has.

## Non-goals (this spec)

- **Search within the diff** (Ctrl+F across the changeset) — valuable, but searching a
  *windowed/virtualized* diff (matches in unmounted rows) is a separate design; deferred to
  a follow-on plan under this same spec once the navigation surface lands.
- **Side-by-side (split) diff view**, **stage/unstage from Review**, **line comments** —
  larger product directions (Review is read-only v1). Noted as future; out of scope here.

## Design

### Data — the diffstat

The per-file added/removed counts **already exist** in the view: the working-tree source
gets them from `ChangeDTO` (`added`/`removed`, from git status), and the commit/range
sources derive them client-side from the fully-preloaded `FileDiffDTO[]` via
`commitChangesFromFiles` (`webview/review-commit.ts` ~30-44) — the same numbers that drive
each card's `+N −N` badge. So the summary is a **pure fold over the change list already in
hand**: `files = changes.length`, `insertions = Σ added`, `deletions = Σ removed`.

- Put this in a small pure module `webview/review-stats.ts` — `computeDiffstat(changes)` →
  `{ files, insertions, deletions }` — so it is unit-tested independently and both the
  summary header and the navigator's totals read the same source of truth.
- **No new IPC.** The counts already present are exact for commit/range (derived from full
  blob content, not the display-capped hunks) and match what the badges show — consistency
  with the rest of the view beats a second `--numstat` round-trip. (Caveat noted in the
  plan: binary files contribute to the file count but 0/0 lines, matching git.)

### UI — the summary header

Extend the existing `.review__head` (`review-view.tsx` ~436-443) from a bare count to a
diffstat line: **`N files changed · +INS −DEL`**, with the `+`/`−` in the add/remove
palette colors already used for diff signs (`--syn`/add-remove tokens). Empty state
unchanged ("No changes to review"). Loading/range-error states unchanged. This is the
default-visible headline; it needs no toggle.

### UI — the file navigator

A **collapsible file list** panel, toggled from the header (an icon button + a persisted
open/closed pref, mirroring `sidebarCollapsed`/`explorerCollapsed` in `AppSettings`).

- **Contents:** one row per changed file — change-kind badge (M/A/D/U), the path (basename
  emphasized, dir dimmed), and the per-file `+/−`. Reuses the same `changes` array and the
  same badge/stat rendering the cards already use (extract a shared `FileStat` bit if it
  reduces duplication).
- **Interaction:** clicking a row scrolls that file's card into view and expands it if
  collapsed. Review is windowed, so "scroll to file *i*" must go through the existing
  windowing/anchor machinery (`computeReviewAnchor` / the scroll-anchor memory at
  `review-view.tsx` ~257-286, the same mechanism jump-to-hunk uses) — set the anchor to the
  target file index and let the windower mount + scroll it. The active file (nearest the
  top of the viewport) is highlighted in the list as you scroll (derive from the same window
  math; no new observers).
- **Placement:** a left sub-column *inside* the Review view (not the app sidebar), so it
  scopes to Review and doesn't disturb the Files/Changes panels. Collapsed by default on
  narrow widths; the open/closed state persists globally via `AppSettings`
  (`reviewFileListOpen`), following the existing settings precedent (see
  [[conduit-*]] settings pattern: interface + `DEFAULT_SETTINGS` + coercer + `updateSettings`).

### Isolation / units

- `webview/review-stats.ts` — pure `computeDiffstat(changes)`; unit-tested. One purpose:
  fold the change list into `{files, insertions, deletions}`.
- Summary header — presentational, reads `computeDiffstat`. No state.
- File navigator — a presentational list + a click→anchor callback into the existing
  `ReviewView` scroll machinery; one new persisted bool in settings. It does not own diff
  data; it reads the same `changes` the cards read.

No change to the host, the IPC surface, or the diff/compare flow. Everything is a read-only
projection of data `ReviewView` already holds.

## Error handling

- Missing/partial counts (a file whose diff hasn't streamed yet in working mode): the
  summary sums what's known and updates as cards stream; it never blocks on a full load.
  The file navigator lists all `changes` immediately (the change list is known up front)
  and each row's `+/−` fills in when that file's stat is available.
- Empty changeset → summary shows the existing empty state; navigator hidden.
- Binary/image files → listed with their kind badge, `+/−` shown as `—` (no line counts),
  matching git.

## Testing

- **Unit** (`test/unit/review-stats.test.ts`): `computeDiffstat` — empty, mixed
  add/remove, a binary (0/0) file counted in `files` but not lines, singular/plural label.
- **Unit**: the navigator's active-file derivation from window math (pure helper), if
  extracted.
- **e2e** (`test/e2e/review-navigator.e2e.mjs`, on the shared harness): open Review on a
  multi-file change → the summary shows `N files changed · +X −Y`; open the file navigator;
  click a file far down the list → its card scrolls into view and is expanded. (Real-app
  because it exercises the windowed scroll-to-file path.)

## Future (noted, not built here)

Search-in-diff (windowed-aware) · side-by-side view · stage/unstage from Review · line
comments. Each is its own follow-on plan; the navigator + summary are the foundation they
build on.
