---
status: active
date: 2026-09-28
---

# Feature Spec: Tree chevrons — one left-side twistie for Files and Changes

**Tier:** FULL (two surfaces, user-facing, shared primitive)   **Feature type:** UI
**Item id:** tree-chevrons
**One-line request (verbatim):** "Right now the chevron icon that allows the user to expand or
collapse a folder is on the right side when looking at a session folder and on the left side when
looking at the changes. This needs to be consistent across both and it needs to be on the left side
for both. The user experience and the UI of it all also need to look similar to one another. Right
now it does not."

## 1. Problem frame

- **Job:** scanning the right pane, the user expands/collapses a session folder the same way — same
  place, same glyph, same motion — whether they are on **Files** or **Changes**.
- **Which surface is "session folder".** Resolved from code *and* measurement: it is the Files tab's
  per-folder section bar (`FolderBar`, `webview/components/folder-bar.tsx`, `.files__bar`), whose
  collapse button `.files__collapse` is rendered **after** the name and tag, in the right-hand icon
  cluster. Its Changes counterpart is the per-repo head (`RepoHead`, `webview/components/repo-head.tsx`,
  `.repo-head`), whose `.repo-head__chev` is the **first** child. Other candidates were ruled out:
  the Files tree's folder rows (`.filerow__chev`, `folder-section.tsx`) already put the chevron on the
  left; the sidebar project groups (`project-group-header.tsx`, `.proj__chevron`) are left too and are
  not "session folders". Row-level: Changes has **no nested folder rows** — change rows are a flat
  list carrying a `dir/` prefix — so "the tree" on Changes is head + flat leaves.
- **Actors:** anyone using the right pane; keyboard and screen-reader users.
- **Success outcomes:** in all three themes, the header chevron sits at the same x in both tabs, left
  of the folder glyph; headers and rows share one chevron glyph, rotation, motion, fill, gutter and
  row metrics; collapse behaviour (what toggles, what persists) is the same.
- **Non-goals:** turning Changes into a nested folder tree ("View as tree"); making Changes rows
  keyboard-navigable (§13 D3); changing Review navigator cards (`.rcard__chev`), the sidebar
  project groups, markdown TOC, or any dropdown caret (`IconChevronDown` used as a menu caret stays).

## 2. Behavior & states

### Current behaviour (measured)

Measured 2026-09-28 by driving the built app (`npm run build`, then a scratch Playwright-Electron
script on `test/e2e/harness.mjs` `launchApp`/`openSession`, a session with two git repos `home` +
`ref`, each with a staged `src/new.ts` and an unstaged `src/deep/a.ts`; theme seeded into
`settings.json` as `shoot.mjs` does). Pixel values are from Aero / Aero Dark (identical geometry);
Neon was screenshotted.

| Claim about today's behaviour | How measured | Measured / ASSUMED |
|---|---|---|
| Files bar chevron is on the right: bar x=1094; folder glyph x=1102; collapse button x≈1302 (after name+tag, before Refresh/New/⋯) | `getBoundingClientRect` of `.files__bar` children in order; Neon screenshot | Measured |
| Changes head chevron is on the left: head x=1096, chevron button x=1100 (24px), folder glyph x=1134 | same, `.repo-head` children | Measured |
| Clicking the folder **name** toggles neither header (Files stays expanded; Changes stays as-is — the click only sets repo context) | click `.files__root-name` / `.repo-head__name`, read `aria-expanded` | Measured |
| Files section collapse **survives** a Files→Changes→Files tab switch; Changes repo collapse is **lost** (re-expands) after Changes→Files→Changes | collapse, switch tabs, read `aria-expanded` | Measured |
| Files rows 22px tall; Changes rows 27px; both heads 32px | rects | Measured |
| Hover wash on `.filerow` and `.change` is identical (`rgba(27,31,42,.06)` Aero, `rgba(255,255,255,.09)` Neon) | hover, computed `backgroundColor` | Measured |
| Files home bar fill is the neutral overlay (0.035); Changes home head is accent 6% | computed `backgroundColor` of both heads | Measured |
| Changes rows have no `role` and are not focusable (`tabIndex` -1); Files rows are `role=treeitem` in a `role=tree` with roving tabindex | DOM attributes read in-app | Measured |
| Files row gutter starts 2px left of Changes' (1094 vs 1096) | rects | Measured |
| Files folder rows do not compact single-child chains (`src` and `deep` are separate rows) | row texts after expanding `src` | Measured |

### Difference inventory and chosen convergence

"Ref" = which side is the reference. Files wins where they disagree unless Changes is clearly the
more VS Code-like (or the only token-correct) one; the reason is given when Changes wins.

| # | Aspect | Files (bar / rows) | Changes (head / rows) | Converged treatment | Ref |
|---|---|---|---|---|---|
| 1 | Header chevron position | right, after tag | left, first child | **left, first child** | Changes (locked) |
| 2 | Chevron glyph | bar: `IconChevronDown` 14px rotated −90° when collapsed; rows: `IconChevron` 12px rotated +90° when open | `IconChevronDown` 12px rotated −90° when collapsed | **`IconChevron` 12px, `rotate(90deg)` when open**, everywhere | Files rows |
| 3 | Rotation motion | bar 0.12s, rows 0.1s; only the bar has a reduced-motion guard | none (0s) | **0.1s transform; `none` under `prefers-reduced-motion`** | Files rows (+guard) |
| 4 | Chevron colour | rows `--text-faint`; bar via `.iconbtn` quiet ladder | `--text-dim` + quiet ladder | header: quiet-role button ladder (unchanged); rows: `--text-faint`. Both via the shared class | Files |
| 5 | Header hit target | 24px `iconbtn--sm` button | 24px `iconbtn--sm` button | unchanged: **chevron button only** toggles; name click keeps its current meaning | both (§13 D2) |
| 6 | Header column geometry | glyph at +8 | chevron +4, glyph +38 | chevron glyph centre on the **same x as a depth-0 row chevron** (row chevron left edge +10, **centre +16** from the row's left edge); folder glyph one fixed gap after the button; identical in both tabs | new, shared |
| 7 | Header fill | neutral overlay for all | accent 6% for home, overlay for others | **neutral overlay for all** (home still marked by tag + accent glyph) | Files (§13 D4) |
| 8 | Header folder glyph colour | accent always | accent on home, `--text-dim` otherwise | **accent always** | Files |
| 9 | Home/Attached tag | `.files__tag`: 10.5px/500, padding 1px 6px, hard `border-radius: 8px`; ≤200px: visually clipped but still in the a11y tree | `.repo-head__tag`: 9.5px/600, padding 2px 6px, `--r-badge`; ≤200px: `display:none` (head's `aria-label` names it) | **one pill treatment** (size, weight, padding, `--r-badge`) from `RepoTagPill`'s CSS; each surface **keeps its own narrow-hiding** (Files must stay accessible-clipped — its bar has no group label) | Changes — Files' 8px is a raw radius, banned by the token rule |
| 10 | Row gutter (scroll padding) | `.rightpane__scroll--files` 6px | `.rightpane__scroll` 8px | **one value** (Files' 6px) for both tabs' scroll containers | Files |
| 11 | Row height | 22px (`padding: 2px 8px`) | 27px (`padding: 5px 8px`) | **22px** | Files (also VS Code's 22px) |
| 12 | Row leading column | chevron slot 12px (spacer on files), gap 6, icon | status box at +8, gap 9 | Changes row = a **depth-0 leaf**: 10px pad + 12px chevron **spacer** + 6px gap + status box (status box takes the icon column) | Files |
| 13 | Row radius | `--r-card` | `--r-sm` | **`--r-card`** | Files |
| 14 | Row name font | mono 12px, 400 | mono 11.5px; filename 700, dir faint | **mono 12px**; Changes keeps its dir/file weight split (Changes-specific) | Files size |
| 15 | Hover / press / focus | `.files__collapse`: quiet `.iconbtn` ladder only | `.repo-head__chev` is **also** listed in the *field* role lists (`styles.css` ~13650/13698; no visible effect today since `.iconbtn` has `border:0`) | **quiet only**: remove `.repo-head__chev` from the field lists (fix at the list, no override) | Files |
| 16 | Selected / revealed | selected spine + revealed tint | none | not in this spec — see sibling `changes-active-highlight` (§13 D5) | — |
| 17 | Section labels / empty rows | n/a | `STAGED`/`CHANGES` at 8px; `.repo-head__empty` at 32px | realigned to the row **icon column** so they sit over the status boxes | derived |
| 18 | Sub-path line under head | inline `— parentHint` | own line, `padding-inline-start: 50px` / 27px active | stays Changes-specific; start re-derived from the new glyph column, not a magic number | derived |
| 19 | Collapse persistence | survives tab switch (`FolderUiCache`, `right-pane.tsx:139`) | lost on tab switch (`useState` in `ChangesView`) | **survives tab switch** in both, same lifetime as `FolderUiCache` | Files |
| 20 | Keyboard | header button Enter/Space; tree ←/→/↑/↓/Home/End/Enter | header button Enter/Space; rows unreachable | header behaviour identical (already); rows unchanged (§13 D3) | — |
| 21 | Indent guides | none | none | none | — |
| 22 | Compact folders | none | n/a (dir prefix) | none | — |
| 23 | Active-repo view (Changes, single repo) | n/a | no chevron; glyph shifts left | **chevron-width spacer** so the glyph column does not move between All/Active views | new |

Changes-specific affordances stay: status letter box, `+N −N` stat, hover row actions
(Stage/Unstage/Discard), branch chip, active-repo picker, sub-path line, section labels.

### States

| Surface | State | Chevron |
|---|---|---|
| Header (Files, Changes-All) | expanded | points down (`rotate(90deg)` of right-pointing glyph) |
| Header | collapsed | points right |
| Header (Changes-Active) | not collapsible | none; spacer holds the column |
| Row (Files folder) | open / closed | as header |
| Row (Files file, Changes change) | leaf | spacer, no glyph |
| Any | reduced motion | snaps, no transition |
| Changes head | motion (new) | today snaps (0s); after: 0.1s rotation like Files |

## 3. Interface contract

**Shared primitive (recommended; Decision D1).** One chevron component + one CSS family, reused by
all four call sites; no second copy of the rules.

- `webview/components/tree-chevron.tsx` (new, tiny): `TreeChevron({ open }: { open: boolean })` →
  `<IconChevron size={12} className={'treechev' + (open ? ' treechev--open' : '')} />`, and
  `TreeChevronSpacer()` → `<span className="treechev-spacer" aria-hidden />`. Decorative: no ARIA of
  its own; the enclosing button/treeitem keeps `aria-expanded`.
- CSS: `.treechev`, `.treechev--open`, `.treechev-spacer` **replace** `.filerow__chev*`,
  `.files__bar-chev*`, `.repo-head__chev--collapsed svg` (delete those, don't layer on them). Source
  for the rules: today's `.filerow__chev` block (`styles.css` ~6604–6615) plus the reduced-motion
  guard from `.files__bar-chev`.
- Header chrome: a shared **`.treehead`** class carrying what `.files__bar` and `.repo-head` both
  define today (fill, `min-height`, radius, left padding, gap, font) — applied to both roots; their
  own classes keep only what differs (flex-wrap + container on `.repo-head`, `justify-content` on
  `.files__bar` becomes dead once the chevron leads and `.files__root` flexes — **delete it**, don't leave it).
- Row geometry: shared **custom properties** (`--tree-row-h`, `--tree-pad`, `--tree-indent: 14px`,
  `--tree-gap: 6px`) declared once; `.filerow` and `.change` consume them. `folder-section.tsx`'s
  inline `paddingLeft: 10 + depth * 14` becomes `calc(var(--tree-pad) + depth * var(--tree-indent))`
  via a `--depth` style var, so the 10/14 literals exist once.
- Class names must be Conduit-prefixed shapes (`treechev`, `treehead`), never `twistie` — Monaco ships
  `.monaco-tl-twistie` and the peek tree was already broken once by a generic name
  (`test/unit/monaco-class-collision.test.ts` must stay green).

**Producers / consumers**

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Files section collapsed set | `FilesView.toggleCollapsed` → `FolderUiCache.collapsed` (`right-pane.tsx`) | `FolderSection` → `FolderBar` | yes (unchanged) |
| Changes repo collapsed set | today `ChangesView` `useState`; after: a cache owned by `RightPane` alongside `folderUiRef`, keyed by `folderKey(root)` | `ChangesView` → `RepoHead` | yes — producer moves up, consumer reads it |
| `ChangesViewMode` (All/Active) | settings | `RepoHead` chevron vs spacer | yes (read-only) |
| `focusAfterViewRef` "first-chevron" target | `ChangesView.setView` | querySelector `.repo-head__chev` | yes — the button keeps class `.repo-head__chev` (it is the focus target; drop it from the field role lists per inventory row 15) |

Invariant: moving Changes' collapse state must not change **which** repos are collapsible (All view
only) nor reset on `ChangesModel` refreshes; like `FolderUiCache` it is keyed by `folderKey(root)` and **outlives** tab switches and session switches (never reset; a repo shared by two sessions shares its collapsed state). The Files and Changes caches stay **separate** — collapsing `home` in Files does not collapse it in Changes (§13 D6).

## 4. Edge cases & failure modes

| Condition | Expected |
|---|---|
| Narrow pane (≤200px bar container) | chevron stays visible and first; the container queries that hide Files extras (≤280px) and tags (≤200px) keep working — they hide `.files__bar-extra`/tag only |
| ≤200px, shared tag CSS | Files tag stays accessibly clipped (no `display:none` — the bar has no group label); Changes tag stays `display:none` (its head's `aria-label` names it) |
| Very long folder name | name ellipsizes; chevron never shifts or shrinks (`flex: none`) |
| Files section collapsed then `revealInTree` | still expands it (unchanged) |
| One repo in Changes, All view | chevron shown and works (as today) |
| Switch All→Active→All | glyph column does not move (spacer); focus lands on first chevron (existing `first-chevron` path) |
| Repo removed from session while collapsed | stale key in the cache is harmless; not rendered |
| Session switch | both caches persist, keyed by path (today's `FolderUiCache` lifetime); returning to a session shows what was collapsed |
| Drag onto a collapsed Files section | unchanged drop behaviour |
| Font zoom (`--font-scale`) | row height/gaps scale the same in both tabs (row height derived from content + padding, not a fixed px if `--font-scale` ≠ 1) |
| RTL folder names (`<bdi dir=auto>`) | chevron stays at the physical left (UI chrome is LTR) |

## 5. Defaults vs settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Chevron side | left | no | locked; VS Code parity |
| Header toggle target | chevron button only | no | unchanged behaviour; name click already means "set repo context" on Changes |
| Row height | 22px | no | Explorer/VS Code density |
| Motion | 0.1s, off under reduced motion | OS setting | existing convention |

## 6. Scope slicing

- **MVP:** rows 1–4, 6–15, 17, 18, 23 of the inventory; shared `TreeChevron` + `.treechev` +
  `.treehead` + row custom properties; Changes collapse persistence (row 19).
- **v1:** none beyond MVP.
- **Vision:** Changes "View as tree"; keyboard-navigable Changes list; revealed-diff highlight.
- **Out of scope:** Review navigator, sidebar project groups, menu carets, Files tree behaviour.

## 7. Acceptance criteria

All checked in the running app (Playwright-Electron via `test/e2e/harness.mjs`; new scenario
`test/e2e/tree-chevrons.e2e.mjs`), fixture: one session, two git repos (home + attached), each with a
staged and an unstaged change and a nested folder; run **every AC** in **aero, aero-dark, neon** (seed
`settings.json` as `test/e2e/visual/shoot.mjs` `seedProfile` does). Pixel tolerances ±1px.

- **AC1** In Files, each `.files__bar`'s collapse button is its first focusable child and its
  left edge is left of the folder glyph and the name.
- **AC2** The header chevron glyph's centre x is equal in Files and Changes (same pane width), and
  equals the centre x of a depth-0 folder row's chevron in Files.
- **AC3** The folder glyph's x in the header is equal in Files, Changes-All and Changes-Active.
- **AC4** Every expand/collapse chevron in both tabs is the same SVG (`.treechev`) at 12px; expanded
  ones compute `matrix(0, 1, -1, 0, 0, 0)` (= `rotate(90deg)`), collapsed `none` — including the Files bar and the Changes head.
- **AC5** With `prefers-reduced-motion: reduce` emulated, `.treechev` `transition-duration` is `0s`;
  otherwise `0.1s`.
- **AC6** `.change` and a `.filerow` leaf are both **22px** tall, compute the resolved `--r-card` radius, and share a left edge; a `.change`'s
  status box x equals a depth-0 `.filerow` file icon's x.
- **AC7** `.files__bar` and `.repo-head` compute equal `background-color` (the neutral overlay, not the
  accent mix), `min-height: 32px`, `border-radius` and `padding-left`; the Home/Attached tags compute
  equal font-size, font-weight, padding and radius. At a ≤200px bar the Files tag is still in the
  accessibility tree (`page.accessibility`/`getByText` finds it) while not visible.
- **AC8** Collapse a Changes repo, switch to Files and back: it is still collapsed
  (`aria-expanded="false"`). Same for a Files section (regression guard).
- **AC9** Clicking a header's name does not toggle it, in either tab. Enter and Space on the focused
  header chevron toggle it and flip `aria-expanded`, in both tabs.
- **AC10** Status letters, `+N −N`, row actions on hover, branch chip and the Active-view picker are
  present and clickable as before (existing `changes-multi-repo.e2e.mjs` and `mf-files.e2e.mjs` pass);
  on a hovered 22px `.change` the `.change__row-actions` rect lies inside the row's rect and a real
  click on Stage stages the file.
- **AC11** `npm run verify` green, including `state-vocabulary`, `monaco-class-collision` and
  `drag-region` unit tests. *Review checklist (not mechanical):* no new `!important`, no selector
  added only to out-rank another, old chevron rules deleted rather than overridden.
- **AC13** Under emulated `forced-colors: active`, the header and row chevrons are visible
  (computed `color`/`fill` resolves to a system colour, not transparent) in both tabs.
- **AC12** At pane widths 200px and 280px (container-query breakpoints) no header content overlaps
  the chevron, and `npm run text-fit` reports no new overflow in the right pane.

EARS:
- *When* a header is expanded, the system *shall* render its chevron pointing down at the left of
  the folder glyph, in both Files and Changes.
- *While* the Changes view is Active, the system *shall* reserve the chevron column without a glyph.
- *When* the user returns to a right-pane tab, the system *shall* restore that tab's collapsed
  headers for the current session.

```gherkin
Scenario: Same chevron in both tabs
  Given a session with a home repo and an attached repo, each with changes
  When I open the Files tab and then the Changes tab
  Then each folder header shows a chevron on its left, at the same x in both tabs
  When I collapse "ref" on the Changes tab and switch to Files and back
  Then "ref" is still collapsed and its chevron points right
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Header chevron | rest / hover / press / focus | quiet-role ladder; focus ring | click, Enter, Space toggle |
| Header chevron | expanded / collapsed | down / right | — |
| Header | Active view | no chevron, column held | picker opens repo menu |
| Row (folder) | open / closed / selected / revealed / drop-target | as today | — |
| Change row | rest / hover (row actions shown) | as today, new metrics | click opens diff |
| Loading / clean / no repos | `.repo-head__empty`, EmptyState | realigned text column | — |

## 9. Interaction inventory (UI)

| Component | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|
| Files bar chevron | click toggles | Tab (first in bar), Enter/Space; Shift+F10 opens folder menu | bar | button, `aria-expanded`, `aria-controls` |
| Changes head chevron | click toggles | Enter/Space; Shift+F10 opens repo menu | head | button, `aria-expanded`, `aria-controls` |
| Files folder row | click toggles; Ctrl/Shift select | ←/→/↑/↓/Home/End/Enter | row | treeitem, `aria-expanded` |
| Change row | click open, middle-click background, drag | unchanged (none) | row | unchanged |

Tab order change: in Files the chevron moves from after the name to first — it already was the first
**button**, so tab order is unchanged; only its visual position moves (DOM order = visual order).

## 10. Accessibility & i18n (UI)

- Chevron glyph is decorative; labels stay "Expand/Collapse <name>" on the buttons (strings unchanged).
- Focus ring on the header chevron unchanged (`--focus-ring` + `--focus-outline`).
- Forced colours: the chevron uses `currentColor`; check the header chevron is visible in
  `forced-colors: active` (existing addendum in the vocabulary spec).
- Reduced motion honoured (AC5). Target size stays 24×24.
- No new strings; RTL names isolated by existing `<bdi>`; chevron not mirrored (LTR chrome).

## 11. Design tokens (UI)

Only existing tokens: `--text-faint` (row chevron), quiet-role `--state-*` for the header button,
`--overlay` fill, `--accent` glyph, `--r-card` rows, `--r-sm` heads, `--r-badge` tags, `--font-mono`,
`--font-ui`, `--font-scale`. New layout custom properties (row height/pad/indent/gap) are geometry,
not colour, and are declared once. `NEON_GEOMETRY` has no `chevron` entry, so the glyph is the same in all
themes; the header **folder** glyph does have a Neon override, which is why AC3 must run in Neon too.

## 12. Assumptions

- "Session folder" = the Files tab's per-folder section bar (measured, §1/§2).
- Header chevron column aligned with depth-0 row chevrons (not indented one step) — the tidiest
  single column; reversible CSS.
- Changes rows shrink to 22px; the 17px status box fits.
- Scroll gutter unified at Files' 6px.

## 13. Decisions Needed

- **[normal] D1 — Shared primitive shape.** Default: a tiny `TreeChevron` component + `.treechev` /
  `.treehead` classes + row custom properties (not a full shared `TreeRow` component — the two rows'
  contents and behaviours differ too much for one component to pay off).
- **[normal] D2 — Should clicking the whole header toggle (VS Code section-header behaviour)?**
  Default: no; chevron button only, as today in both tabs (Changes name-click already sets repo context).
- **[normal] D3 — Keyboard navigation for Changes rows** (role=tree/listbox, arrows). Default: out of
  scope; rows stay as today. Worth its own item — they are currently unreachable by keyboard.
- **[normal] D4 — Drop the Changes home head's accent-6% fill** in favour of Files' neutral fill.
  Default: drop it (Files is the reference; home stays marked by tag + accent glyph).
- **[normal] D5 — Highlight the Changes row whose diff is open** (Files' "revealed" tint). Default:
  not here — owned by sibling spec `2026-09-28-changes-active-highlight.md` (`.change--active`).
  Coordination: this spec keeps `ChangeRow` as the row component and the `.change` class, so that
  modifier lands on the converged row; whichever builds second rebases onto the other.
- **[normal] D6 — Share collapse state between Files and Changes** (collapse `home` in one, it
  collapses in the other)? Default: no, separate caches — the two tabs answer different questions and
  a Changes collapse hiding a Files tree would surprise.
