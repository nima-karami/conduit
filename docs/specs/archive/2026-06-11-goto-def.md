# Spec — E1 "goto-def": kill the 5–10s first-use go-to-definition latency

**Tier:** FULL · **Feature type:** UI (editor loading surface) · **Mode:** autonomous

---

## 1. Problem frame

**Job-to-be-done.** When a developer opens a fresh repo and invokes go-to-definition
(F12 / Ctrl+Click / context menu) from a usage to its declaration, they want the jump
to feel instant — or, if it can't be instant, to clearly see "working…" rather than a
frozen editor.

**The pain (observed).** On a *fresh* repo the **first** go-to-definition takes
**5–10s** to open the new tab and navigate; subsequent ones are fast.

**5-Whys diagnosis.**
1. Why slow on first use? The custom action awaits `monacoTs.getTypeScriptWorker()` →
   `worker.getDefinitionAtPosition(...)`.
2. Why is *that* slow only the first time? The TypeScript language **worker is
   cold-started lazily** on the first request, then must **parse/index** every model
   we eagerly synced (`setEagerModelSync(true)` in `monaco-setup.ts`) before it can
   resolve a definition.
3. Why does indexing cost 5–10s? `indexModels()` (app.tsx → `projectFiles`) creates a
   Monaco model **per project file**; the language service has to load the whole graph
   to answer a cross-file lookup.
4. Why is the first call the one that pays it? The worker has no warm-up trigger — the
   user's first F12 *is* the trigger, so the user waits for the cold start.
5. Why does it feel broken? There is **no loading feedback** — the editor looks frozen
   for those seconds, so the user can't tell it's working vs. hung.

**Root cause:** cold TS-worker start + first-request indexing, paid synchronously on
the user's first go-to-definition, with zero progress feedback.

**Actors.** The developer browsing code in the Monaco editor.

**Success outcomes.**
- The TS worker is **warmed proactively** (indexing starts *before* the user's first
  F12), so the first real go-to-definition is paying a warm path, not a cold start.
- Whenever a go-to-definition request is **in flight**, a clear, non-blocking
  indicator shows; it clears on success or failure.
- **No regression** to go-to-definition correctness (in-file and cross-file).
- The TS worker still **bundles** (`ts.worker.js`) and the editor still loads.

**Non-goals.**
- Replacing the custom worker-backed action with Monaco's **native** go-to-definition.
  CLAUDE.md: esbuild does not reliably bundle the native goto; `ts.worker.js` is bundled
  separately on purpose. We keep the custom action. (See Decisions Needed → D1.)
- Eliminating *all* indexing cost on giant repos. We move it off the critical path and
  make it visible; we do not rewrite the indexing strategy.
- Caching definitions across sessions / a persistent index.

## 2. Behavior & states

**Warm-up lifecycle (per worker / per session):**
`idle → warming (triggered once) → warm`
- **Trigger:** the first time project files are indexed (`projectFiles` → after
  `indexModels`), kick a warm-up: acquire the TS worker and issue one cheap request
  against a real synced model so the service begins loading. Runs **once per session**
  behind a **module-scoped** idempotent guard (survives React StrictMode double-invoked
  effects and component remounts), not on every `projectFiles` message, file open,
  mount, or keystroke.
- **Non-blocking:** warm-up is fire-and-forget; failure (no TS file yet, worker not
  ready) is swallowed and may be retried by a later trigger only if warm-up never
  successfully started.

**Go-to-definition request states (per invocation):**
`ready → resolving (in-flight) → navigated | not-found | error`
- `resolving`: show the loading indicator (busy cursor on the editor + a subtle inline
  status). Editor remains interactive (non-blocking).
- `navigated`: clear indicator; cursor reveals target (in-file) or a new tab opens and
  reveals (cross-file) — unchanged from today.
- `not-found` / `error`: clear indicator; no navigation (current silent behavior kept,
  plus the indicator is removed so it never sticks).
- **Concurrency:** if a second go-to-definition fires while one is `resolving`, the
  indicator stays shown until the **last** in-flight request settles (ref-counted /
  latest-wins), never clearing early and never leaking.

## 3. Data / interface contract

Two small **pure, unit-testable** seams, separate from Monaco integration:

- **Warm-up once-guard** — `webview/monaco-warmup.ts`
  - `shouldWarm(state): boolean` — pure: returns true only the first time (idempotent).
  - `warmTypeScriptWorker(deps)` — thin async orchestrator that, guarded by the above,
    acquires the worker via the injected `getTypeScriptWorker` and pokes one model.
    Dependencies injected so the guard/sequencing is testable without a real worker.
  - Invariant: at most **one** successful warm-up sequence per module lifetime; a
    failed attempt before any success may be retried.

- **In-flight tracker** — small ref-counted, **observable** helper exposing
  `begin()`, `end()`, `active(): boolean`, and `subscribe(fn): () => void` so the React
  indicator can re-render when the count flips. The CodeViewer subscribes in an effect,
  drives a `useState` boolean from `active()`, and unsubscribes on unmount. This is the
  reactivity contract — without `subscribe`, the indicator would never update.
  - Invariant: `active()` is true iff `begin` calls outnumber `end` calls; never goes
    negative; subscribers are notified on every transition (0↔≥1 at minimum); `end` is
    called from a **`finally`** block on every goto path (success, not-found, error,
    disposed-editor) so a throw can never skip it and leak the count.
  - **Strictly ref-counted, not latest-wins:** the indicator stays visible until *all*
    in-flight requests settle (resolves the §2 "ref-counted / latest-wins" slash in
    favor of ref-count; stale requests are awaited, not abandoned).

- **Which model to warm + request shape.** Warm-up targets the **first TS/TSX model**
  found among the synced models (`monaco.editor.getModels()` filtered to TS_LANGS), and
  issues `worker.getDefinitionAtPosition(uri, 0)` against it — the **same call the real
  goto makes**, so the warm-up exercises the identical cross-file resolution path (loads
  the import graph), not a trivial syntactic poke that would leave the expensive index
  cold. If no TS/TSX model exists yet, warm-up no-ops and may retry (see §4).

No protocol/IPC changes. No host (`window.agentDeck`) changes.

## 4. Edge cases & failure modes

- **No TS/TSX file indexed yet** (repo of only non-TS files): warm-up finds no TS model
  to poke → no-op, swallow, allow a later retry. No error surfaced.
- **Worker acquisition throws** (transient): swallow; the once-guard does *not* latch on
  failure, so a later `projectFiles`/goto can warm.
- **Warm-up still running when user hits F12:** fine — both share the now-warming worker;
  the user's request just awaits the same load. Indicator covers the wait.
- **Definition not found** (cursor on whitespace / non-symbol): clear indicator, no nav.
- **Cross-file target model not yet created:** existing fallback (`{line:1,column:1}`)
  retained; indicator still clears.
- **Rapid repeated F12 / Ctrl+Click:** ref-counted tracker keeps the indicator until the
  last settles; no fl/early-clear flicker, no stuck spinner.
- **Editor disposed mid-request** (tab closed while resolving): the request's `.then`
  guards against a disposed editor/model (already in try/catch); tracker `end()` still
  runs so global `active()` doesn't leak.
- **Very large repo:** warm-up moves the cost earlier but can't make a 10s index 0s; the
  indicator still shows on the first real goto if it lands mid-warm. Acceptable — that's
  the visible-progress fallback. Documented as a manual-confirm item.
- **Preview/browser (no host):** monaco-setup still runs; warm-up + indicator work the
  same (no host dependency). Fake-shell fallback unaffected.

## 5. Defaults vs. settings

- **Warm-up: on by default, no setting.** It's a pure latency win with negligible cost
  (one worker poke) and no downside worth a toggle. Rationale: the 80% path; exposing a
  toggle would be over-production.
- **Loading indicator: always on, no setting.** Feedback for a multi-second operation is
  baseline UX, not a preference.
- No new persisted settings. (Keeps `settings.tsx` untouched.)

## 6. Scope slicing

- **MVP:** (a) warm the TS worker once, triggered after the first `projectFiles` index;
  (b) busy/loading indicator while a goto is in flight, cleared on settle. Pure helpers
  unit-tested. No goto-correctness regression. `ts.worker.js` still bundles; editor loads.
- **v1 (this pass if clean):** ref-counted concurrency for the indicator; warm-up retry
  if first attempt failed before any success; tidy inline status styling matching the app.
- **Vision (out of scope):** persistent cross-session index; predictive pre-resolution of
  likely targets; swapping to native goto *if* a future esbuild change makes it bundle.

**Out of scope:** native go-to-definition; protocol changes; settings; indexing-strategy
rewrite.

## 7. Acceptance criteria

**Declarative**
- Warm-up fires **once** per session, after the first project-files index, before any
  manual goto is required.
- Go-to-definition still navigates correctly **in-file and cross-file** (no regression).
- A loading indicator appears while a goto is in flight and is **always** cleared on
  success, not-found, and error.
- **Latency proxy:** the warm-up uses the **same** `getDefinitionAtPosition` call as a
  real goto, so by the time the user's first manual goto fires, the import graph the
  worker needs is already (or nearly) loaded — the user does not pay a *fresh* cold
  start. Runtime proof must show warm-up firing **before** the first manual goto and the
  warm-up issuing the real resolution call (not a trivial poke). Exact 5–10s→fast wall
  time on a large fresh repo is confirmed **manually in the desktop app** (a synthetic
  HTTP-served webview can't reproduce a real multi-thousand-file index); the automated
  proof establishes ordering + call-shape + no regression.
- `npm run verify` and `npm run build` both pass; `ts.worker.js` is present in the build
  output and the editor loads at runtime.

**EARS**
- *Ubiquitous:* The system shall keep the custom `agentdeck.goToDefinition` action as the
  go-to-definition mechanism.
- *Event-driven:* When project files are indexed for the first time in a session, the
  system shall initiate exactly one TS-worker warm-up.
- *Event-driven:* When a go-to-definition request begins, the system shall display a
  non-blocking loading indicator on the editor.
- *Event-driven:* When the last in-flight go-to-definition request settles (navigated,
  not-found, or error), the system shall remove the loading indicator.
- *Unwanted-behavior:* If TS-worker warm-up throws, then the system shall swallow the
  error and shall not latch the once-guard (a later trigger may retry).
- *State-driven:* While at least one go-to-definition request is in flight, the system
  shall keep the loading indicator visible.
- *Event-driven:* When warm-up runs, the system shall issue the **same**
  `getDefinitionAtPosition` call a real go-to-definition uses, so the worker pre-loads
  the cross-file resolution path rather than only a trivial syntactic check.

**Gherkin**
```
Scenario: First go-to-definition on a fresh repo is warmed and shows progress
  Given a repo has just been opened and its files indexed
  And the TS worker warm-up has been triggered once
  When the user invokes go-to-definition from a usage
  Then a loading indicator appears while the request is in flight
  And the editor navigates to the definition (in-file or in a new tab cross-file)
  And the loading indicator is cleared once navigation completes

Scenario: Warm-up does not repeat
  Given the TS worker has already been warmed this session
  When more project files are indexed
  Then no additional warm-up is initiated

Scenario: Not-found clears the indicator
  Given the cursor is on a non-symbol position
  When the user invokes go-to-definition
  Then the indicator appears, no navigation occurs, and the indicator is cleared
```

## 8. UI module (feature type = UI)

**State catalog (indicator):** hidden (idle) · visible (≥1 request resolving) ·
cleared-on-settle. No empty/error *screen* — failures just clear the indicator silently
(matches existing silent not-found behavior).

**Interaction inventory:** indicator is **read-only / non-interactive** (no focus trap,
no tab stop, not clickable). It must not block typing, scrolling, or selection. Triggers
are the existing F12 / Ctrl+Click / context-menu — unchanged.

**Accessibility.**
- The indicator is **non-essential status**, not an alert. If implemented as a visible
  text/inline element it should carry `role="status"` / `aria-live="polite"` so screen
  readers can announce "Resolving definition…" without interrupting. A pure
  busy-**cursor** change needs no ARIA. (Assumption A2: inline status preferred for
  clarity; keep it `polite`, never `assertive`.)
- Must not steal focus from the editor; editor keeps keyboard focus throughout.
- Indicator color/contrast must meet the app's existing token contrast (reuse a theme
  token, not a raw hex — per global design-variable rule).

**i18n.** Any user-visible string ("Go to definition…" / "Resolving…") is a single
short label. The app today is English-only with literal strings throughout
(`viewer__banner` etc.), so a hardcoded English literal is consistent with the codebase
(Assumption A3). No new i18n framework introduced.

**Design tokens.** Reuse existing CSS variables / theme tokens for the indicator's
color and spacing; no raw hex. Style to match the `.viewer__banner` / app menu vibe.

## Decisions Needed

- **D1 — Native vs. custom go-to-definition. (severity: normal)** Spec keeps the
  **custom** worker-backed action and solves latency via warm-up + feedback. CLAUDE.md
  and the wishlist note both say native goto does not reliably bundle under esbuild.
  Decision: do **not** switch to native. Conservative/reversible: the custom action is
  the known-good path; warming it is strictly additive. *If* an implementation-time
  experiment proves native bundles cleanly (build + runtime), that could be revisited —
  but the default is to keep custom. Continue.
- **D2 — Indicator form. (severity: normal)** Default: a **busy cursor on the editor +
  a subtle inline status** (`role="status"`, polite), cleared on settle, rather than a
  global toast (no toast system is evident in the webview). Reversible. Continue.
- **D3 — Warm-up trigger point. (severity: normal)** Default: trigger after the **first
  `projectFiles` index** in `app.tsx` (the moment models exist to index), guarded once
  per session — not on editor mount (which can happen before files are indexed) and not
  per file. Reversible. Continue.

## Self-audit

Template/checklist coverage walked: problem frame ✓ · behavior & states ✓ · data/interface
contract ✓ · edge cases & failure modes ✓ · defaults vs settings ✓ · scope slicing ✓ ·
acceptance (declarative + EARS + Gherkin) ✓ · UI state catalog ✓ · interaction inventory ✓ ·
accessibility ✓ · i18n ✓ · design tokens ✓ · decisions-needed (severity-tagged) ✓. No
unaddressed items.
