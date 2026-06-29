---
status: active
date: 2026-06-29
tier: FULL
---

# Feature Spec: Clickable commit hashes in terminal output → open the commit in Review

**Tier:** FULL   **Feature type:** UI (terminal interaction, crosses host IPC)
**One-line request:** "In Claude Code … sometimes it gives you the commit code …
'We made all these changes under this commit.' It would be good to be able to click
that commit and it would open in the review changes tab."

So: a commit hash printed in the terminal becomes a clickable link that opens that
commit, scoped, in the Review Changes tab.

## 0. Dependency (hard prerequisite)

This feature builds on the **separate** `review-commit-source` feature
(`docs/specs/2026-06-29-review-commit-source.md`, being specced in parallel), which
teaches the Review Changes tab to display a **specific commit** instead of only the
working tree. That feature owns the Review rendering of a commit and exposes an
app-level entry point assumed here:

```ts
openReviewForCommit(sha: string, sessionId?: string): void
```

**This spec covers ONLY** terminal-side commit-hash *detection*, host-side
*validation*, and *routing* a clicked hash into `openReviewForCommit`. It does not
change how Review renders a commit. If `openReviewForCommit` is not yet available at
build time, this feature is blocked on it (see §6 / Decisions Needed D5).

## 1. Problem frame

- **Job:** When an agent (or any tool) prints "committed as `<hash>`" in the
  terminal, let me jump straight to a scoped review of *that commit's* changes in one
  click — without copying the hash, switching to History, hunting for it, and opening
  it manually.
- **Actors:** A user reading terminal output inside a session — most commonly the
  Claude Code "I committed these changes under `<sha>`" line, but also `git commit`
  output, `git log --oneline`, CI logs, etc.
- **Success outcomes (observable):**
  - A real short/full commit hash printed in the terminal underlines on hover and,
    on click, opens the Review Changes tab scoped to that commit.
  - A hex-looking token that is **not** a commit in the active repo (a CSS color, a
    hex id, an npm integrity fragment) is plain text and does nothing.
  - The commit is resolved against the **clicked terminal's session's active repo**
    (multi-repo correctness).
- **Non-goals:**
  - Rendering the commit diff itself (owned by `review-commit-source`).
  - Linking commit *ranges* (`a1b2c3d..e4f5g6h`), reflog selectors, `HEAD~3`,
    branch/tag names, or short refs that aren't hex hashes.
  - Linking hashes that belong to a *different* repo than the clicked session's
    active repo (cross-repo lookup is out of scope; an unresolved hash is just plain
    text).
  - Changing existing path-link behavior except where precedence requires (§3.4).

## 2. Behavior & states

**Primary flow (happy path):**
1. A terminal line renders. The renderer extracts **commit-hash candidate** tokens
   (word-bounded hex runs, length 7–40 — §3.1), in addition to the existing path
   tokens.
2. Candidate hashes on the line are **validated host-side** in one batched request
   against the clicked session's active repo: each is checked with
   `git rev-parse --verify <sha>^{commit}` semantics (is it a real commit object?).
   The host returns, per candidate, the **full 40-char sha** if valid, else `null`.
3. Candidates that validate get the link decoration (pointer cursor + underline on
   hover, reusing the path-link affordance). Candidates that don't validate stay
   plain text.
4. Click a validated hash → `openReviewForCommit(fullSha, sessionId)` is called with
   the **host-returned full sha** and the clicked pane's `sessionId`. The Review tab
   opens/activates scoped to that commit (dependency feature).

**States / transitions of a rendered commit token:**

| State | Meaning |
|---|---|
| `candidate` | Matched the hex-shape regex; not yet validated; rendered plain (no underline yet — never blocks paint) |
| `validating` | Validation request in flight |
| `commit` | Host confirmed a real commit → clickable; opens Review-for-commit on click |
| `not-a-commit` | Host returned `null` → rendered plain text, no underline, no action |
| `opening` | Click dispatched → `openReviewForCommit(fullSha, sessionId)` |
| `validate-failed` | Validation IPC rejected/errored/unknown-session → treated exactly as `not-a-commit` (plain), logged once, not retried until the line re-renders |

Validation is async, **batched per rendered line**, and **cached per repo-root**
(mirrors the path-link `resolveCache`): a token never delays rendering; it gains its
underline once validation returns. A confirmed sha stays cached for the pane's repo;
a `null` result is also cached so a non-commit token isn't re-validated on every
re-paint. Cache is keyed by `(repoRoot, token)` so the same hex string can validate
in one session's repo and not in another's.

**Staleness / cancellation:** xterm's link provider re-calls `provideLinks` per
buffer row, and a row's content can change (scrollback, re-wrap, redraw) before a
validate reply lands. Results are applied **only through the `(repoRoot, token)`
cache**, never painted directly onto a row by position — so a reply that arrives after
the row re-rendered just populates the cache and is re-consulted on the next
`provideLinks` call; it can't mislink a now-different row. There is **no visible
`validating` decoration** (plain text is the resting state until `commit` is
confirmed), so a reply that never arrives simply leaves the token plain — nothing gets
stuck in a half-link state. The pending-map entry is the only transient state and is
cleared when the cache is populated or on pane teardown; no explicit timeout is needed
because an unanswered request has no visible effect (a generous host-side guard may
still drop in-flight git work — D6).

## 3. Data / interface contract

### 3.1 Candidate detection (renderer — `webview/terminal-links.ts`)

A **commit-hash candidate** is a standalone lowercase-hex run:

- **Shape:** `[0-9a-f]{7,40}` — git's short-hash default (7) up to a full sha (40).
- **Word-bounded, NOT part of a longer token.** Reject when:
  - preceded by `#` → CSS color (`#abc123`, `#deadbe`).
  - preceded by `0x` / `0X` → hex literal (`0xDEADBE`).
  - preceded by another hex char, `.`, `/`, `\`, `:`, `@`, `~`, `-`, `_`, or a word
    char → it's a substring of a longer hex/alphanumeric token, a path segment, a
    URL, a scoped name, or an npm integrity hash (`sha512-…`, `…/abc123def`).
  - followed by a hex char, or by a word char / `-` / `_` / `.`<hexish> that makes it
    part of a longer token (e.g. `abc1234 z` is fine; `abc1234z`/`abc1234.5` is not a
    bare hash). A trailing `.`/`,`/`)`/`]` as sentence punctuation is allowed and
    stripped (reuse the path-link `TRAILING_JUNK` approach).
- **Case:** lowercase only. Git emits lowercase shas; restricting to `[0-9a-f]`
  drops a large class of false positives (uppercase hex ids, `DEADBEEF`, GUIDs). See
  Decisions Needed **D3**.
- **Lower bound:** 7 (git short default; matches Claude Code's printed hashes). See
  Decisions Needed **D1**.

Detection emits a `CommitToken { raw: string; start: number; end: number }`
(0-based `start`, exclusive `end`, like `PathToken`). Implemented as a sibling
matcher (e.g. `detectCommitTokens(line)`), kept **separate** from `PATH_RE` so the
path matcher is untouched; the link provider merges both token lists per line.

**Per-row scope (wrapped shas):** xterm link providers operate on a single buffer
**row**, and a full 40-char sha is far more wrap-prone than typical path tokens — a
hash split across two rows is a real case here, not a corner one. MVP detects only
shas that lie **within one row's `translateToString`** (matching how path links and
the existing provider already behave); a hash wrapped across a row boundary is simply
not linked (it stays plain — no broken/partial link). Spanning rows would require a
multi-line link provider, which is **out of MVP scope** (vision, §6). This limitation
is called out explicitly because the sha length makes wrapping common at narrow widths.

**Per-line candidate cap:** to bound a pathological line (a wall of hex), the matcher
caps emitted commit candidates per row at **N (default 32)**; beyond the cap the
remaining candidates are ignored (rendered plain). This keeps any single
`validateCommits` / `cat-file --batch-check` batch small and bounded regardless of
input. The cap is a constant (not a setting); 32 comfortably exceeds any realistic
count of real shas printed on one row.

**The regex is necessarily heuristic.** It is intentionally *loose* on "is this a
commit" and *strict* on "is this a standalone hex run not glued to other tokens."
The real gate is host validation (§3.2) — a candidate that the host can't confirm is
simply not linked.

### 3.2 Validation (new host IPC)

Add a batched validate round-trip, mirroring `resolvePathToken`:

- **Request:** `{ type: 'validateCommits'; sessionId: string; tokens: string[] }`
  — one batched request per rendered line; `tokens` are the raw candidate hex
  strings.
- **Reply (success):** `{ type: 'validateCommitsResult'; sessionId: string;
  results: Array<{ token: string; commit: string | null }> }` where `commit` is the
  resolved **full 40-char sha** when the token names a real commit in the session's
  active repo, else `null`.
- **Reply (error / unknown session / not a repo):** rejects, or replies with all
  `commit: null`; every affected token → `validate-failed` → plain. Never crashes the
  line.

**Validation rules (host — `electron/main.ts`, alongside `resolvePathTokens`):**
1. Resolve the session → its **active repo root** (the same scoping the Review tab
   uses for this session: `gitRootForSession` / multi-repo active-repo). Not a repo →
   all `null`.
2. For the candidate set, confirm each is a **commit object** (not a blob/tree/tag
   and not merely a valid-looking abbreviation). Use git's own resolver — never trust
   the renderer string into a shell — preferring a single batched process:
   `git cat-file --batch-check` over the candidates on stdin, keeping only entries
   whose type is `commit`; the resolved full oid is the line's first field. (Per-token
   `git rev-parse --verify <token>^{commit}` is the equivalent single-shot form.)
   Ambiguous short shas (git reports "ambiguous") → `null` (don't guess).
3. The string is passed to git **only** as a literal arg / stdin line after the
   renderer has shape-validated it as `[0-9a-f]{7,40}` and the host re-asserts that
   class before spawning (defense in depth — mirrors `git:switch`'s "ref is never
   trusted into execFile").
4. Cache the resolved `(root → token → commit|null)` briefly (a commit oid is
   immutable; a short-TTL cache like the file-index `FILE_INDEX_TTL_MS` is enough to
   collapse repeat validations across re-paints).

**Invariants:**
- Read-only: validation runs only `cat-file`/`rev-parse` — no write surface, strictly
  less capable than the existing `git()` reads.
- A candidate that doesn't resolve to a **commit** in this repo is never linked.
- The renderer always opens with the **host-returned full sha**, not the printed
  abbreviation (stable identity into `openReviewForCommit`).

### 3.3 Routing the click (renderer — `terminal-pane.tsx`)

The link provider gains a parallel branch to the path branch: validated commit tokens
build an xterm link whose `activate` calls a new prop ref
`onOpenCommitReviewRef.current?.(fullSha, sessionId)`. Wired in `app.tsx` next to the
existing `onOpenFile` / `onRevealFolder` props as `onOpenCommitReview = (sha,
sessionId) => openReviewForCommit(sha, sessionId)`.

### 3.4 Precedence vs. path links (must hold)

A token must never be **both** a path link and a commit link.

- **A real file/dir path wins.** Resolve path tokens first (existing flow). When a
  commit candidate's character span **overlaps** any resolved path link on the same
  line, drop the commit candidate.
- Structurally the shapes are nearly disjoint already: a bare hex run has no
  separator (so it can't match the bare-*relative* path branch, which requires a `/`)
  and no extension (so it can't match the bare-*filename* branch, which requires
  `.<ext>`). The overlap guard covers the residual case (e.g. a hash that is also a
  directory name, or a hash appearing inside a printed path — the path/precedence
  lookbehind already rejects hashes glued to a path).
- A bare hex that resolves to **no** path may be a commit → validated as such.

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| `#abc1234` (CSS color) | Not a candidate (preceded by `#`). |
| `0xDEADBEEF` (hex literal) | Not a candidate (preceded by `0x`; also uppercase). |
| Hex substring of a longer word (`abc1234def…`, `g123abc4`) | Not a candidate (hex/word char on a boundary). |
| npm integrity (`sha512-…`, `…-abc123…`) | Not a candidate (preceded by `-`/word). |
| Hash inside a path/URL (`/objects/ab/cd12…`, `https://h/abc1234`) | Path-link precedence + boundary lookbehind reject it as a commit. |
| Valid-shape hex that isn't a commit in this repo | Host returns `null` → plain text, no action. |
| Ambiguous short sha (multiple objects) | Host returns `null` (no guessing). |
| Token names a blob/tree/tag, not a commit | `cat-file` type ≠ `commit` → `null`. |
| Full 40-char sha | Linked if it's a commit; opened by its own value. |
| Commit exists in a *different* repo than the active session's | `null` here (out of scope — §1 non-goals). |
| Multi-repo: clicked pane's active repo differs from another pane's | Validation + open both use the **clicked pane's** session/active-repo. |
| Many candidates per line | One batched `validateCommits` per line; renderer cache + pending-map dedupe (as path links); paint never blocks. |
| Pathological line (wall of hex) | Candidate emission is capped at 32/row (§3.1); excess tokens render plain — batch size is bounded. |
| Full sha wrapped across two buffer rows | Not linked in MVP (per-row link provider); stays plain. Multi-row linking is vision (§6). |
| Validate reply arrives after the row re-rendered | Reply only updates the `(repoRoot, token)` cache and is re-consulted on the next `provideLinks`; never painted onto a stale row (§2 staleness). |
| Validate reply never arrives | Token stays plain (no visible `validating` state); pending entry cleared on cache fill / pane teardown — nothing stuck. |
| Validation IPC errors / unknown session / not a repo | Affected tokens render plain (`validate-failed`); error logged once; line unaffected. |
| `openReviewForCommit` unavailable (dependency not built) | Feature is blocked, not shipped half-wired (see D5). If shipped behind the dep, click is a no-op only when the entry point is absent — guard it like `window.agentDeck`. |
| Browser preview (`window.agentDeck` absent) | No commit link provider registered (same guard as path links). |
| Commit gets garbage-collected/rewritten between validate and click | `openReviewForCommit` surfaces the dependency feature's own "commit not found" handling; evict the stale cache entry. |
| Detached / pre-`git init` cwd | Not a repo → all `null` → plain text. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Min hash length | 7 | No (constant) | Git's short default; what Claude Code prints. Host validation filters false positives. |
| Hex case accepted | lowercase only | No | Git emits lowercase; cuts a large false-positive class cheaply. |
| Validation timing | on-detect (batched per line) | No | Matches the path-link pattern; avoids "underlined text that does nothing" (D11 rejected validate-on-click). |
| Link affordance | reuse `.term-path-link` (underline on hover, pointer) | No | One consistent terminal-link look; no new tokens. |
| Scope | clicked session's active repo only | No | Multi-repo correctness; cross-repo lookup is a non-goal. |
| Candidates emitted per buffer row | 32 (cap) | No (constant) | Bounds a pathological all-hex line; exceeds any realistic real-sha count per row. |
| Wrapped-sha (across rows) | not linked | No | Per-row link provider; multi-row linking deferred to vision. |

No user-facing setting is introduced; this is a strictly-better default layered on
existing terminal links.

## 6. Scope slicing

- **MVP (must):** `detectCommitTokens` (lowercase `[0-9a-f]{7,40}`, boundary-guarded)
  + `validateCommits` IPC (active-repo, `cat-file --batch-check`/`rev-parse --verify`)
  + click → `openReviewForCommit(fullSha, sessionId)` + path-precedence overlap
  guard + the `window.agentDeck`/entry-point guards. Reuses the existing link
  decoration and per-line batch/cache machinery.
- **v1 (should):** Light hover affordance hint that this opens *Review for this
  commit* (e.g. via the link's existing hover, no new tooltip surface) if usage shows
  it's non-obvious. Cache tuning if validation proves chatty.
- **Vision (could):** Linkify commit *ranges* and `HEAD~n`/reflog selectors; a
  right-click "Copy sha / Open in History / Review" menu on a commit token; linkify
  hashes against *any* open repo, not just the active one.
- **Out of scope:** Rendering the commit diff (dependency); branch/tag/ref linking;
  cross-repo resolution.

## 7. Acceptance criteria

**Declarative:**
- A printed real short sha (7/8 chars) and a real full 40-char sha each underline on
  hover and, on click, open Review scoped to that commit.
- `#rrggbb`, `0xDEAD…`, a hex substring of a longer word, and a hash inside a path
  are NOT linked.
- A valid-shape hex that isn't a commit in the active repo is plain text.
- The commit is resolved and opened against the **clicked pane's** session/active
  repo.
- Existing path-link behavior is unchanged.

**EARS:**
- *Event-driven:* When a terminal line containing a token that the host confirms is a
  commit in the clicked session's active repo is clicked, the system shall call
  `openReviewForCommit` with the full sha and that session id.
- *Unwanted:* If a hex-shaped token does not resolve to a commit object in the active
  repo, then the system shall render it as plain text with no hover underline and no
  click action.
- *Unwanted:* If a candidate is preceded by `#`, `0x`, or another hex/word/path
  character, then the system shall not treat it as a commit candidate at all.
- *State-driven:* While a candidate's validation request is in flight, the line shall
  already be painted and selectable, and the token shall gain its underline only
  after validation confirms a commit.
- *Unwanted:* If validation errors or the session is unknown, then the affected
  tokens shall render plain and the rest of the line shall be unaffected.
- *Unwanted:* If a commit candidate's span overlaps a resolved path link, then the
  path link shall win and the commit candidate shall be dropped.

**Gherkin:**
```gherkin
Scenario: Real short sha opens the commit in Review
  Given the active repo has a commit "a1b2c3d4e5...(full 40)"
  And the terminal prints "Committed as a1b2c3d"
  When I click "a1b2c3d"
  Then openReviewForCommit is called with the full 40-char sha and the pane's sessionId
  And the Review Changes tab opens scoped to that commit

Scenario: A CSS color is not a commit link
  Given the terminal prints "color: #a1b2c3;"
  Then "a1b2c3" is not underlined and clicking it does nothing

Scenario: A hex string that is not a commit does nothing
  Given "deadbeef1" is not a commit object in the active repo
  And the terminal prints "deadbeef1"
  When I hover it
  Then it shows no link underline and has no click action

Scenario: A hash inside a path stays a path link, not a commit link
  Given the project contains ".git/objects/ab/abc1234..." style output is printed as a path
  When path resolution links the path token
  Then no overlapping commit link is offered for the same span

Scenario: Multi-repo scoping
  Given pane A's active repo is repoA and pane B's is repoB
  And "abc1234" is a commit only in repoB
  When I click "abc1234" in pane B's terminal
  Then Review opens that commit using pane B's session/active repo
  And clicking the same text in pane A does nothing (not a commit in repoA)
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Commit token | candidate / not-a-commit / validate-failed | Normal terminal text | — |
| Commit token | commit | Underline on hover, pointer cursor (`.term-path-link`) | Click → open Review for commit |
| Commit token | opening | (transient) click dispatched | — |

No dropdown/menu in MVP (a sha resolves to exactly one commit; the multi-candidate
disambiguation that path links need does not apply). A right-click menu is vision
(§6).

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| Commit link token | open Review-for-commit | hover underline; click | xterm link focus/activate model (same as path links — no bespoke keyboard handling added) | tap | reuse terminal right-click (no new items in MVP) | link affordance via xterm link provider + `.term-path-link` (identical to path links) |

The token reuses the exact xterm `registerLinkProvider` affordance path links use
(`decorations: { pointerCursor, underline }`, `hover`/`leave` toggling underline), so
discoverability, focus, and activation match the established, already-accepted
terminal-link interaction. No new interactive surface is introduced.

## 10. Accessibility & i18n

- **Affordance:** The link is exposed exactly as existing terminal path links are
  (xterm link provider; pointer cursor + hover underline). Terminal text remains
  selectable; the link doesn't trap selection. There is no *new* a11y surface beyond
  what terminal path links already establish — and explicitly no regression to it.
- **Keyboard:** Inherits xterm's link activation model (same as path links); no new
  keyboard contract is added or required for MVP. If path links later gain explicit
  keyboard activation, commit links inherit it for free (shared provider).
- **Screen reader:** xterm terminal content is the same buffer; the link adds no
  hidden text. (Same limitation/behavior as the shipped path links — not regressed.)
- **Contrast / motion:** Reuses `.term-path-link` (themed underline); no new color,
  no animation. Inherits light/dark/high-contrast from existing variables.
- **i18n:** MVP introduces **no new user-facing strings** (the click just opens an
  existing tab). If v1 adds a hover/tooltip or right-click label, route it through the
  same `STR.*` constants pattern used elsewhere — no hardcoded English in new code.

## 11. Design tokens (UI)

Reuses `.term-path-link` (link underline/hover) and the existing xterm link
decoration API. **No new tokens, classes, colors, or icons.** If a right-click menu
is added (vision), reuse `webview/components/context-menu.tsx` and `webview/icons.tsx`
as the path-link dropdown already does.

## 12. Assumptions

- The `review-commit-source` feature ships `openReviewForCommit(sha, sessionId?)`
  and owns scoping Review to a commit; this feature only routes a validated full sha
  into it. (If the signature differs, adapt the single call site in §3.3.)
- The session already knows its active repo root host-side (it does — used by
  `gitRootForSession`, the git band, History, and Review scoping). Validation scopes
  to it.
- A commit oid is immutable, so a short-TTL `(root,token)→commit|null` cache is safe;
  matches the existing file-index cache approach.
- `git cat-file --batch-check` (one process per line) is the efficient batched
  validator; `rev-parse --verify <sha>^{commit}` is the per-token equivalent. Both
  exist in the git the host already shells out to via `git()`.
- Restricting candidates to lowercase hex and length ≥7 is acceptable coverage for
  the target case (Claude Code / `git` output, which are lowercase). Uppercase or
  ≥4-char ultra-short abbreviations are out (D1/D3 below).

## 13. Decisions Needed

- **D1 — Minimum hash length (`normal`).** Default **7** (git short default; matches
  Claude Code output). Alternative: 8, to shave borderline false positives. Host
  validation is the real gate either way, so 7 is the safest *coverage* default;
  flagged because it trades a few more validation candidates for completeness.
- **D2 — Validate-on-detect vs validate-on-click (`normal`).** Default
  **validate-on-detect, batched per line** (consistency with path links; D11
  explicitly rejected validate-on-click as "underlined text that does nothing").
  Risk: more `cat-file` calls than on-click. Mitigated by per-line batching + repo
  cache. Reversible — can fall back to validate-on-click if profiling shows chatter.
- **D3 — Lowercase-only hex (`normal`).** Default **lowercase `[0-9a-f]` only** (git
  emits lowercase; large FP reduction). Reversible if a tool prints uppercase shas.
- **D4 — Path-vs-commit precedence (`normal`).** Default **path wins on span
  overlap**; commit candidates are dropped when they overlap a resolved path link.
  Low-risk given the shapes are near-disjoint.
- **D5 — Dependency ordering (`high`).** This feature is **blocked on**
  `openReviewForCommit` from `review-commit-source`. Safest path: build/merge that
  first, then wire this. If built in parallel, the click handler must **guard** the
  entry point (no-op + logged-once if absent), exactly like the `window.agentDeck`
  guard — never ship a hard call to a missing function. Flagged `high` because
  shipping this without the dependency yields a dead link.

- **D6 — In-flight host work has no hard timeout (`normal`).** Default: rely on the
  "no visible effect" property (§2/§3.1 staleness) rather than a renderer-side timeout
  — an unanswered `validateCommits` just leaves tokens plain. A host-side guard
  (bounded `git` runtime / abandon long batches) is a nice-to-have, not required for
  correctness. Reversible.

## 14. Open questions

- None blocking. (Right-click "Copy sha / Open in History", commit-range linking, and
  cross-repo resolution are deferred to vision, not gating MVP.)

## 15. Acceptance — testing notes

- **Unit (pure, exhaustive):** `detectCommitTokens` — positives: standalone
  7/8/40-char lowercase hex (bare, after "Committed as ", end-of-line with trailing
  `.`/`,`/`)`); negatives: `#a1b2c3`, `0xdeadbe`, hex substring of a longer
  word/hash, `sha512-…` fragment, a hex segment inside a path/URL, uppercase
  `A1B2C3D`, 6-char (too short), 41-char (too long). Assert spans (`start`/`end`).
- **Unit:** precedence — a candidate overlapping a resolved path link is dropped.
- **Unit:** per-row cap — a line with >32 hex runs emits exactly 32 candidates.
- **Real-app e2e (required — crosses host git validation; NOT `needs-human-smoke`):**
  new `test/e2e/<name>.e2e.mjs` on the shared harness — seed a temp repo with a known
  commit, print its sha in the terminal, click it, assert the Review tab opens scoped
  to that commit (and that a bogus hex sha does nothing). Per CLAUDE.md, host/IPC
  boundary work uses `npm run test:smoke`, not human smoke.
- `npm run verify` exits 0 (both tsconfigs, lint, dead-code, tests, security).
