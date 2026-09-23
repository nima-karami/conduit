---
status: shipped
date: 2026-09-23
tier: FULL
type: UI + host
---

# Workspace Trust for language servers

**Extends:** `2026-09-22-language-server-go.md` (§13 "Trust" decision). **ADR:** 0006 §Trust.
**Request (user):** "how does VSCode handle this? DO THAT!" — VS Code's Workspace Trust, adapted.

## 1. Problem

Opening a Go file starts gopls, and gopls runs `go list` in the repo (cgo `pkg-config`, a
repo's `toolchain` directive under a user GOTOOLCHAIN, the user's own GOFLAGS). A freshly cloned,
untrusted repo should get no tool of its own run until the user says so. Editing and
highlighting never depend on trust.

## 2. Model (VS Code, adapted)

| VS Code | Conduit |
|---|---|
| Trust is per folder, stored in the user profile | Per folder, `userData/workspace-trust.json` — never in a repo |
| Trusting a parent folder trusts everything under it | Same: a path is trusted iff it equals or is inside a trusted folder |
| Restricted Mode: extensions that run code are disabled | Restricted Mode: **language servers never start** for that folder |
| The prompt appears when a folder opens | The prompt appears the **first time a language server would start** for a root with no decision (a folder opens per terminal session, and gopls is the only thing that auto-runs project code) |
| "Don't Trust" is remembered by `security.workspace.trust.startupPrompt: once` (not asked again for that folder) | "Don't Trust" lasts **one app session**; the next launch asks again the first time a server would start. Nothing about a "no" is persisted — only trust is |
| "Manage Workspace Trust" | Palette: **Manage Workspace Trust** (lists trusted folders, each removable) and **Trust Current Folder** |

**Folder** = the workspace root (a `writeRoots()` member) containing the server root. Its
**parent** is that folder's parent directory. Paths are compared as `canonicalPath` spellings,
case-insensitively on Windows (the lsp-root rules).

## 3. Behaviour

1. **Order in `launch`:** resolve the binary first (a missing gopls is `absent` — resolving it
   runs nothing from the repo), then check trust. Untrusted → state **`restricted`**, no spawn,
   and a **trust prompt** is raised for the folder unless one is already pending or the folder was
   denied in this app session.
2. **Prompt** (non-modal, in the editor area, keyboard-reachable, `role="dialog"`,
   `aria-live="polite"`): **"Do you trust the authors of the files in this folder?"**, the folder
   path, the why line "{displayName} navigation runs tools from this project ({runsTools})." (Go: "gopls, go list" — a registry field),
   and three actions: **Trust**, **Trust Parent Folder**, **Don't Trust** (subtitle: "stay in
   Restricted Mode"). Only one prompt shows at a time; others queue. The folder path wraps rather
   than being cut, and **Trust Parent Folder** names its folder in its own text — it is not
   offered at all when that parent is a filesystem root or the home directory (the host refuses
   it too). **Keyboard route:** a prompt raised on its own never takes focus (the caret stays in
   the editor); every "ask me" surface — the Restricted toast's **Trust Folder…**, the Restricted
   breadcrumb, the palette's **Trust Current Folder** — moves focus to the **Trust** button of the
   prompt for the folder it asked about (the host replies with that prompt's id), whether it was
   already showing or arrives later. Another folder's prompt is never focused, and a refused or
   already-trusted request arms nothing.
3. **Trust / Trust Parent** → the host records the folder (or its parent), persists, and starts
   every `restricted` server now covered that still has open docs. **Don't Trust** → the folder
   stays Restricted for this app session; no further automatic prompts for it.
4. **Restricted outcomes:** nav → toast "Restricted Mode: trust this folder to enable
   {displayName} navigation." with a **Trust Folder…** action that re-raises the prompt;
   Ctrl+click stays silent. Hover → a one-line hover with the same sentence. Breadcrumbs → a
   "Restricted Mode" segment whose click re-raises the prompt.
5. **Revoke** (palette) → removed from the store, persisted, and every running server whose root
   is no longer trusted is stopped through the ordered stop (PID-scoped tree kill); its docs go
   `restricted`.

## 4. Trust boundary

The host owns the store, the prompts and the enforcement (in `LspManager`, before any spawn). The
renderer can: ask the host to raise a prompt for a path (the host resolves it to a workspace
root, refusing anything outside every root); answer a prompt **by the host-issued prompt id with a
choice enum** — never a path; and revoke. It can never name a folder to trust.

**The floor, stated plainly:** a compromised renderer needs no user action to trust a folder — it
can raise a prompt (`lsp:trustRequest`), read its id (`lsp:trustState` / the `lsp:trust` push) and
answer it. What the host guarantees is only the *reach*: an open workspace root, or its parent
within the parent bound (§3.2). Accepted, because the threat this gate answers is "opening an
untrusted clone auto-runs its tools"; a compromised renderer already drives the PTYs, i.e. runs
any command as the user. Recorded in ADR 0006 §Trust.

## 5. Protocol

- `lsp:trustState {}` → `{ trusted: string[]; prompt: LspTrustPrompt | null }`
- `lsp:trustRequest { path, languageId }` → `{ ok, promptId }` (raise — or find — the prompt for
  the folder of `path`; `promptId` null when that folder is already trusted)
- `lsp:trustAnswer { promptId, choice: 'trust' | 'trustParent' | 'deny' }` → `{ ok }`
- `lsp:trustRevoke { path }` → `{ ok }`
- push `lsp:trust { trusted, prompt }` on every change.
- New server state `restricted`; new unavailable reason `restricted`.

## 6. Acceptance

- **T1** No gopls process is spawned for an untrusted folder; its nav reports Restricted Mode.
- **T2** Trust from the prompt starts gopls and F12 lands.
- **T3** Revoking trust stops that root's gopls (PID gone).
- **T4** A trust decision survives a relaunch (userData), and trusting a parent covers a child.
- **T5** A renderer message can't reach a folder the host didn't raise a prompt for: forged or
  reused prompt ids and paths outside every workspace root are refused (§4 states what this does
  *not* stop).
- Unit: pure store (parent inheritance, Windows case/separators, ubuntu-safe); manager (no spawn
  while restricted, prompt raised once, trust → start, deny → no re-prompt, revoke → ordered stop,
  bogus prompt ids rejected). E2E (`go-lsp`): T1–T3 via the real prompt buttons; the older steps
  pre-trust their fixture through the same host path.
