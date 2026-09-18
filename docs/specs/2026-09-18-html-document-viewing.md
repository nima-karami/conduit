---
status: active
date: 2026-09-18
---

# Feature Spec: Viewing HTML documents in Conduit

**Tier:** FULL   **Feature type:** UI
**Mode:** autonomous — no human in the loop. Every would-be question is an assumption (§12) or a
severity-tagged item (§13); nothing blocks.

**One-line request (verbatim):** *"I want to make sure that I have the option to open HTML files
inside Conduit. Right now I can open them in the code editor in Conduit but I don't have the
option to view them. I need the option to view them, the same way that we have the option to view
Markdown files. … We have browser capability so we can easily do that or we can use HTML viewer
mode or something. I should have the option of right-clicking on the HTML file and opening it in
whatever, or whatever approach I see fit. There is a whole variety of places that we should be
able to access this."*

> **Revision 2 (same day).** An independent review of revision 1 found two blockers and eight
> high findings. Folded in here: the previewed page's **network policy** (rev 1 left it undecided
> while enabling scripts — the guest could have exfiltrated to any host); a **host precheck**,
> because a `protocol.handle` error status is invisible to a `<webview>` and rev 1's error states
> had no detection path; **`registerSchemesAsPrivileged`**, without which relative resolution —
> the whole justification for the URL shape — does not work; a **guest context menu**, because
> Electron guests have none by default and right-click would have done nothing in a document you
> opened to read; a **keyboard-escape path** out of the guest (rev 1 was a WCAG 2.1.2 trap); and
> **find-in-page**, promoted to v1 as day-one parity with Markdown. Two rev-1 invariants were
> unsatisfiable as written and are corrected (INV-1, INV-3). One review finding was checked and
> **rejected** — see §12.9.
>
> **Revision 3 (same day).** An architecture review of the *plan* — run against the Electron 43
> typings, once the URL shape was concrete enough to attack — found a second security defect and
> one dead state. The URL shape used the **volume** as its host, making an entire drive one web
> origin, so any previewed page could have read any file in any open workspace root. It is now an
> **opaque per-root token**: one origin per root (§3, INV-2). Separately, routing a preview guest's
> external opens to `shell.openExternal` passed the **full URL including its query string** — a
> one-line exfiltration channel — so those opens are now gated like a blocked resource. The
> per-tab network-allow flag was unimplementable as written (one process-global session, one
> request listener, and Conduit is multi-window), so it is keyed on the guest's `webContentsId`
> and routed to a single window. And the `crashed` state could never have rendered: `WebviewTag`
> has no such event in Electron 43, only `render-process-gone`. Full disposition in the run report.

---

## 1. Problem frame

- **Job.** *When an HTML file lands in my project — an agent's report, a coverage summary, a
  design mock, a saved artifact — I want to read it as the page it is, without leaving Conduit or
  losing the tab, so I can act on what it says.*
- **Actors.** The single desktop user. Second actor by proxy: an **agent** writing HTML into the
  workspace that the user then opens.
- **Success outcomes (observable).**
  1. Opening an `.html`/`.htm` file shows the **rendered page**, with its own CSS, images and
     scripts working, inside the editor pane.
  2. A one-click toggle flips that tab between **rendered** and **source**, as Markdown does (M2).
  3. The rendered view is reachable from the Explorer, the tab menu, the palette, a Markdown link,
     and the keyboard — not one buried affordance.
  4. Nothing outside the opened workspace roots can be read through the new render path, and the
     page cannot reach the network without the user saying so.
- **Non-goals.** Editing *in the rendered view*; a local web server; treating `.vue`/`.svelte` as
  documents (`src/lang.ts:19-22` maps both to `language === 'html'`); print/export-to-PDF; a
  Markdown-style outline/TOC for HTML (it would need heading extraction from inside the guest —
  a different mechanism, not a missing checkbox); changing how `http(s)` browser tabs behave.

---

## 2. Behavior & states

### Primary flow

1. The user single-clicks `report.html` in the Explorer (or any §9 entry point).
2. The host is asked whether the file *can* be previewed. It can, so a preview tab opens and the
   pane renders the page with a control row: `View source` · `Reload` · `Find` · `Open externally`.
3. Relative `./assets/style.css`, `./assets/app.js`, `<img src="./logo.png">` resolve and apply,
   because the page is served from a URL whose path mirrors its location on disk.
4. The page asks for `https://cdn.jsdelivr.net/…`. That request is **blocked**, and a bar offers
   *"This page wants to load resources from cdn.jsdelivr.net — Allow"*.
5. `View source` swaps the body to Monaco and offers `View rendered`.
6. An agent rewrites the file; the preview reloads in place, keeping its scroll position.

### States / transitions

`closed → checking → rendered ⇄ source`, plus `rendered → reloading → rendered`, and the failure
branches `blocked-path`, `not-found`, `too-large`, `unreadable`, `crashed`, `attach-refused`.
Full catalog in §8.

### Current behavior

Measured 2026-09-18 by driving the **real built app** under Playwright-Electron
(`test/e2e/harness.mjs`), fixture repo in a temp dir, Explorer click → observed DOM. The probes
were throwaways in the scratchpad, not repo artifacts; their records are reproduced verbatim in
`docs/runs/2026-09-18-html-viewer/report.md`.

| Claim about today's behavior | How it was measured | Verdict |
|---|---|---|
| Opening `report.html` mounts **Monaco only** — no viewer controls, no rendered surface, no `<webview>`, and the panel does not get the `.docpage` document treatment | probe **M1**: `{monaco:true, viewerControls:false, viewerToggleLabels:[], webviewFrame:false, docpageClass:false}` | **Measured** |
| Opening `readme.md` mounts the **rendered** view — no Monaco, a `.viewer__controls` row, `.docpage` applied, `<h1>` present. Its controls row showed one button, `View source`; with a TOC available an `Outline` button also renders (`markdown-viewer.tsx:939-947`), so "one button" is this fixture, not the general case | probe **M2**: `{monaco:false, viewerControls:true, controlLabels:["View source"], docpageClass:true, renderedHeading:"Markdown heading"}` | **Measured** |
| The editor-tab menu for an `.html` tab ends `… Copy path · Copy name · Reveal in Explorer · Open in browser` — the HTML affordance exists but sits **last**, after Reveal | probe **M3**, menu text scraped from the live DOM | **Measured** |
| The in-app browser **silently refuses** a `file://` URL: the modal stays open, zero `<webview>`s mount, no error is shown | probe **M4**: `{modalStillOpen:true, webviewFrames:0}` | **Measured** |
| A test harness **can** observe the DOM inside a `<webview>` guest — computed style, script side effects, `document.title` — from the main process via `webContents.getAllWebContents()` → `executeJavaScript` | **spike**, real app, existing http web-view path: returned `{heading:'inside the guest', color:'rgb(102, 51, 153)', scripted:'yes', flag:true}` | **Measured** |
| An Electron `<webview>` guest shows **no** context menu unless the host handles `context-menu` on its webContents, and the repo handles it nowhere | source read (zero hits in `electron/main.ts`, `web-view.tsx`) + Electron's documented default | **ASSUMED** — §13 |
| `file://` is refused at three layers — `normalizeUrl` (`web-url.ts:30`), `hardenWebviewPrefs` → `will-attach-webview` (`webview-guard.ts:43`, `main.ts:984`), the guest `will-navigate` guard (`main.ts:3507-3509`) | source read + M4 confirms the outcome; **which** layer fires first was not isolated | **Measured (outcome) / ASSUMED (attribution)** — §13 |
| The renderer CSP is `default-src 'none'` with **no `frame-src`** (`esbuild.mjs:70`), so an `<iframe>`/`srcdoc` path is blocked as shipped | source read only | **ASSUMED** — §13 |

---

## 3. Data / interface contract

### The render transport

The rendered view is an Electron **`<webview>` guest** on a new privileged scheme,
**`conduit-preview:`**. Rejected alternatives: *`file://` in the webview* would delete the
http(s)-only invariant `src/webview-guard.ts` exists to state and put confinement in the renderer,
the wrong side of the trust boundary; *sanitized inline HTML* (the Markdown `rehype-raw` →
`rehype-sanitize` pipeline) strips the scripts, cannot resolve relative assets, and has no
`frame-src` to live in anyway.

**Scheme registration is mandatory and ordered.** `protocol.registerSchemesAsPrivileged([{scheme:
'conduit-preview', privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true,
corsEnabled: false}}])` runs at **module scope, before `app.ready`**. Without `standard: true` the
URL is not hierarchical, **relative resolution does not work**, and the origin is opaque — which
`hardenWebviewPrefs`' forced `webSecurity = true` (`webview-guard.ts:42`) would then use to block
every subresource. The whole URL shape below depends on this.

**URL shape (revision 3 — SECURITY).** `conduit-preview://<rootToken>/<path-below-that-root>`,
where `rootToken` is an **opaque per-run token identifying exactly one workspace root** (8–32 chars
of `[a-z0-9]`; the `token → root` table lives in the main process and is minted fresh each run).
The path below the token mirrors the on-disk path, so **relative resolution is the browser's own**
and no `<base>` is needed.

| On disk | URL |
|---|---|
| `<rootA>\docs\report.html` | `conduit-preview://k3f9x2qd/docs/report.html` |
| `<rootB>\docs\report.html` | `conduit-preview://p7m1z8ab/docs/report.html` |

**Revision 2 used the volume as the host** (`conduit-preview://g/awby/proj-a/report.html`). An
architecture review found that this makes an entire drive **one web origin**: a previewed page
could `fetch('conduit-preview://g/other-project/.env')`, be same-origin, pass the root check, and
read it. Every file in every open root would have been readable by any previewed page — including
a page an agent wrote, which §1 names as an actor. One token per root means **one origin per
root**, so the browser refuses a cross-root read before the handler is ever consulted. Within a
single root a page can read that root's files, which is correct — it is the project you opened.

The token shape also deletes the drive/UNC/posix branching entirely, because the module never sees
an absolute path. That is why INV-2 and INV-3 below are **retired rather than corrected**.

### The host precheck — why an error status is not enough

A `<webview>` fires `did-fail-load` for **network-level** failure, not for a response carrying an
error status; a `404` body just renders as a page, and the host never learns the code. So every
failure state in §8 needs a signal that exists before `src` is set:

```
html:canPreview(path)  →  { ok: true }
                       |  { ok: false; reason: 'blocked' | 'too-large' | 'missing'
                                             | 'unsupported' | 'unreadable'; detail?: string }
```

The viewer calls it, renders the matching §8 state on `ok: false`, and only sets `src` on
`ok: true`. The protocol handler **still** returns `404`/`413`/`500` — that is defence in depth
for sub-resources, which have no precheck.

### Network policy

The preview partition's session installs a request filter. **Default: every non-`conduit-preview:`
request is blocked.** A blocked request raises a dismissible bar naming the host, with `Allow`,
which lifts the block **for that tab only, for that session** — the same
block-then-offer shape the Markdown viewer already uses for remote images
(`markdown-viewer.tsx:197-211`). Remote *navigation* is always denied in-guest and routed to the
system browser instead, because the viewer deliberately has no address bar: silently replacing a
local document with a live remote page in a chrome-less pane is the worst outcome available.

- **Inputs.** An absolute file path from the renderer. Trust boundary: the renderer is Conduit's
  own but is treated as untrusted for path confinement, per the `md:image` precedent
  (`electron/main.ts:2117-2126`).
- **Outputs.** The file's bytes, `Content-Type` by extension, `X-Content-Type-Options: nosniff`.
- **Error shapes.** `404` outside-roots / missing / directory / unmapped volume; `413` over cap;
  `500` read error. Plus the precheck's typed `reason`.
- **Invariants.**
  - **INV-1.** The handler serves a path only when **both** `isInsideAnyRoot(abs, roots())` **and**
    `isInsideAnyRoot(realPathLeaf(abs), roots())` hold. `isInsideAnyRoot` alone is purely lexical
    (`src/path-guard.ts:42` → `:29-40`): it catches `../..` but **not** a symlink escape, which is
    what `realPathLeaf` (`src/path-guard.ts:53`) exists for. Both, as `fs-dnd`/`fs-import` do —
    one notch stronger than `md:image`'s single check. Enforced in the **main process**; the
    renderer cannot widen it.
  - **INV-2 (revision 3).** One workspace root ⇄ one token ⇄ one web origin. A token resolves
    through the host's table or the request is refused; the renderer never mints or resolves one.
    This is the invariant that makes a cross-root read the **browser's** problem rather than ours.
    *Supersedes* rev 2's platform-explicit path⇄URL rule, which no longer has a subject — the
    module never sees an absolute path, so the `process.platform` hazard went with it.
  - **INV-3 (revision 3).** Traversal is refused **at the parse boundary**, and the parse is
    hand-written rather than `new URL`. Measured: the WHATWG parser collapses dot segments before
    anything can inspect them — `.../a/../b`, `.../a/%2e%2e/b` and `.../a/%2E%2E/b` all yield
    pathname `/b` — so a traversal check built on `URL` would be decorative. *Supersedes* rev 2's
    canonical-round-trip rule, retired along with the path⇄URL mapping.
  - **INV-4.** The preview guest runs in its own **in-memory** partition, never `persist:webview`.
  - **INV-5.** HTML document-ness is decided by **extension** (`/\.html?$/i`), never by
    `language === 'html'`.
  - **INV-6.** The path⇄URL module is imported by the **renderer**, whose esbuild bundle is
    `platform: 'browser'` with no node shims (`esbuild.mjs:29-37`). It therefore uses **no node
    builtins** — plain string logic only. Measured: every current renderer import of a
    node-touching `src/` module is `import type` only, and `out/webview.js` contains zero
    occurrences of `node:path`/`node:fs`.

### Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `conduit-preview://` bytes | the session protocol handler (main) | the preview guest | **Yes** |
| Scheme registration | module-scope `registerSchemesAsPrivileged` | Chromium's URL parser + the handler + `webSecurity` | **Yes** |
| Preview URL string | `src/preview-url.ts` (pure, new) | the viewer, the guard, the handler | **Yes** |
| Precheck verdict | host `html:canPreview` | the viewer's state selection | **Yes** |
| Blocked-request event | the preview session's request filter | the viewer's allow-bar | **Yes** |
| Webview attach verdict | `hardenWebviewPrefs` | `will-attach-webview` (`main.ts:979-985`) — its only caller | **Yes** |
| Guest navigation verdict | app-level `will-navigate` (`main.ts:3507-3509`) | every guest, **incl. existing browser tabs** | **Yes** — which is why the guard becomes *session-aware* rather than globally widened |
| Guest context menu | new host `context-menu` handler on preview guests | the user's right-click | **Yes** |
| Doc render decision | `doc-view.tsx:92-95` | the doc pane | **Yes** |
| `isHtmlFile` predicate | was `webview/app.tsx:161` (local) | tab menu `app.tsx:1844-1852`, palette `app.tsx:2544-2553` | **Yes** — the local copy is **deleted** and both callers repointed |
| HTML view mode + reload nonce | a new renderer store | viewer, tab menu, palette, shortcut | **Yes** |
| Open-file change notification | `open-file-watcher.ts` → `fileChanged` → `app.tsx:314-317` | **new consumer:** the viewer's reload | **Consumer only** — the producer is unchanged and needs no new guarantee. Measured: an open `file` doc is already watched and already re-read on change. **Its limit is a scoped-out flow, not an oversight:** `watchFiles` carries only open *doc* paths (`app.tsx:961-970`), so a rewritten `./assets/style.css` produces no event — see §4 and §13 |
| `htmlDefaultView` | `settings-modal.tsx` → `coerceSettings` → userData settings file | `doc-view.tsx` → the viewer's fallback | **Yes** |
| `toggleHtmlView` shortcut action | `webview/shortcuts.ts` registry | the settings keymap UI + the window key handler | **Yes** |

---

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| **Concurrency** — rewritten mid-render, two reloads race | Debounced (the watcher's 150 ms); last write wins; an in-flight reload is superseded, never queued twice |
| **Zero / one / many** — empty, 1-byte, 40 MB | Empty → the empty-document state, not a blank pane. Over cap → precheck `too-large` before any load |
| **Many tabs** | **Only the active HTML doc's guest is mounted.** Unlike `web` docs, which stay warm by design (`center-pane.tsx:309-318`), a preview guest is a whole OS process per tab; keeping ten warm to read one is not a trade worth making |
| **Limits** — `MAX_BYTES` is 2 MB for text (`file-service.ts:17`) | The preview does not go through `readFile`, so that cap does not apply; the handler has its own **8 MB** document cap. Sub-resources are uncapped but root-confined |
| **Partial failure** — one `<img>` 404s | The page renders; the browser's own broken-image affordance shows. Never fail the whole view for a sub-resource |
| **Remote sub-resource** (CDN script, web font) | **Blocked by default**, allow-bar naming the host; `Allow` lifts it for that tab only |
| **Remote navigation** from inside the page | Denied in-guest, opened in the system browser. The preview never becomes a browser |
| **`target="_blank"` to a sibling local page** | Opened in the preview itself. The app-wide popup handler routes to `openExternalUrl`, whose allowlist is http/https/mailto/tel/sms/facetime (`main.ts:857-867`) — a `conduit-preview:` popup would hit it and **die silently**, so preview guests get their own window-open handler |
| **Sub-resource changed on disk** | **Not auto-detected** (see §3). `Reload` is the escape hatch and is a first-class control, not buried in a menu |
| **Stale / conflicting** — deleted while open | Read failure → `not-found` with `Close tab` + `Reveal in Explorer`; the tab is not auto-closed, matching a deleted source file today |
| **Unsaved edits in the source half** | The preview renders **disk**, not the buffer. While the buffer is dirty the preview shows a notice with `Save and reload`. Auto-reload never clobbers a dirty buffer — the existing protection at `app.tsx:314-317` still governs the source side |
| **Outside roots** — symlink or `../..` escape | `404` (INV-1 catches both halves). The document itself is refused the same way → the source view with a one-line notice |
| **UNC path** | Preview unavailable; the rendered toggle **disabled with a tooltip**; `Open externally` stays enabled |
| **Guest crash** | The `crashed` state with `Reload`. The host window is untouched — half the point of a guest over an iframe |
| **Infinite-loop script** | Hangs its **own** process. `Reload` and `View source` stay operable; they live in Conduit's chrome, outside the guest |
| **Permission denied (EACCES)** | Precheck `unreadable` with the OS reason; source view offered |
| **Keyboard focus inside the guest** | `Escape` returns focus to the viewer chrome (§10). Without it, Tab into the guest is a one-way trip — WCAG 2.1.2 |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| What an `.html` file opens as | **Rendered preview** | Yes — `htmlDefaultView: 'preview' \| 'source'` | Literal parity with Markdown (M2), which is what was asked for. A setting exists because, unlike `.md`, HTML is often source being edited — a durable per-user divergence, exactly the bar for a setting |
| Page scripts | **Run** | No | A preview that cannot run the page's own JS renders a broken document. Confinement is the partition + roots + no-node + the network block, not script-blocking |
| Network access from the page | **Blocked, with a per-tab allow** | No (the per-tab allow is the control) | Scripts + unrestricted network = a local page that read your disk can post it anywhere. Blocking outright would break the CDN-using reports that motivate the feature, so it is block-then-offer — the shape the Markdown remote-image gate already established |
| Remote navigation from the page | Always to the system browser | No | There is no address bar; an in-place remote load would be unescapable |
| Guests kept warm | Active tab only | No | One OS process per preview; see §4 |
| Preview partition | in-memory `conduit-preview` | No | INV-4 |
| Reload on disk change | **On** | No | The agent-writes-a-report loop is the motivating case |
| Scroll across reload | **Preserved** | No | Auto-reload while reading is the common case; losing your place each time makes it worse than no reload |
| `.vue` / `.svelte` | source, unchanged | No | INV-5 |
| Toggle persistence | per-doc, ephemeral | No | Mirrors Markdown's ephemeral state. The durable preference is the *default*, owned by the setting |

---

## 6. Scope slicing

- **MVP (must).** The scheme (registration **and** handler), `src/preview-url.ts`, the precheck,
  the network block + allow-bar, the widened session-aware guard, `isHtmlDocPath`, the viewer with
  `View source`/`View rendered`/`Reload`/`Open externally`, the `doc-view` branch, the
  `htmlDefaultView` setting, reload-on-change with scroll preservation, and the §8 states.
- **v1 (should).** Find-in-page (guest `findInPage`, reusing the `MdFindBar` shape) — day-one
  parity with Markdown for the stated job of reading a report; the guest context menu; the
  `Escape` focus path; Explorer rows (`Open preview`, `Open source`); the tab-menu rows and the
  `Open in browser` → `Open externally` relabel; palette commands; the `Mod+Shift+H` binding;
  `Back` after an in-page navigation; ADR 0005.
- **Vision (could).** Zoom; print/export; HTML diff preview; watching sub-resources; opening an
  HTML file into the existing `web` tab with full browser chrome.
- **Out of scope.** Everything in §1 Non-goals.

---

## 7. Acceptance criteria

### EARS

- **Ubiquitous.** The system shall serve a `conduit-preview:` URL only when the resolved path and
  its real (symlink-followed) path both lie inside an opened workspace root.
- **Ubiquitous.** The system shall register `conduit-preview` as a standard, secure scheme before
  the app is ready.
- **Ubiquitous.** The system shall derive a preview URL's volume form from the path's shape, not
  from the host platform, and shall use no node builtins to do it.
- **Event.** When a file whose extension is `.html`/`.htm` is opened, the system shall ask the host
  whether it can be previewed, and shall render it per `htmlDefaultView` only when the answer is
  yes.
- **Event.** When the previewed file changes on disk, the system shall reload the rendered view and
  restore its previous scroll position.
- **Event.** When `View source` is activated, the system shall show the Monaco source view and
  offer `View rendered`.
- **Event.** When the page requests a resource from another origin, the system shall block it and
  offer a per-tab allow naming the host.
- **Event.** When the page attempts to navigate to an `http(s)` URL, the system shall open it in
  the system browser and leave the preview where it is.
- **Event.** When `Escape` is pressed inside the guest, the system shall return focus to the viewer
  chrome.
- **State.** While the source buffer has unsaved changes, the system shall say the preview is
  showing the saved file and offer `Save and reload`.
- **Unwanted.** If the precheck reports `blocked`, `missing`, `too-large` or `unreadable`, then the
  system shall show that state with its cause and shall not set a guest `src`.
- **Unwanted.** If the guest process terminates, then the system shall show the crashed state with
  a reload affordance and shall not reload the host window.
- **Unwanted.** If the path cannot be expressed as a preview URL, then the system shall disable the
  rendered view with an explanatory tooltip and keep `Open externally` enabled.
- **Optional.** Where `htmlDefaultView` is `source`, the system shall open `.html` files in Monaco
  and still offer `View rendered`.

### Gherkin

```gherkin
Feature: Viewing HTML documents

  Background:
    Given a workspace containing report.html which links ./assets/style.css and ./assets/app.js

  Scenario: An HTML file opens rendered, with its own assets applied
    When the user opens report.html from the Explorer
    Then the pane shows the rendered page and not the code editor
    And inside the guest the heading's computed colour is the one ./assets/style.css sets
    And inside the guest the marker ./assets/app.js writes is present

  Scenario: Toggling to source and back
    Given report.html is open in the rendered view
    When the user activates "View source"
    Then the pane shows the HTML source in the code editor
    When the user activates "View rendered"
    Then the pane shows the rendered page again

  Scenario: The preview follows the file
    Given report.html is open in the rendered view and scrolled down
    When an agent rewrites report.html on disk
    Then inside the guest the document text is the new content
    And the scroll position is restored

  Scenario: The page cannot reach the network unasked
    Given a page whose script fetches https://example.invalid/beacon
    When the page loads
    Then that request is blocked
    And a bar offers to allow resources from example.invalid

  Scenario: Confinement
    Given a page that requests a path outside every opened root
    When the page loads
    Then that request fails
    And the rest of the page still renders

  Scenario: An HTML file outside every workspace root
    When the user opens an HTML file that lies outside all opened roots
    Then the pane shows the source view with a notice that the preview is unavailable
    And "Open externally" remains available
```

### Declarative

- The `.docpage` document treatment applies to a rendered HTML tab, as to Markdown (M1: it does
  not today).
- `.vue` and `.svelte` are unaffected — still Monaco, no preview toggle.
- Clicking a link to an `.html` file from a rendered Markdown doc opens it in the preview.
- **`test/unit/webview-guard.test.ts` asserts the new allowlist explicitly**: `conduit-preview:`
  allowed, `file:`/`data:`/`javascript:` still refused, hardened prefs unchanged. "Still passes"
  would be vacuous — the test must be re-pinned to the widened rule.
- **`test/e2e/context-menu-order.e2e.mjs` asserts the new expected item order** for an HTML tab,
  including where the view toggle and `Open externally` sit. It pins literal order, so it must be
  edited; "still passes" after editing its own expectation asserts nothing.
- `test/e2e/web-view.e2e.mjs` is unedited and still passes — the `http(s)` browser tab is
  genuinely untouched, and that is the point of making the nav guard session-aware.

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| HTML pane | **Ideal / populated** | The rendered page, full bleed; a thin control row | `View source` · `Reload` · `Find` · `Open externally` |
| HTML pane | **Loading** | Chrome renders immediately; a skeleton where the page will paint. No spinner-on-blank | — |
| HTML pane | **Partial** | The page paints while a sub-resource loads — the browser's own progressive render | — |
| HTML pane | **Empty document** | "This file is empty." | `View source` |
| HTML pane | **Degraded (network blocked)** | The page renders; a bar: "This page wants to load resources from `<host>`." Not colour-only | `Allow` · `Dismiss` |
| HTML pane | **Dirty buffer** | A notice: "Showing the saved file — you have unsaved changes." | `Save and reload` · `View source` |
| HTML pane | **Error (component)** | "This page didn't load." + reason + path, reusing `.webview__error` | `Reload` · `View source` |
| HTML pane | **Error (page-level)** | The guest could not attach at all (guard refusal / scheme unregistered): "Preview is unavailable in this build." + how to report | `View source` · `Open externally` |
| HTML pane | **Blocked path** | Source view + "Preview is only available for files inside an opened folder." | `Open externally` |
| HTML pane | **Not-found** | "This file no longer exists." | `Close tab` · `Reveal in Explorer` |
| HTML pane | **Too large** | "This page is too large to preview (8.4 MB)." | `View source` · `Open externally` |
| HTML pane | **Unreadable** (EACCES) | "This file can't be read." + the OS reason | `View source` |
| HTML pane | **Crashed** | "The preview stopped responding." | `Reload` |
| HTML pane | **Unsupported location** (UNC) | Source view; rendered toggle **disabled** with a tooltip | `Open externally` |
| Source view | **Ideal / dirty / saving / failed-save** | Monaco with the HTML source; the app's existing dirty dot, save flow and failure banner apply unchanged — the source half **is** the existing editor | `View rendered` |
| Toggle control | rest / hover / focus / disabled | Per the interaction-state vocabulary (`quiet` role) | — |
| Settings control | populated / focused | A `SelectField` in Settings → Editor: "HTML files open as — Rendered page / Source" | — |
| First-run · empty-after-action · permission-denied (feature-level) | — | None exist: a doc tab only opens because a file was chosen, nothing clears it to an empty state, and a local single-user app has no per-feature permission grant. Per-file EACCES is the `unreadable` row above | — |

---

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard / shortcuts | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| `View source` / `View rendered` | flip the view | click | Tab + Enter/Space; **`Mod+Shift+H`**, a bindable `SHORTCUT_ACTIONS` entry | tap | — | `<button>`, `aria-pressed`, `aria-label` |
| `Reload` | re-fetch | click | Tab + Enter/Space | tap | — | `<button aria-label="Reload preview">` |
| `Find` | in-page find via the guest | click | `Mod+F` while the pane is focused; `Enter`/`Shift+Enter` step; `Escape` closes | tap | — | Reuses `MdFindBar`'s roles |
| `Open externally` | OS default app for `.html` | click | Tab + Enter/Space | tap | — | `<button>` |
| `Back` (after an in-page navigation) | guest `goBack()` | click | Tab + Enter/Space | tap | — | `<button>`, `disabled` with no history |
| Allow-bar | allow this tab's remote resources | click | Tab + Enter/Space; `Escape` dismisses | tap | — | `role="status"`, buttons named with the host |
| Rendered page body | read, select, follow links | click / select / **right-click** | the guest's own, plus `Escape` → focus the chrome | the guest's own | **Conduit's own menu, host-installed.** Guests have no default menu, so without this right-click does nothing. Content-menu idiom (not the object taxonomy): `Copy` · `Select all` — `Copy link address` · `Open link externally` — `Find…` — `Reload` · `View source` | menu / menuitem |
| Explorer row (`.html`) | open / preview / source / externally | right-click | Shift+F10, arrows, Enter | long-press | group 1, sentence case: `Open` · `Open preview` · `Open source` · `Open externally` · `Open with…`. `Open source` exists because the default is preview — without it there is no menu route to the editor | menu / menuitem |
| Editor tab (`.html`) | as above + close family | right-click | Shift+F10 | long-press | The view toggle and `Open externally` sit **where `Open in browser` already sits** (trailing). The close-family-first order the context-menu spec freezes for tabs is left alone — no new group is inserted | menu / menuitem |
| Command palette | `Toggle rendered view` · `Reload preview` · `Open externally` — **always listed**, disabled with a reason when the active doc is not HTML (discoverable beats hidden, per the menu spec) | click | palette-native | — | — | palette-native |
| Markdown link to an `.html` | opens it in the preview | click | Enter | tap | — | link |

**Non-drag pathways.** No drag interaction is introduced, so WCAG 2.5.7 needs no alternative;
every action has a menu row, a palette row, and a focusable control.

---

## 10. Accessibility & i18n (UI)

**Accessibility.**

- Every chrome control is a real `<button>`, in the tab order, Enter/Space activated, with the
  visible focus ring from the existing `quiet`-role ladder
  (`docs/specs/2026-08-01-interaction-state-vocabulary.md`). No outline is removed.
- Icon-only controls carry `aria-label`; the toggle carries `aria-pressed` so its state is
  announced, not merely drawn.
- **Live region.** "Showing rendered page" / "Showing HTML source" / "Preview reloaded" /
  "Blocked a request to `<host>`" announce politely on the app's existing live region.
- **Escaping the guest — a named mechanism, not an assertion.** Key events inside a guest go to
  the guest's webContents; the host sees them only via `before-input-event` on that guest. The
  host registers one, and on `Escape` tells the renderer to focus the viewer chrome. Without this
  the preview is a keyboard trap (WCAG 2.1.2) — Tab in, never out.
- Error, blocked, degraded, not-found and too-large states are **text**, never colour alone; each
  names a cause and a next action.
- `prefers-reduced-motion` — the view swap is a discrete replace with no transition. No new
  animation is introduced.
- **Focus management.** Toggling keeps focus on the toggle (it stays mounted; its label changes),
  so a keyboard user is never dumped to the top of the pane.
- Contrast comes from the existing token roles (§11), which already meet 4.5:1 in all three themes.
- **Forced colors** — the chrome is app-owned and inherits the app's handling; the guest page
  renders as its author wrote it, which is correct for a fidelity preview.

**i18n.** Conduit ships **English-only with no i18n layer** — there is no catalogue to add keys to.
The obligations accepted here are concrete rather than aspirational:

- All new copy lives in one `HTML_VIEWER_STRINGS` object in the viewer module, not inlined at each
  JSX site, so a future catalogue has one place to swallow.
- Sizes are formatted with `Intl.NumberFormat`. **Not** `src/plural.ts` — it is
  `plural(n, singular, pluralForm?)` and would render "8 MBs". Units do not pluralize; the wrong
  helper is worse than none.
- The chrome uses flex with `min-width: 0` so ~30–40% text expansion wraps rather than clips; no
  fixed-width label boxes. Host names in the allow-bar truncate with a `title`, never mid-word.
- **RTL:** not supported app-wide and not introduced here. The chrome uses logical properties so
  it mirrors for free if the app ever flips. The **guest never mirrors** — a document renders in
  its own direction.
- No user-visible sorting is introduced, so collation does not arise.

---

## 11. Design tokens (UI)

Semantic roles only — no hex, per the project's design-variable rule.

- Chrome surface: the `.viewer__controls` component Markdown already uses, restyled by nothing.
- Control roles: `quiet` for `Reload`/`Back`/`Find`, `quiet` + `aria-pressed` for the toggle — the
  existing ladder, so hover/press/focus/disabled come for free and no new state values appear.
- Allow-bar and dirty-notice: the existing notice roles (`.viewer__notice`), with the allow-bar's
  action on the same `quiet` role. No new colour role is introduced.
- **The one genuinely new visual problem, named rather than deferred:** the seam between
  `.docpage` (`styles.css:3482`, `background: var(--panel)`) and a guest page that declares no
  `background` of its own. The guest must be given an explicit neutral document ground so it never
  shows Conduit's ink through the page — the guest's own background wins inside the guest, and the
  `.docpage` tiers apply only to the pane around it. This is a **token decision made here**, and a
  per-theme QA row on top of it, not a QA row instead of a decision.
- Theme variants: Aero Dark / Aero Light / Neon all inherit, since every value is a token
  reference.

---

## 12. Assumptions

1. **`.html`/`.htm` only.** `.xhtml` deferred; `.vue`/`.svelte` excluded by INV-5.
2. **Scripts run**, with the network blocked by default (§5).
3. **Rendered is the default**, with a setting to flip it.
4. **The toggle is per-doc and ephemeral**; the durable preference is the default.
5. **8 MB document cap**, independent of `readFile`'s 2 MB text cap, which this path doesn't
   traverse. Sub-resources uncapped but root-confined.
6. **One honest label: `Open externally`,** everywhere — Explorer, tab menu, palette, viewer.
   The existing `Open in browser` (tab menu + palette) is **relabelled** to match. `shell.openPath`
   opens the OS-default app for `.html`, which is often an editor, so "Open in default browser" is
   a promise the code cannot keep; and the context-menu spec requires one wording per action
   across menus. The now-false comment at `app.tsx:1842-1843` — *"HTML files have no faithful
   in-editor render"* — is deleted, not left to mislead.
7. **The editor-tab menu's frozen close-family-first order is not amended.** The new rows go where
   `Open in browser` already sits.
8. **An ADR is warranted** (0005): this widens an invariant `src/webview-guard.ts` states in prose
   and `webview-guard.test.ts` pins. Recording a changed security invariant only in a spec that
   later archives is how invariants get quietly lost.
9. **One review finding was checked and rejected.** The review held that putting `isHtmlDocPath`
   in `src/media-kind.ts` would fail `npm run typecheck` because `tsconfig.webview.json`'s
   `include` lists only `["webview", "src/protocol.ts", "src/types.ts", "types"]`. Measured false:
   the renderer already imports ~30 other `src/*` modules (`src/lang`, `src/fuzzy`,
   `src/overlay-stack`, …) that are absent from that list, and typecheck is green — TS adds
   imported files to the program transitively. The real constraint in that neighbourhood is
   different and is now INV-6: the **esbuild** renderer bundle is `platform: 'browser'` with no
   node shims, which is why the path⇄URL module must avoid node builtins. Placement stands.

---

## 13. Decisions Needed

- **[high] Scripts execute in the preview.** Default taken: **yes**, confined to an in-memory
  partition with no node, no preload, `contextIsolation`, `sandbox`, root-confined file access,
  **and the network blocked by default**. Rev 1 flagged the script decision but left network
  policy undecided, which made the pair unsafe; the block-then-allow gate is what makes "scripts
  run" defensible. Reversible: an `htmlPreviewScripts: false` setting could be added without
  touching the transport.
- **[high] The http(s)-only guest invariant widens** by exactly one scheme, with confinement moved
  *into the host* (INV-1) and the guest nav guard made **session-aware** so only preview guests may
  navigate preview URLs — strictly tighter than a global widening. ADR 0005.
- **[normal] Remote sub-resources are blocked until allowed per tab.** A page using a CDN renders
  unstyled until the user clicks `Allow`. The alternative — allow by default — lets a page that
  read your disk post it anywhere. Flagged because it is the most visible behaviour change.
- **[normal] Sub-resource changes do not auto-reload.** Only the HTML file is watched.
  `Reload` covers it. Watching the doc's whole directory was rejected as disproportionate for v1.
- **[normal] `Mod+Shift+H`** is bound by default, reversing rev 1's "no default combo" —
  `ShortcutAction.defaultCombo` is required (`shortcuts.ts:7-12`) and a binding-less action is
  palette-only by an existing convention (`app.tsx:2436`). `Mod+Shift+V`, VS Code's chord, was
  checked and rejected: `Ctrl+Shift+V` is terminal paste (`terminal-clipboard.ts:5`).
- **[normal] `htmlDefaultView` default = `preview`.** One settings flip reverses it.
- **[normal] Only the active preview guest stays mounted**, unlike `web` tabs. Switching back to a
  preview tab costs a reload.
- **[normal] Guest-menu absence is `ASSUMED`**, from Electron's documented default plus zero
  `context-menu` handlers in the repo — not measured in the running app. It does not change what
  gets built: the handler is added either way, and it is harmless if a default existed.

---

## 14. Open questions

None — autonomous mode. Everything that would have been asked is in §12 or §13.

---

## Self-audit

All sections are filled from the checklists rather than from salience. §8 now carries the rows
rev 1 dropped — page-level error, dirty/saving, degraded — and says *why* first-run,
empty-after-action and feature-level permission-denied cannot occur instead of leaving them blank.
§9 carries the settings control, the palette gating, the guest context menu, `Open source`, and
the Markdown-link route. §10 gives the keyboard-escape a **mechanism** (`before-input-event`)
rather than asserting the outcome, and corrects the `plural()` misuse. §2's table marks three rows
`ASSUMED` and mirrors each into §13 — and the heading no longer overclaims that all are measured.
§3's producer/consumer table names both sides of every changed flow; the single consumer-only row
carries its measured reason **and** the scoped-out limitation that comes with it. INV-1 and INV-3
are corrected to things that can actually hold. One review finding was verified false and is
recorded as such (§12.9) rather than quietly dropped.

Length is at the top of the FULL budget. It is carried by §13's eight entries and the two blockers
folded in at revision 2, not by padding — rev 1's prose was cut to make room.

**Archive hygiene:** `docs/specs/` holds a handful of active specs plus two multi-spec epics, well
inside the threshold; ADR 0003's archive convention is being followed.
