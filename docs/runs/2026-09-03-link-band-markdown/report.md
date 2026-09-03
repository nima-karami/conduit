# Run report — 2026-09-03 link / git-band / markdown fixes

**Status: COMPLETE.** Committed to `main` as `311db44`. Three user-reported defects, each
root-caused, fixed, and **mutation-verified** — the fix reverted, the new test observed red
with the reported symptom, then restored.

The reports, verbatim: *"opening a link in conduit gets a dangerous link warning, but clicking
ok doesn't open it"*, *"the git history and review changes icons are gone!"*, and (mid-run,
with a screenshot) *"in some cases the font style of the markdown viewer looks weird!"*

## What shipped

### 1. Terminal OSC 8 links: a scary dialog, then nothing

Two link paths exist in the terminal and only one was ours. `terminal-pane.tsx` registers a
regex `linkProvider` (URLs, paths, commit hashes), but an **OSC 8 hyperlink** — the
escape-sequence kind where a label hides the URL, which Claude Code and most modern CLIs
emit — is matched by xterm's **own built-in** provider and never reaches ours. With no
`linkHandler` on the `Terminal`, xterm fell back to its default handler, which:

1. shows `confirm("Do you want to navigate to …?\n\nWARNING: This link could potentially be
   dangerous")`, and
2. on OK calls `window.open()` **with no url** — which the host's `setWindowOpenHandler` sees
   as `about:blank`, correctly refuses (not an `EXTERNAL_SCHEME`), and denies, so `window.open`
   returns null and xterm gives up with a console warning.

Both symptoms from one cause. Fixed by giving the Terminal a `linkHandler` that routes OSC 8
activation through the same scheme-checked `openExternal` path the regex provider already used.
xterm still filters OSC 8 to http(s) itself (we do not set `allowNonHttpProtocols`), and the
host re-validates the scheme — the two checks are unchanged.

The mutation run reproduced the user's text exactly:
`FAIL ✗ no confirm() may be shown for an OSC 8 link, got: ["Do you want to navigate to
https://example.com/conduit-osc8-probe?\n\nWARNING: This link could potentially be dangerous"]`

### 2. The git band vanished when you opened a file

`showGitBand` was gated on `(!showDoc || gitScopedDoc)`, so the band — branch/dirty state,
**commit history, Review changes, Compare** — disappeared the moment any ordinary document tab
became active. Those buttons are the *only* entry points to Review and History, so opening a
file removed them with no hint that switching back to the terminal would bring them back.

Reproduced before touching anything, in the real app: terminal → `{history: true, review:
true, compare: true}`; open `package.json` → `{gitIndicator: false, history: false, review:
false, compare: false}`.

These actions are **repo-scoped, not document-scoped** — what branch you are on matters at
least as much while editing a file as while reading the terminal — so the band now rides every
surface in a session that has a repo. The `trailing` slot's width is already reserved outside
the scrollable tab strip (tabs overflow past it rather than collide), so there was no layout
reason for the restriction. Each piece keeps its own self-hide: the indicator when the setting
is off or git kind is `none`, the repo picker below 2 repos.

Worth noting the spec check that preceded the change: `2026-06-27-review-changes-entry-point`
§28 says the Review button "is **always visible** whenever the git band shows" — scoped to the
band's own visibility, which was the F1 shell rule, not that spec's. So this supersedes a shell
decision rather than contradicting the entry-point spec.

### 3. Markdown ate dollar amounts

`remark-math`'s default single-dollar text math treats any pair of `$` in a paragraph as LaTeX
delimiters. So `Published CA$170,000 to $250,000` lost **both** dollar signs and re-rendered
the span between them in KaTeX's serif math italic — which is exactly what the screenshot
showed (`CA170,000to250,000`). Same for `($1,000 to $4,000 …)` and for `$PATH` / `$HOME`.

The failure mode is the bad kind: not an error, but text that silently changes. In the
documents and agent output this viewer renders, a lone `$` is currency, a shell variable or a
template literal far more often than it is inline math — so text math now requires two
dollars. `$$…$$` still renders real math (verified in the same runtime pass: exactly one
`.katex` span, the deliberate `$$E = mc^2$$`).

The config lives in `webview/md-math.ts` rather than inline in the viewer for a concrete
reason: the unit test has to exercise the **real** configuration, and importing
`markdown-viewer.tsx` drags Monaco in, which fails under jsdom
(`document.queryCommandSupported is not a function`). A test that re-declared the option would
pass whether or not the app used it.

## Tests added

| Test | Proves |
|---|---|
| `test/unit/md-math.test.ts` | Currency, `$PATH`/`$HOME` survive; `$$…$$` still renders. Runs the viewer's own plugin config. |
| `test/e2e/terminal-osc8-link.e2e.mjs` | Writes a real OSC 8 sequence into the live xterm, clicks it **at its cell with a real mouse**, asserts the host was asked to open the right url, with no `confirm()` and no `window.open`. |
| `test/e2e/git-band-persistence.e2e.mjs` | Band + all three buttons present on the terminal *and* with an editor doc active; then clicks Review and confirms it actually opens from a doc tab. |

`harness.mjs` gains an `openExternal` spy. Unlike the other shell spies it records **without
calling through** — calling through would launch the developer's real browser on every run of
every scenario that arms it.

Two mistakes worth recording from writing these:

- The first OSC 8 attempt clicked at `0,0`: `document.querySelector('.xterm-screen')` returns a
  **hidden** pane's element (every session keeps its pane mounted so the PTY survives), which
  measures 0x0. Measure off `term.element`, and assert the rect is non-zero so a future
  regression fails loudly instead of clicking the corner of the window.
- The click also has to wait for the shell prompt first; output arriving after the row is
  measured scrolls the link out from under the cursor.

## Verification

`npm run verify` — **green, exit 0**: 250 test files, 3838 passed, 2 skipped; both tsconfigs;
audit within the gate; gitleaks no leaks.

Runtime proof for all three, driving the real app: the icons survey above, the OSC 8 click
scenario, and a markdown fixture carrying the reported text (all seven `$` amounts and shell
vars intact, one intentional `.katex`).

### Two failures correctly attributed to the machine, not the change

- `file-service-scope.test.ts` failed twice inside a full `verify` with **5 s timeouts** (the
  file took 30 s). Alone: 8/8 in 6.6 s. It shells out to real `git`; the run was concurrent
  with Electron e2e launches.
- A full-suite pass hit `editor-change-markers` failing on `git commit -qm seed`, and then
  every subsequent scenario died instantly with `EXIT(3221225794)` = `0xC0000142`
  (`STATUS_DLL_INIT_FAILED`) — the Windows resource-exhaustion cascade, not 90 real
  regressions. `editor-change-markers` passes alone in 30.9 s.

Both are the pattern CLAUDE.md already warns about ("a loaded machine fails the PTY e2es the
way a broken PTY does"). Neither was treated as a regression; neither gate was touched. No
orphan Electrons were left (the runner's own teardown is PID/profile-scoped; a sweep found 0).

### One gate failure that was real, and unrelated

The first `verify` failed on `npm audit --audit-level=high`: a **newly published** advisory
against `fast-uri` (SSRF / host confusion) that did not exist during the 2026-09-01 run, plus
`@xmldom/xmldom`. Both are dev-only transitive deps of `electron-builder`. Fixed the way the
rule requires — the code, not the check: `npm audit fix` bumped `fast-uri` 3.1.5 → 3.1.7 and
`@xmldom/xmldom` 0.8.13 → 0.8.15, a 6-line lockfile diff with `package.json` unchanged and
`node-pty` / electron / monaco untouched (checked explicitly, since node-pty is pinned exact as
a pre-release).

## Follow-up

The full 110-scenario smoke suite is the pre-push regression check for a change that alters
when chrome renders across every document surface. It runs ~55 min sequentially and must run
on a quiet machine — see the attribution note above for why a loaded run is worthless. The
targeted adjacent scenarios (`git-indicator`, `theming-light`, `chamfer-edge`,
`band-alignment`, plus the two new ones) are green.
