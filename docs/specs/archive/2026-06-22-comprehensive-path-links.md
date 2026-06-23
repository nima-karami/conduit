---
status: implemented
date: 2026-06-22
tier: FULL
---

# Feature Spec: Comprehensive terminal path-link matching

**Tier:** FULL   **Feature type:** UI
**One-line request:** "Addresses like `G:/awby/projects/vega-life-os` are detected and clickable, but `src/core/theme/accent.ts` can't be clicked. Pattern matching should be more comprehensive — at least match files in the CWD. If more than one file matches, clicking should open a dropdown with enough info to tell which file is which."

## 1. Problem frame

- **Job:** When a tool prints a file reference in the terminal, let me jump straight
  to that file in one click — regardless of whether the tool printed an absolute
  path, a project-relative path, or just a bare filename.
- **Actors:** A user reading terminal output (compiler errors, `grep`/`rg` hits,
  test failures, `git` output, agent logs) inside a session.
- **Success outcomes (observable):**
  - `src/core/theme/accent.ts` printed in output underlines on hover and opens the
    file on click (today it does nothing).
  - A bare filename like `accent.ts` that exists once in the project opens directly.
  - A bare filename that exists at multiple paths opens a disambiguation dropdown
    listing each candidate with enough context to pick the right one.
- **Non-goals:**
  - Linking arbitrary prose words that merely *look* like identifiers (no false
    positives on `foo.bar` method calls, version strings, package names).
  - Indexing/searching outside the session's project root.
  - Changing how already-working absolute / `./` / `../` links behave (regression
    surface only).
  - Symbol/definition navigation (that's the separate `goToDefinition` feature).

## 2. Behavior & states

**Primary flow (happy path):**
1. A line renders in the terminal. The renderer extracts candidate path tokens
   (broadened matcher — see §3).
2. For each token the host is asked to **resolve** it against the project: returns
   0, 1, or N existing file/dir candidates.
3. Tokens with ≥1 candidate are underlined-on-hover (`.term-path-link`); tokens
   with 0 candidates are plain text.
4. Click:
   - **1 candidate** → open it immediately (file → editor, honoring `:line:col`;
     directory → reveal, as today).
   - **N candidates** → open a disambiguation dropdown anchored at the click; the
     user picks one; selection opens it.

**States / transitions of a rendered token:**

| State | Meaning |
|---|---|
| `plain` | Matched the regex but resolved to 0 candidates → not a link |
| `resolving` | Resolution request in flight (no underline yet; never blocks paint) |
| `link-single` | Exactly 1 candidate → clickable, opens directly |
| `link-multi` | N candidates → clickable, opens disambiguation dropdown |
| `menu-open` | Dropdown shown; arrow/type-ahead selects; Esc/outside-click dismisses |
| `opening` | Chosen target dispatched to the existing open-file/reveal path |
| `resolve-failed` | Resolution IPC rejected/errored → treated exactly as `plain` (no underline), logged once; not retried until the line re-renders |

Resolution is async, **batched per rendered line**, and cached (mirrors today's
`pathExists` cache): a token never delays rendering; it gains its underline once
resolution returns. Batching bounds IPC volume — one request carries all candidate
tokens on a line, not one request per token (see §3 false-positive guards).

## 3. Data / interface contract

### Matcher (renderer — `webview/terminal-links.ts`)

Today's `PATH_RE` matches: POSIX absolute, Windows absolute, `./…`, `../…`, with an
optional `:line[:col]` suffix, and skips relative paths when `cwd` is absent. It does
**not** match bare project-relative tokens (`src/core/theme/accent.ts`) or bare
filenames (`accent.ts`). Broaden detection to also emit:

- **Bare relative path** — a token containing a path separator and no leading
  `./`/`../`/drive/root, e.g. `src/core/theme/accent.ts`, `webview/app.tsx`.
- **Bare filename with extension** — a single segment with a file extension, e.g.
  `accent.ts`, `main.ts`, `README.md`. (Require a `.` + 1–8 char extension to keep
  false positives down; no separator needed.)
- Preserve the existing `:line[:col]` suffix parsing for all forms.

A `PathToken` keeps its existing shape `{ path, line?, col?, start, end }`. The
renderer no longer decides existence locally for relative/bare forms — it defers to
host resolution (below).

**False-positive guards (must hold):**
- A bare filename token must have a recognized-looking extension (`/\.[A-Za-z0-9]{1,8}$/`)
  to even be a candidate; method calls like `obj.foo` would otherwise resolve to 0
  candidates → `plain`.
- **Bound the junk volume:** to avoid one IPC per method-call-looking token, the
  renderer (a) batches all candidate tokens on a line into a single `resolvePathToken`
  request, and (b) pre-filters bare single-segment tokens to those whose extension is
  in a known source/asset set (e.g. ts/tsx/js/jsx/json/md/css/html/py/go/rs/… — a
  bounded allowlist, extensible), so `obj.foo`/`config.bar` never hit the host.
  Tokens *containing a separator* skip the extension allowlist (a real path shape).
  Expected steady-state: a handful of tokens per line, ≤1 IPC per line, cached.
- Tokens preceded by a URL scheme (`http://`, `https://`, `git@`) remain excluded
  (keep current negative lookbehinds).
- Trailing sentence punctuation stripping (`TRAILING_JUNK`) still applies.

### Resolver (new host IPC)

Replace the per-token `pathExists` round-trip for relative/bare tokens with a richer
resolve call (absolute tokens may keep the cheap `pathExists` path):

- **Request:** `{ type: 'resolvePathToken'; sessionId: string; tokens: string[] }`
  — one batched request per rendered line; each `token` is a raw matched path
  (without the `:line:col` suffix).
- **Reply (success):** `{ type: 'resolvePathTokenResult'; sessionId: string;
  results: Array<{ token: string; candidates: PathCandidate[]; truncated: boolean }> }`
  where `PathCandidate = { absPath: string; relPath: string; isDir: boolean }`.
  - `relPath` is relative to the project root (display label).
  - `candidates: []` → token renders `plain`.
  - `truncated: true` → more than the cap matched; dropdown notes "showing first N".
- **Reply (error / unknown session / walk failure):** the IPC rejects (or replies
  with an empty-`results` envelope); the renderer treats every affected token as
  `resolve-failed` → `plain`. No partial-state crash.

**Resolution rules (host):**
1. **Exact match first, cwd over root:** if `token` joined to the session `cwd` is an
   existing path, that is candidate #1; else if `token` joined to the project root
   exists, that is candidate #1. (cwd takes precedence so a relative token means
   "relative to where the command ran".)
2. If `token` is a bare filename or a relative suffix, also find project files whose
   path **ends with** the token on a path-segment boundary (`accent.ts` matches
   `src/core/theme/accent.ts`, not `xaccent.ts`). Exact matches from rule 1 are not
   duplicated.
3. Scope = the session's project root (fall back to `cwd`). File set source:
   `git ls-files --cached --others --exclude-standard` when the root is a git repo
   (fast; includes untracked-but-not-ignored files; respects `.gitignore`); else a
   bounded recursive walk excluding `.git`, `node_modules`, and dotfolders. The file
   list is **cached per session and invalidated on cwd change**; a short TTL (e.g.
   5s) bounds staleness so files created after the cache was built become linkable
   without manual refresh.
4. Cap candidates at **N (default 50)** per token; if exceeded, return the first N
   with `truncated: true`.
5. Sort: exact/cwd-relative match first, then shortest `relPath`, then alphabetical.
6. **Case-sensitivity:** suffix-match case-sensitively on case-sensitive FSes
   (Linux), case-insensitively on Windows/macOS — i.e. follow the host platform so
   `Accent.ts` resolves to `accent.ts` only where the OS would. Symlinks are followed
   only as far as the underlying file-set source reports them (no extra traversal).

**Invariants:**
- Resolution is read-only; no workspace-containment beyond "under project root".
- A token that escapes the project root via `..` resolves only via rule 1 (exact),
  never via the filename search.
- Identical tokens dedupe in the renderer cache (one in-flight request per token).
- A `truncated` result still opens-on-pick for the candidates it did return.

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Concurrency / many tokens per line | Each token resolves independently; renderer cache + pending-map dedupe (as today); rendering never blocks on resolution. |
| Zero matches | Token stays plain text; no underline, no menu. |
| One match | Opens directly on click (no menu). |
| Many matches | Disambiguation dropdown; never auto-pick. |
| > N (50) matches | Show first N, dropdown footer notes truncation; token still opens-on-pick. |
| Token resolves but file deleted between resolve and click | Open attempt falls through the existing `readFile` error path; show the standard "could not open" handling, drop the stale cache entry. |
| No project root / no cwd | Absolute tokens still work (exact `pathExists`); bare/relative tokens render plain. |
| Huge / non-git repo (slow walk) | Walk is bounded + result-capped; per-session file-list cache (TTL + cwd-change invalidation, rule 3) means first resolve may lag but never blocks paint. |
| File created after the cache was built | Becomes linkable once the TTL lapses or cwd changes; no manual refresh required. |
| Resolution IPC errors / unknown session | All affected tokens render `plain` (`resolve-failed`); error logged once; never crashes the line. |
| Case-insensitive FS (Windows/macOS) | Suffix match honors host case rules (rule 6): `Accent.ts` ↔ `accent.ts` only where the OS treats them as equal. |
| Untracked-but-not-ignored file | Linkable: git source uses `--others --exclude-standard`; ignored files stay non-linkable. |
| `:line:col` on a multi-candidate token | The line/col carries to whichever candidate the user picks. |
| Windows vs POSIX separators | Resolver normalizes separators before suffix-matching; matches `src/core/theme/accent.ts` and `src\core\theme\accent.ts`. |
| Token is a directory name | Same flow; single dir → reveal; multiple dirs → dropdown; mixed file/dir candidates allowed (rows show a folder vs file icon). |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Candidate cap | 50 | No (constant) | Keeps the menu usable and the search bounded; revisit only if users hit it. |
| Bare-filename matching | On | No | The whole point of the request; resolution is the false-positive filter. |
| Search scope | project root, fall back to cwd | No | "files in the CWD" intent; project root is the useful unit. |
| File source | `git ls-files` if git, else bounded walk | No | Fast + respects ignore rules where possible. |
| Min extension to treat a bare word as a filename | `.` + 1–8 alnum chars | No | Cheap pre-filter; resolution does the rest. |

No user-facing setting is introduced; the behavior is a strictly better default.

## 6. Scope slicing

- **MVP (must):** Match bare relative paths *with separators* and resolve them via
  **rule 1 only** (exact join against cwd, then project root) — covers the literal
  `src/core/theme/accent.ts` request. `resolvePathToken` returns 0/1 candidates;
  single-candidate open works. No project-wide search yet, so no dropdown needed.
- **v1 (should):** Add **rule 2** (bare-filename / suffix search over the project
  file set) + the disambiguation dropdown for N>1, with per-row context (relative
  path, file/dir icon) and the truncation note. This is the bulk of the host work and
  is deliberately separated from MVP.
- **Vision (could):** Fuzzy/partial-suffix matching; recent-files ranking in the
  dropdown; preview-on-hover of a candidate; respect additional ignore files.
- **Out of scope:** Symbol navigation; cross-project resolution; linking non-path
  tokens.

## 7. Acceptance criteria

**Declarative:**
- A printed `src/core/theme/accent.ts` that exists opens that file on click.
- A printed bare `accent.ts` that exists at exactly one path opens it directly.
- A printed bare `accent.ts` that exists at multiple paths opens a dropdown listing
  each candidate by relative path; picking one opens it.
- A token that matches nothing renders as plain (non-underlined) text.
- Existing absolute / `./` / `../` / `:line:col` behavior is unchanged.

**EARS:**
- *Event-driven:* When a terminal line containing a token that resolves to exactly
  one existing file is clicked, the system shall open that file in the editor,
  honoring any `:line:col` suffix.
- *Event-driven:* When a token that resolves to more than one candidate is clicked,
  the system shall display a disambiguation dropdown anchored at the click and shall
  not open any file until the user selects one.
- *Unwanted:* If a matched token resolves to zero candidates, then the system shall
  render it as plain text with no hover underline.
- *State-driven:* While a token's resolution request is in flight, the line shall
  already be painted and text-selectable, and the token shall gain its hover
  underline only after candidates return (observable: the line renders before the
  `resolvePathTokenResult` arrives).
- *Unwanted:* If the chosen file no longer exists at open time, then the system
  shall surface the existing open-failure handling and evict the stale cache entry.
- *Unwanted:* If a resolution request errors, then the affected tokens shall render
  as plain text and the rest of the line shall be unaffected.

**Gherkin:**
```gherkin
Scenario: Bare filename with one match opens directly
  Given the project contains exactly one file named "accent.ts"
  And the terminal prints the word "accent.ts"
  When I click "accent.ts"
  Then "src/core/theme/accent.ts" opens in the editor
  And no dropdown is shown

Scenario: Ambiguous filename opens a disambiguation dropdown
  Given the project contains "src/a/config.ts" and "src/b/config.ts"
  And the terminal prints the word "config.ts"
  When I click "config.ts"
  Then a dropdown lists "src/a/config.ts" and "src/b/config.ts"
  When I select "src/b/config.ts"
  Then "src/b/config.ts" opens in the editor

Scenario: Windows-separator relative path links
  Given the project contains "src/core/theme/accent.ts"
  And the terminal prints "src\core\theme\accent.ts"
  When I click it
  Then "src/core/theme/accent.ts" opens in the editor

Scenario: Too many matches are truncated but still usable
  Given a bare filename matches more than 50 project files
  When I click the token
  Then the dropdown lists the first 50 candidates
  And shows a "showing first 50" note
  And selecting any listed candidate opens it

Scenario: A directory token reveals instead of opening an editor
  Given the token resolves to exactly one existing directory
  When I click it
  Then the directory is revealed (as today), not opened in the editor
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Path token | plain | Normal terminal text | — |
| Path token | link (single/multi) | Underline on hover, pointer cursor | Click → open / open menu |
| Disambiguation dropdown | open | List of candidate rows (icon + relative path, middle-ellipsized if too long, full path as tooltip), optional "showing first 50" footer | Click / Enter a row → open |
| Disambiguation dropdown | (vision) empty after filter | "No matches" row — only exists if the deferred type-to-filter is added (see §6 vision) | type to adjust / Esc |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Link token | open / open-menu | hover underline; click | Enter when focused (xterm link focus model as today) | tap | — (reuse terminal right-click) | link affordance via `.term-path-link` |
| Dropdown | select / dismiss | click row; click-outside dismiss | ↑/↓ move, Home/End, Enter select, Esc close | tap row to select; tap-outside (scrim/next-tap) dismisses | — | `role="menu"` / `menuitem`, `aria-activedescendant` |

Reuse `webview/components/context-menu.tsx` (`MenuState {x,y,items}`, `MenuItem
{label,icon,onClick,disabled}`, portal to `document.body`, viewport clamping,
keyboard nav, Esc/outside-click dismiss) for the dropdown — it already provides every
interaction above. Each candidate becomes a `MenuItem` (label = relative path, icon =
file/dir, `onClick` = open). A truncation note can be a disabled trailing item.

## 10. Accessibility & i18n

- **Keyboard:** Dropdown is fully operable via ↑/↓/Home/End/Enter/Esc (inherited
  from ContextMenu). Focus returns to the terminal on dismiss.
- **Screen reader:** Menu exposes `role="menu"`/`menuitem`; each row's accessible
  name is the **full** relative path even when the visible label is middle-ellipsized
  for width. Announce candidate count is optional (could set `aria-label` on the
  menu: "N files match accent.ts").
- **Contrast / motion:** Link underline and menu reuse existing themed tokens; menu
  reuses the existing `modal-fade` animation (respect any reduced-motion handling the
  component already has).
- **i18n:** User-facing strings are limited to "Showing first 50" / "No matches" /
  the optional menu aria-label — route them through the same string constants pattern
  the git-history view uses (`STR.*`); no hardcoded English in new components.

## 11. Design tokens (UI)

- Reuse existing semantic roles: `.term-path-link` (link affordance), `.ctxmenu`
  rows (`--accent-soft` hover), menu shadow/elevation. No new hex; inherits
  light/dark/high-contrast from existing variables. File/dir icons reuse
  `webview/icons.tsx` (`IconFolder`, a file icon).

## 12. Assumptions

- The session already knows its project root / `cwd` on the host (it does — used for
  `pathExists`, git info, project-info). Resolution scopes to that.
- A per-session file list (git-tracked or bounded walk) can be cached and refreshed
  on cwd change; building it lazily on first resolve is acceptable latency.
- The dropdown does **not** need a type-to-filter input for v1 (candidate count is
  capped at 50 and rows are short); add filtering only if real usage shows long
  lists. Recorded as an explicit MVP simplification.
- Mixed file/dir candidates are allowed in one dropdown; rows differentiate by icon.
- Existing `pathExists` stays for absolute/`./`/`../` tokens to avoid regressing the
  cheap, proven path; only bare/relative tokens use `resolvePathToken`.

## 13. Decisions Needed

- N/A (interactive mode). The two material forks — matching scope and the
  dropdown-on-ambiguity behavior — were resolved directly with the user
  (scope = project-relative + recursive bare-filename; dropdown on >1 match).

## 14. Open questions

- None blocking. (Type-to-filter in the dropdown and candidate ranking beyond
  shortest-path are deferred to vision, not gating MVP/v1.)
