# Run report — in-app web view + Explorer "Open with" (2026-06-19)

Two user-requested features, spec'd → built → verified autonomously on branch
**`git-run`** (not merged to `main`; release left to the user). Built **serially** —
both touch `protocol.ts` + `main.ts` + `styles.css`, so a parallel fan-out would
collide on shared entry files.

## Shipped (verified, committed on `git-run`)

| Feature | Tier | Spec | Commit | Verify | Runtime proof |
|---|---|---|---|---|---|
| **Explorer "Open externally" / "Open with…"** | LITE | `docs/specs/2026-06-19-open-with.md` | `ce043d8` | green (1443) | `open-with` e2e: "Open externally" records `shell.openPath(file)` |
| **In-app web view** | FULL | `docs/specs/2026-06-19-web-view.md` | `4a75376` | green (1458) | `web-view` e2e: real `<webview>` loads an http fixture; tab adopts the live page `<title>`; error panel on a dead port — 4/4 |

Final `npm run verify` on the combined `git-run` tree (after both commits): **green —
1458 unit tests, fallow clean, `npm audit --audit-level=high` clean, gitleaks clean.**
(`npm audit` notes pre-existing low/moderate dompurify advisories via monaco-editor;
below the high gate, unchanged by this run.)

### Open with (`ce043d8`)
- Two file-row menu items: **Open externally** (`shell.openPath` → default app) and
  **Open with…** (native OS application chooser). Pure `openWithCommand(platform, path)`
  builds the win32 `OpenAs_RunDLL` argv (unit-tested, 3/3); host spawns it detached/unref'd
  so the dialog outlives the IPC turn; off-Windows falls back to the default-app open.
- New `WebviewToHost` messages `openExternalPath` / `openWith`; preview bridge no-ops them.
- **needs-human-smoke:** the visible win32 "Open with…" chooser is a native dialog the smoke
  harness can't drive (`.autoloop/evidence/open-with-manual.md`). The shared menu→IPC→host
  wiring is proven by the recordable "Open externally" path.

### Web view (`4a75376`)
- `<webview>`-tag browser tab (chosen over a `WebContentsView` native overlay — see D-1).
  New doc kind `web` (path = URL; `web:<url>` id reuses the existing ownership/persistence).
  Browser chrome: address bar, back/forward, reload/stop, loading state, live `<title>` →
  tab label, in-tab error panel. Entry: command palette "Open web page…" + a URL prompt.
- Web tabs stay mounted across tab/session switches (like terminals), so a page never
  reloads when you switch away and back.
- **Security:** `webviewTag` enabled, but each guest is locked down at attach time
  (`will-attach-webview` → strip preload, force no-node + contextIsolation + sandbox, refuse
  non-`http(s)` src) and the guest's own `web-contents` routes popups to the system browser
  and blocks non-`http(s)` navigation; dedicated `persist:webview` partition isolates guest
  storage. Pure `hardenWebviewPrefs`/`isHttpUrl` + `normalizeUrl` are unit-tested.
- Runtime e2e drives the **real built app** (the `<webview>` tag doesn't exist in the browser
  preview): the tab adopting the fixture's `<title>` proves the guest actually loaded the
  page and fired its nav events, not just that an element mounted.

## Decisions made under autonomy (reversible; surfaced for course-correction)

- **D-1 web renderer: `<webview>` tag** over `WebContentsView`/`BrowserView`. Tabs live in
  the renderer DOM; `<webview>` flows there for free, while a native overlay would have to be
  positioned over the active tab's rect, fighting the existing tab/blur layout. Trade-off:
  `<webview>` is heavier and "soft-deprecated" but fully supported in Electron 42.
- **D-2 no link hijacking.** Markdown/terminal links still open in the system browser; the
  web view is explicit opt-in (palette). Trivially reversible if you'd prefer in-app capture.
- **D-3 chrome depth.** Shipped full address bar + nav; **not** in this pass: find-in-page,
  zoom, devtools, bookmarks/history, or session persistence of open web tabs across restart.

## needs-human-smoke

- **open-with:** the native "Open with…" chooser dialog (manual recipe in
  `.autoloop/evidence/open-with-manual.md`).
- **web-view:** real-site checks — X-Frame-Options sites, link nav enabling Back/Forward,
  "open in system browser", warm tab on switch-back (`.autoloop/evidence/web-view-manual.md`).

## Not done / deferred

- Merge to `main` + release — left to the user (current release is 0.4.0; both features are
  on `git-run` with an `## [Unreleased]` CHANGELOG entry ready).
- Web-tab persistence across app restart; find-in-page/zoom in the web view; macOS/Linux
  "Open with…" chooser (falls back to the default-app open there).
