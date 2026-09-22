# ADR 0006 — Host-side language servers

**Status:** proposed · **Date:** 2026-09-22
**Spec:** `docs/specs/2026-09-22-language-server-go.md` · **Plan:** `docs/plans/2026-09-22-language-server-go.plan.md`

## Context

Code navigation in Conduit came from one place: Monaco's TypeScript worker, running in the
renderer against an index of the project's sources. Every other language got an honest
"Code navigation isn't available for … files" and nothing else. An external user asked for Go.

Go navigation can't come from the renderer. The only credible engine is `gopls`, a native
process the user installs, which loads a whole module with `go list`, answers LSP over stdio, and
can hold hundreds of MB. Something has to find it, start it, feed it the open buffers, stop it,
and make sure it never outlives the app. The renderer holds no source of truth and can be
reloaded in place (the crash recovery at `electron/main.ts` reloads without a new webContents),
so that something is the Electron host.

## Decision

**The host owns every language-server process.** `electron/lsp-manager.ts` holds the servers,
the synced-document table, the clients and the whole lifecycle; `electron/lsp-server.ts` is one
process and its JSON-RPC connection; the renderer is a thin client over one invoke channel,
`'lsp'`, whose messages are validated at the boundary (`src/lsp-protocol.ts`). The renderer
never sees a server URI — the host converts every one to a canonical path.

**One server per server root.** The root is the highest `go.work` directory above the file,
else the nearest `go.mod`, else the workspace root (gopls ad-hoc mode). The root's `realpath` is
**only** the dedupe key: gopls is handed the root in the doc-path spelling first seen for it, so
its root URI and the doc URIs agree under a junction or `subst`, and any path it returns under
the real root is mapped back onto that spelling before the renderer sees it.

**A code-defined registry, generic downstream.** `src/lsp-registry.ts` is the only file that
knows Go. The watcher's filter is compiled from the entry's `watchGlobs`; the renderer learns
which languages have a server from the host (`statusSnapshot.languages`); every user-facing
string is a template filled from the entry (`displayName`, `binary`, `installHint`,
`moduleMarker`). Adding a server is adding an entry.

**Client epochs.** Documents are ref-counted per client = `(webContents id, page-load epoch)`.
The preload mints the epoch once per page load, because a webContents id survives `reload()`.
The first message carrying a new epoch retires the old one and releases its documents; a
straggler from a retired epoch is rejected.

**Ordered stops are not crashes.** Every stop the host causes — idle, the palette restart, a
root re-home, quit — marks the server `stopping` first, and its exit never triggers a restart.
Quit sets a manager-wide `disposed` flag before anything else, clears every timer, and every
async step re-checks it before spawning. An unexpected exit restarts after 1 s / 4 s / 16 s, at
most three times in a rolling five minutes, replaying every open document before any request
is sent; after that the server is `crashed` until the palette's "Restart {displayName} language
server". A graceful stop is `shutdown` then a PID-scoped tree kill — never the `exit`
notification, which would let gopls exit and orphan its `go list` children before `/T` can find
them. Nothing is ever killed by image name.

## Trust

Opening a Go file in a clone starts gopls, and gopls runs `go list` — which honours a repo's
`toolchain` directive and cgo's `pkg-config`. The chosen posture (conductor ruling, pending the
user's call before this merges):

- **Lazy auto-start**: the first Go tab, or the first Go navigation, starts the server.
- **`GOTOOLCHAIN=local`** in the server's environment unless the user's own environment sets
  `GOTOOLCHAIN` — opening a file must not download and run a toolchain the repo chose.
- **Non-absolute `PATH` entries are stripped from the server's environment.** The server's cwd
  is the repo, so a `.` or relative entry would let it run a repo-local `go`. The same rule
  governs the binary search itself.
- **No workspace-supplied configuration of any kind**: no `.conduit/*`, `.vscode/*`, `go.work`
  or env file can name or alter the binary, its arguments or its environment. The binary is found
  by name on `PATH` and a fixed list of well-known directories, `realpath`'d, and spawned by
  absolute path with no shell. A repo influences gopls only as it influences `go`.

**Recorded alternative, not built:** a per-root opt-in on the first Go navigation in a folder
("Start gopls for this folder?"). It closes the auto-start exposure at the cost of a prompt per
new clone. It is the user's decision to make before merge.

## Lifetime

A server lives while its root has at least one open tab of its language in any window. Sessions
do **not** hold a server: a terminal in a repo is no reason to keep hundreds of MB of gopls
alive. Sixty seconds after the last such tab closes the server is stopped gracefully; any open
or request in that window cancels the stop.

## Consequences

- **Orphans after a main-process crash rely on stdin EOF.** A force-killed Electron main cannot
  run `before-quit`, so gopls is left to notice its stdin closing. This is proven, not assumed:
  the `go-lsp` e2e force-kills only the main process (`taskkill /PID <main> /F`, no `/T`) and
  asserts gopls and every descendant are gone within 5 s. If that ever fails, a Windows Job
  object with kill-on-close becomes necessary — which needs a native binding the tree does not
  have (`@lydell/node-pty` exposes none).
- **Diagnostics are not free.** gopls type-checks and publishes diagnostics regardless; the host
  drops them. Showing them is a separate feature (markers, lifetimes, a Problems story).
- Two more dependencies ship in the main bundle: `vscode-jsonrpc` and
  `vscode-languageserver-protocol` (bundled by esbuild; `node_modules` is not packaged).

## Alternatives rejected

- **Hand-rolled LSP framing.** The 30-line scratch client used to measure gopls already
  mishandled partial `Content-Length` headers; stdio framing, ids and cancellation are the
  library's job.
- **`vscode-languageclient`.** It is bound to the VS Code extension API; everything it adds on
  top of `vscode-jsonrpc` assumes that host.
