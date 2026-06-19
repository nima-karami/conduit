# Run report — OS file-open + in-app PDF viewer (2026-06-19)

Two user-requested features, brainstormed → spec'd → built autonomously (delegated
subagents, conductor kept architecture/taste). Branch: **`git-run`** (not merged).

## Shipped (verified, committed on `git-run`)

| Feature | Spec | Commits | Verify | Runtime proof |
|---|---|---|---|---|
| **Open files in Conduit from the OS** | `docs/specs/2026-06-19-os-file-open.md` | `69639b5` + fixes `7e84b7c` | green (1440 tests) | `os-file-open` e2e PASS (real `second-instance`, warm + cold) |
| **In-app PDF viewer** | `docs/specs/2026-06-19-pdf-viewer.md` | `76ace57` | green | `pdf-viewer` e2e — 5/5 assertions (render, zoom, text layer, find, outline) |

Specs committed in `ce3c3a2`. Final `npm run verify` on the combined tree: green —
1440 unit tests, fallow clean, `npm audit --audit-level=high` clean (pdfjs-dist added
no high advisories), gitleaks clean.

### OS file-open (`69639b5`, `7e84b7c`)
- Universal "Open with Conduit" context menu on any file + ProgID / `Applications\Conduit.exe`
  / Default-Apps `Capabilities` registration over a curated text/code/config + `.pdf`
  extension set (`build/installer.nsh`). Uninstall removes all keys.
- `extractOpenTarget` / `gitRootOf` (pure, unit-tested); host-led routing (`openArg` →
  `openFileFromOS`: git-root-else-parent root → reuse-or-create session → `openFileInEditor`).
- **Code review caught 2 cold-launch defects, both fixed in `7e84b7c`:** (1) the arg parser
  matched `Conduit.exe` (argv[0]) as the file target on a packaged cold launch — now skips
  `process.execPath`/argv[0]; (2) the cold-launch open message fired before the renderer
  subscribed and was dropped — host now buffers OS opens and flushes them on renderer-ready.
  Plus added `.pdf` to the default-editor extension set.
- `installer.nsh` validated by a real `npm run dist` (NSIS compiled clean).

### PDF viewer (`76ace57`)
- `pdfjs-dist@6`, worker bundled as a separate esbuild entry; loaded via
  `GlobalWorkerOptions.workerPort` (a manually-constructed module Worker) to satisfy the
  `file://` renderer's CSP `worker-src 'self'` — pdf.js's default blob/CDN worker shim is
  blocked otherwise.
- Reuses the image binary channel (`FileContentDTO.pdf` base64 data URL, 50 MB cap).
- Decomposed: `pdf-document.ts` (proxy wrapper), `pdf-find.ts` (pure find), `pdf-viewer.tsx`
  (toolbar + collapsible Outline/Thumbnails sidebar + windowed continuous scroll, canvas +
  text layer). Render tasks cancelled, observers disconnected, doc `destroy()`'d on
  unmount/doc-change (code review confirmed no leaks). Encrypted/corrupt/over-cap handled
  with notices, not crashes.

## needs-human-smoke (requires a real installed build)

The OS launch boundary can't be driven by the smoke harness. After installing a packaged
build, manually verify (recipe in `.autoloop/evidence/os-file-open-manual.md`):
1. "Open with Conduit" appears on a file's right-click; Conduit shows in "Open with → Choose
   another app" and in Settings → Default apps for the curated types (incl. `.pdf`).
2. App closed → "Open with Conduit" on a file launches Conduit with the file open in a
   session rooted at its git root.
3. App open → opens the file as a tab in the matching/new session and focuses.
4. Set Conduit default for a type → double-click opens it in Conduit.
5. A real `.pdf` opens in the new PDF viewer (pages/zoom/find/outline/thumbnails).
6. Uninstall → all registry keys removed.

## Process note

Mid-run, smoke/dist activity collided with the user's running (installed) Conduit. Going
forward: never blanket-kill `electron.exe`; the smoke harness manages only the processes it
spawns.

## Not done / deferred

- Merge to `main` + release — left to the user (last release was 0.3.0).
- macOS/Linux OS integration; PDF editing/printing/annotations; encrypted-PDF password UI
  (all explicitly out of scope in the specs).
