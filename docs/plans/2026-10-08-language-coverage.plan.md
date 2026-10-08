# Plan: language coverage — recognition, grammars, Python/Rust/C++ servers, server residency

Spec: [docs/specs/2026-10-08-language-coverage.md](../specs/2026-10-08-language-coverage.md) (FULL).
Decisions: [goal.md](../runs/2026-10-08-language-coverage/goal.md) — D1 Python/Rust/C++, D3 clangd
`--background-index -j=2`, D7 residency for every server incl. Go/C#; D2, D4, D5, D6, D8 spec defaults.

**Tier: FULL** — three sub-features, new public seams (`langFromShebang`, `lsp:visible`, registry
fields, residency policy), host + renderer + CI + 9 new e2e scenarios, parallel executors.

**Revision 2 (architecture review of 1d5f6aa, PROCEED_WITH_CHANGES).**
- Lane W (shared root watch) is **deferred**: no measured force, and it adds a stale-handle bug class.
- The launch/residency contract is rewritten: resolve and trust run outside the launch queue; one `requestLaunch` gate; `refreshResidency`; evictees are awaited to exit.
- `ServerWeight` lives in `lsp-registry.ts`.
- `initializationOptions` is an explicit field.
- An ADR 0006 amendment slice is added.
- Slice 0 is unchanged.

## Goal

Every common file colours on its first frame (by name, extension or shebang); Python, Rust and
C/C++ navigate like Go; at most 2 heavy / 4 total language servers are live and none starts for a
file nobody is looking at.

## Architecture

The spec's three lanes collide on `lsp-sync.ts`, `app.tsx`, `lsp-nav.ts`, `lsp-protocol.ts`,
`lsp-manager.ts`, `e2e.yml` and `timings.seed.json`. This plan re-cuts them so that every pair
running at the same time is file-disjoint:

1. **Slice 0 (serial, first): the recognition contract.** All of `src/lang.ts`, which covers the
   full §2.2 table, `langFromShebang` and the single content-aware resolver
   `langFromPathAndText`, plus its first caller, `src/file-service.ts`. Every later shebang
   consumer imports from here, so nothing downstream edits `lang.ts`.
2. **Then two parallel lanes:**
   - **A** owns renderer colouring (grammars, Monaco/hljs maps, diff/Review/plan consumers).
   - **B** owns servers end to end, including *every* LSP consumer of the shebang language (sync, nav, trust palette, rename), CI installs, the B e2e scenarios and the ADR 0006 amendment.
3. **Lane C (C1–C4) runs serially after B has landed.** It holds residency: `ServerWeight` + `weight` in `lsp-registry.ts`, the pure policy, manager integration, `main.ts` minimize wiring, the renderer visible sender, and the e2e + CI.
   - It edits B's `lsp-registry.ts`, `lsp-protocol.ts`, `lsp-server.ts`, `lsp-manager.ts`, `lsp-sync.ts`, `app.tsx`, `e2e.yml` and `timings.seed.json`.
   - Disjointness is impossible there, so it is serialized.
   - C1 is not run in parallel: `ServerWeight` lives in `lsp-registry.ts` (B's file during the parallel phase), and C1 is the slice that adds it beside its first consumer.

The `weight` registry field moves from the spec's lane B to C1, where the policy that reads it is
built.

**Deferred: shared root watch (spec §2.6 "Shared watches", AC-C4).** There is no measured force:
no event-storm or handle-count measurement shows per-server recursive watches cost anything.
Ref-counted shared watches add a stale-handle bug class: one subscriber's `onGone` and re-arm
racing another's close. Each server keeps its own `watchServerRoot`, unchanged. The spec records
it as a follow-up.

## Data flow

```
 disk ──readFile──▶ file-service.readFile ── langFromPathAndText(path, head) ──▶ FileContentDTO.language
                                                                                   │ (authority for a tab)
          ┌──────────────────────────────┬──────────────────────┬─────────────────┼──────────────────────┐
          ▼                              ▼                      ▼                 ▼                      ▼
   code-viewer (unchanged:      app.tsx sync effect     app.tsx trust palette   breadcrumb-bar     app.tsx rename (keeps
   setModelLanguage on          syncLanguageFor(path,   trustLanguageFor(dto    (lspLanguage)      old lang if new path
   mismatch)                    dto.language, served)   .language)                                 → plaintext)
                                 + syncSkipCause(dto)
                                         │ inputs / unsynced causes
                                         ▼
                                  lsp-sync.reconcileLspDocs ──lsp:open{languageId}──▶ LspManager.open
                                  (keyed by path+language)                              DocEntry.languageId
                                  notSyncedCause(path) ◀── lsp-nav.probeLspNav            │ serverSpecFor(any id)
                                                                                          ▼
   app.tsx visibleFilePaths ──lsp-sync.setLspVisible──lsp:visible{paths}──▶ visible union ─▶ refreshResidency
   BrowserWindow minimize/restore ──main.ts──▶ LspManager.setWindowMinimized ─┘        │
                                                                                     ▼
            requestLaunch(rec, reason) ─▶ launch: resolve+probe+trust (outside queue)
                                          ─▶ launchQueue: planEvictions → evict(await exit ≤2 s) → re-check → spawn
                     startLanguageServer(initializationOptions field; settings → workspace/configuration)
                     watchRoot ──▶ watchServerRoot (unchanged, one per server)

 Renderer-only colouring:  langFromPath / langFromPathAndText ──▶ monaco-languages GRAMMARS (+ custom ids)
                           ──▶ syntax-highlight MONACO_TO_HLJS ──▶ Review hljs, diff-viewer, plan fences
```

## Settled decisions — do not re-litigate

- D1 tier-1 servers: basedpyright (alt `pyright-langserver`), rust-analyzer, clangd. Java and the others are deferred.
- D3 clangd args `['--background-index', '-j=2', '--header-insertion=never']`.
- D7 residency, dormancy and "invisible open doesn't launch" apply to every server, Go and C# included.
- D2 `HEAVY_LIVE_MAX` 2, `LIVE_MAX` 4, `DORMANT_MS` 10 min, `EVICT_MIN_HIDDEN_MS` 60 s.
- D4 rust-analyzer keeps build scripts and proc-macros on. Only `checkOnSave:false` is set.
- D5 basedpyright settings `{typeCheckingMode:'off', diagnosticMode:'openFilesOnly'}`.
- D6 alias grammars ship: `dotenv`→ini, `groovy`→java, `ocaml`→fsharp.
- D8 `.m` stays plaintext. Objective-C (`.mm`) gets colour only.
- Spec §2.2 table, §2.3 cut line and grammar rules, §2.4 shebang parse and map, §2.5 table, and §2.6 rule table are taken exactly as written. Exceptions are listed under Spec staleness and in the revision-2 decisions below.
- (rev 2) **An eviction awaits the evictee's process EXIT** (`LspServerHandle.exited`), bounded by `EVICT_EXIT_WAIT_MS` = 2 000. On timeout the launch proceeds and logs once. AC-C1 reads "never more than 2 heavy pids alive".
- (rev 2) **Shared root watch is deferred** (see Architecture). Spec §2.6 "Shared watches" and AC-C4 are follow-ups.

## Spec staleness

| Spec claim | Measured | Plan proceeds |
|---|---|---|
| §2.6: a window whose `document.visibilityState` is `hidden` (minimized) sends `lsp:visible []` | Every e2e window is created with `show: process.env.CONDUIT_E2E !== '1'` (`electron/main.ts:987`), so `visibilityState` is `hidden` for the whole suite. Chromium also reports `hidden` for an occluded window. With the renderer rule, no server would launch from a shown tab under e2e, and covering Conduit with another window would put servers to sleep | **Host-side minimize.** `main.ts` wires `BrowserWindow` `minimize`/`restore` to `LspManager.setWindowMinimized(webContentsId, bool)`, beside the `gitDemand.setSuspended` precedent at `electron/main.ts:4718-4719`, with the same suspended/drop semantics as `src/session-resource-demand.ts:45-59`. A minimized client's visible set counts as empty. The renderer always sends its real visible paths. Logged in Decisions Needed |
| §2.4/§3 consumer list | Also reads `LspLanguageInfo.languageId` by equality: `webview/components/breadcrumb-bar.tsx:78`, `webview/lsp-status.ts:43,93,103`, `webview/ts-nav.ts:677,700` | All go to lane B. `lspLanguage()` becomes the single any-id lookup |
| §14: lane A edits `src/file-service.ts`; B owns `weight` | Re-cut (see Architecture) | `file-service` → Slice 0. `weight` → C1 |
| §2.5 change 3: `initializationOptions` = the first `settings` section's value | Architecture review: rust-analyzer wants options in initialize, while pyright reads only `workspace/configuration`. Coupling the two through "first section" is implicit | Explicit optional `initializationOptions?: unknown` field. `settings` only answers `workspace/configuration`. Spec updated |
| ADR 0006 §Trust: binary is "`realpath`'d, and spawned by absolute path" (`docs/adr/0006-host-side-language-servers.md:101-103`) | Spawning the realpath breaks the rustup proxy's argv0 dispatch (spec §2.1), and `versionProbe` runs a binary before trust | Slice B6 amends the ADR |
| AC-B7 "didOpen carries `c` for `.h` (host log)" | The host never logs didOpen (`electron/lsp-manager.ts:514-523` notifies only) | Asserted in `lsp-manager.test.ts`. The e2e asserts one clangd process for both docs |
| AC-B8 "no didOpen … reaches the server (host log)" | Same as above | The e2e asserts `lsp:statusSnapshot` holds no python record while only the 3 MB file is open, plus the F12 copy |
| A6 runner has LLVM and rustup | `actions/runner-images` Windows 2022 and 2025 readmes (2026-10-08) list LLVM 20.1.8, Rust 1.98.1, Rustup 1.29.1 (≥ 1.28, so A12's `RUSTUP_AUTO_INSTALL` holds) and Python 3.12.10 | CI pins these (Slice B5) |
| `go-lsp` and the C# scenarios start servers via raw `lsp:open` | `test/e2e/go-lsp.e2e.mjs:154-160` `openGoDoc` sends `lsp:open` with no tab. With D7 that no longer launches | C4 adapts them: after a raw `lsp:open`, send `lsp:request` `documentSymbol` at the same version, which wakes the server. A request is the spec's wake trigger, not a weakened check |

## Global constraints

- **Gate:** `npm run verify`. Inner loop: `npx vitest run test/unit/<file>` + `npm run verify:quick`. Two tsconfigs: `npm run typecheck` runs both.
- **e2e runs remotely only:** `npm run e2e:remote -- <names…>`. Locally, at most ONE scenario by exact name (`npm run e2e -- <name>`). Scenario hard deadline 200 s (`test/e2e/run-smoke.mjs:53`). New scenarios use the shared harness: launch through `launchElectron`/`launchApp`, exit through `finishScenario`. Installed-server scenarios **fail, never skip** when the server is missing.
- **Edit files with Edit/Write only**, never PowerShell read-modify-write (it double-encodes UTF-8).
- Every builder commits on a **named branch** off the integration SHA it was handed. The conductor integrates by the reviewed SHA.
- Naming: files kebab-case by role (`toml-grammar.ts`, `lsp-residency.ts`). Constants `SCREAMING_SNAKE`. Grammar exports are lowercase ids (`export const toml: Grammar`) like `gomod`/`log`.
- Comments: WHY only. Link the spec section (`// see spec 2026-10-08-language-coverage §2.6`) and never restate it (CLAUDE.md).
- `src/` is shared host+renderer and stays Node-free where the renderer imports it (`lang.ts`, `lsp-protocol.ts`, `lsp-residency.ts`).
- No registry entry is read from a workspace (ADR 0006). `versionProbe` runs with `cwd: ctx.tmpdir`.
- Unit tests never depend on `process.platform`. Pass the platform explicitly (CI verify is Ubuntu).
- `CHANGELOG.md`, `docs/specs/INDEX.md` and the spec's `status:` belong to the conductor. No lane edits them.

## Out of scope

Spec §1 non-goals; diagnostics/formatting/completion; Java/Ruby/PHP/Kotlin/Swift/Lua/Bash/Zig
servers; Haskell/Zig/Nix/Erlang/LaTeX/Astro/CSV grammars; `.vue`/`.svelte` template grammars;
user file associations; any settings UI; memory-measured eviction (D2 alternative); the shared
root watch (spec §2.6 "Shared watches", AC-C4; deferred in rev 2). `electron/lsp-watcher.ts` is
not touched.

## Contracts

### Slice 0 — `src/lang.ts` (Node-free)

```ts
export type LanguageId = (typeof LANG)[keyof typeof LANG] | (typeof FILENAME)[keyof typeof FILENAME];
// Every §2.4 shebang target (python javascript typescript shell ruby perl powershell php lua r
// julia elixir tcl makefile) is already a table value, so the union stays exhaustive.
export function langFromPath(p: string): string;                       // unchanged signature; §2.2 steps 1–4
export function langFromShebang(firstLine: string): LanguageId | null; // §2.4 parse/map; strips BOM and \r
/** langFromPath, then — only if that is 'plaintext' AND the (golden-stripped) basename has no
 *  exact-filename entry — langFromShebang on text's first line within SHEBANG_SNIFF_CHARS. */
export function langFromPathAndText(path: string, text: string): string;
export const SHEBANG_SNIFF_CHARS = 256;
export function isGoldenPath(p: string): boolean;                      // unchanged
export function languageDisplayName(id: string): string | null;        // unchanged; DISPLAY_NAMES gains every new id
```

New ids (all in `DISPLAY_NAMES`): `toml makefile cmake diff ignore dotenv groovy ocaml objective-c
razor coffeescript handlebars twig pug liquid bicep wgsl scheme restructuredtext systemverilog
verilog typespec cypher powerquery qsharp sparql`. The §2.2 prefix rules (`dockerfile.*`,
`containerfile.*`, `.env`, `.env.*`) run only when the extension is not in the extension table.

`src/file-service.ts` `readFile`: `language` is computed as today for the media and `readBounded`
decisions. After the `isBinary` check, the text branches use
`langFromPathAndText(absPath, buf.subarray(0, 1024).toString('utf8'))`, and `truncated` and
`invalid-utf8` reads are sniffed too. Binary, image and PDF reads are never sniffed.

### Lane A — renderer colouring

```ts
// webview/gomod-grammar.ts (unchanged) — export interface Grammar { conf; language }
export const toml: Grammar;      // webview/toml-grammar.ts
export const diff: Grammar;      // webview/diff-grammar.ts
export const makefile: Grammar;  // webview/makefile-grammar.ts
export const cmake: Grammar;     // webview/cmake-grammar.ts
export const ignore: Grammar;    // webview/ignore-grammar.ts
// webview/diff-folding.ts — 1-based inclusive, same shape markdownFoldingRanges returns (no kind)
export function diffFoldingRanges(lines: readonly string[]): { start: number; end: number }[];
// webview/plan-fence-language.ts
export function planFenceLanguage(fence: string): string; // fence table first, then langFromPath(`block.${fence}`), else fence
// webview/syntax-highlight.ts
const MONACO_TO_HLJS: Record<Exclude<LanguageId, 'plaintext'>, string | null>; // typed: a new id fails typecheck
export function monacoLangToHljs(monacoId: string): string | null;            // unchanged signature
export function hljsLanguageFor(path: string, firstNewLine: string | null): string | null;
//   = monacoLangToHljs(firstNewLine === null ? langFromPath(path) : langFromPathAndText(path, firstNewLine))
// test/unit/grammar-runner.ts — shared Monarch rule runner (states + push/pop)
export type GrammarToken = [text: string, token: string];
export function tokenizeLines(grammar: Grammar, lines: readonly string[]): GrammarToken[][];
```

The runner supports exactly these rule shapes and throws on any other. The five grammars are
written within them:
`[RegExp, string]`, `[RegExp, string[]]` (groups must cover the match), `[RegExp, string, next]`,
`[RegExp, { token: string; next?: string }]` with `next` one of `@pop`, `@push`, `@<state>`, plus
`{ include: '@<state>' }`. Tokens are restricted to `comment keyword string number type log-error`
plus `''`/`white`.

### Lane B — registry, binary, server, manager, renderer LSP

```ts
// src/lsp-registry.ts
export interface LanguageServerSpec {
  languageIds: readonly [string, ...string[]];   // replaces languageId; [0] is the primary id
  displayName: string;
  binary: string;
  altBinaries?: readonly string[];               // searched in order after `binary`; messages name `binary`
  args: readonly string[];
  rootMarkers: { workspace: readonly string[]; module: readonly string[] };
  requiresMarker: boolean;
  watchGlobs: readonly string[];
  watchIgnoreDirs: readonly string[];
  installHint: string;
  runsTools: string;                              // one server's line
  /** Sent as `initialize.initializationOptions` when set; omitted otherwise. */
  initializationOptions?: unknown;
  /** section → value; answers `workspace/configuration` items by exact `section`, else null. */
  settings?: Readonly<Record<string, unknown>>;
  /** Run at resolve with cwd tmpdir; non-zero exit / timeout → resolve null (absent). */
  versionProbe?: readonly string[];
  resolveToolDir(ctx: SearchContext): Promise<string | null>;
  extraSearchDirs(ctx: SearchContext, toolDir: string | null): Promise<string[]>;
  childEnv(base: Readonly<Record<string, string | undefined>>, toolDir: string | null, platform: HostPlatform): Record<string, string | undefined>;
}
export const primaryLanguageId = (spec: Pick<LanguageServerSpec, 'languageIds'>): string => spec.languageIds[0];
export const PYTHON_SERVER: LanguageServerSpec;  // §2.5 column Python
export const RUST_SERVER: LanguageServerSpec;    // §2.5 column Rust
export const CLANGD_SERVER: LanguageServerSpec;  // §2.5 column C/C++, languageIds ['cpp', 'c']
export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [GO_SERVER, CSHARP_SERVER, PYTHON_SERVER, RUST_SERVER, CLANGD_SERVER];
export function serverSpecFor(languageId: string, registry?: readonly LanguageServerSpec[]): LanguageServerSpec | null; // matches ANY id
export function languageInfo(spec: LanguageServerSpec): LspLanguageInfo; // + languageIds
// src/lsp-binary.ts
export interface FoundBinary { path: string; realPath: string }
export function findBinary(name: string, dirs: readonly string[], ctx: SearchContext): Promise<FoundBinary | null>;
export interface ResolvedServer { binary: string /* spawn path = FoundBinary.path, not the realpath */; toolDir: string | null }
export const VERSION_PROBE_TIMEOUT_MS = 5_000;
export function resolveServerBinary(spec: LanguageServerSpec, ctx: SearchContext): Promise<ResolvedServer | null>; // + altBinaries, + versionProbe
// src/lsp-protocol.ts
export interface LspLanguageInfo { languageId: string; languageIds: string[]; displayName: string; binary: string; installHint: string; moduleMarker: string }
export interface LspTrustPrompt { id; folder; parent; languageId; displayName; runsTools: string[] } // one entry per registry server
export type LspNotSyncedCause = 'too-large' | 'encoding';
// LspServerStatus.languageId stays the PRIMARY id (e2e csharp-fixture.mjs:132 and csharp-lsp-idle:60 read it).
// src/lsp-root.ts
resolveServerRoot(file, roots, spec: Pick<LanguageServerSpec, 'languageIds' | 'rootMarkers' | 'requiresMarker'>, probe, platform); // key uses primaryLanguageId
// electron/lsp-server.ts — initializeParams(root: string, initializationOptions: unknown | undefined)
//   (field omitted when spec.initializationOptions is undefined)
// workspace/configuration: items.map(i => settings has own i.section ? settings[i.section] : null)
// webview/lsp-status.ts
export function lspLanguage(languageId: string): LspLanguageInfo | null;          // matches any of languageIds
export function trustLanguageFor(languageId: string | null, langs: readonly LspLanguageInfo[]): LspLanguageInfo | undefined; // any-id
export function servedLanguageIds(langs: readonly LspLanguageInfo[]): Set<string>; // union of languageIds
// webview/lsp-sync.ts
export function syncLanguageFor(path: string, language: string, served: ReadonlySet<string>): string | null; // golden → null
export function syncSkipCause(dto: Pick<FileContentDTO, 'truncated' | 'readOnlyReason'>): LspNotSyncedCause | null;
//   truncated → 'too-large'; readOnlyReason 'invalid-utf8' → 'encoding'; else null
export function reconcileLspDocs(inputs: readonly LspDocInput[], unsynced: ReadonlyMap<string, LspNotSyncedCause>): void;
//   a doc whose languageId changed is closed then reopened under the new id
export function notSyncedCause(path: string): LspNotSyncedCause | null;
// webview/lsp-nav.ts — LspNavProbe gains `notSynced: LspNotSyncedCause | null` (EMPTY_PROBE: null);
//   probeLspNav returns { ...EMPTY_PROBE, notSynced } before flushPending when notSyncedCause(path) is set.
//   modelForTarget uses langFromPathAndText(path, text).
// webview/nav-outcome.ts — NavOutcome gains { kind: 'lsp-not-synced'; language: LspLanguageInfo; cause: LspNotSyncedCause };
//   NavClassifyInput.lsp gains notSynced; classify order: unsupported → cancelled → notSynced → unavailable → …
//   copy: too-large "File too large for code navigation"; encoding "Code navigation needs UTF-8 text"
```

Manager invariants (B):
- `DocEntry.languageId` is set from `msg.languageId`, and `notifyOpen` sends it.
- `open` on an existing `DocEntry` whose `languageId` differs from `msg.languageId` is a close-and-reopen:
  1. send didClose to the old record if it is live, then `armIdle` it;
  2. delete the entry;
  3. run the fresh-open path under the new id, with `serverSpecFor(msg.languageId)` and `keyFor`;
  4. the new entry inherits the old entry's other-client refs.
- `absentUntil`, `restartLanguage` and statuses key by `primaryLanguageId(spec)`. `restartLanguage(id)` resolves the spec through `serverSpecFor(id)`.
- `private readonly resolved = new Map<string, ResolvedServer>()` is keyed by the primary id. `launch` uses the cached value, else `resolveBinary`. A null result deletes the entry, and `restartLanguage` deletes it.
- `raisePrompt` sets `runsTools: this.deps.registry.map((s) => s.runsTools)`.

### Lane C — residency

```ts
// src/lsp-registry.ts (C1)
export type ServerWeight = 'light' | 'heavy';
// LanguageServerSpec gains `weight: ServerWeight` — Go light, Python light, C# heavy, Rust heavy, C/C++ heavy.
// src/lsp-residency.ts (C1, Node-free; imports type ServerWeight from './lsp-registry')
export const HEAVY_LIVE_MAX = 2;
export const LIVE_MAX = 4;
export const EVICT_MIN_HIDDEN_MS = 60_000;
export const DORMANT_MS = 600_000;
/** A derived snapshot the manager builds per decision — never stored. */
export interface ResidencyServer {
  key: string; weight: ServerWeight; state: LspServerState;
  /** Counts toward the budget: past resolve+trust and holding (or about to hold) a process —
   *  `rec.handle !== null && !rec.stopping`. A record still resolving or `absent`/`restricted` never counts. */
  live: boolean;
  visible: boolean;
  /** When it last stopped having a visible doc; record creation time if never visible. Ignored while visible. */
  hiddenSince: number;
  /** Last change / request / became-visible; an invisible open is not activity. */
  lastActivity: number;
  inFlight: number;
}
export function isEvictable(s: ResidencyServer, now: number): boolean;
//   live && !visible && inFlight === 0 && state ∉ {starting, loading} && now - hiddenSince >= EVICT_MIN_HIDDEN_MS
/** Keys to stop (LRU by lastActivity first) so launching `incoming` keeps ≤ HEAVY_LIVE_MAX heavy and ≤ LIVE_MAX
 *  live; `servers` may include `incoming` (ignored by key). overBudget: a cap cannot be met → soft cap. */
export function planEvictions(incoming: { key: string; weight: ServerWeight }, servers: readonly ResidencyServer[],
  now: number): { evict: string[]; overBudget: boolean };
export function isDormant(s: ResidencyServer, now: number): boolean;
//   live && !visible && inFlight === 0 && state ∉ {starting, loading} && now - max(lastActivity, hiddenSince) >= DORMANT_MS
// src/lsp-protocol.ts (C2)
export const LSP_VISIBLE_MAX = 64;
// LspCalls['lsp:visible']: { req: { paths: string[] }; res: { ok: boolean } };
//   parse: Array.isArray, length <= LSP_VISIBLE_MAX, every element absPath → copied array; else null.
// electron/lsp-server.ts (C2) — LspServerHandle gains `readonly exited: Promise<void>` (resolves on child exit/error;
//   the existing internal exitedP).
// electron/lsp-manager.ts (C2)
export const EVICT_EXIT_WAIT_MS = 2_000;
setWindowMinimized(webContentsId: number, minimized: boolean): void; // public
type LaunchReason = 'visible' | 'request' | 'trust';
private requestLaunch(rec: ServerRecord, reason: LaunchReason): void;
private refreshResidency(): void;
private residencySnapshot(now: number): ResidencyServer[]; // derived from records + docs + visible union
// webview/lsp-sync.ts (C3)
export function setLspVisible(paths: readonly string[]): void;
//   sends lsp:visible when the sorted set differs from the last set the HOST ACCEPTED; the set is recorded only
//   when lspInvoke resolves { ok: true } — a rejected/refused send leaves it unrecorded so the next call retries.
```

Manager residency invariants (C2). A **visible doc** is a doc with refs whose path is in the
visible union. The union is the union of every current client's set, skipping minimized
webContents.

1. **One gate, `requestLaunch(rec, reason)`.**
   - It is the only path that starts a non-running record.
   - Callers:
     - `open` and `lsp:visible` call it with `'visible'`;
     - `prepareRequest` and `waitLive`'s re-touch (today `lsp-manager.ts:876`) call it with `'request'`;
     - `applyTrust` (today `:380-382`) calls it with `'trust'`.
   - `'visible'` and `'trust'` proceed only if the record has a visible doc. `'request'` always proceeds.
   - Proceeding means: if the state is `stopped`, or `absent` and expired (or `restricted`, for `'trust'`), go to `starting` and run `launch`.
   - `touch` keeps only its idle-timer cancel (`hold(rec)`).
   - The crash-restart timer (`onExit` → `launch`) is exempt: it calls `launch` directly.
2. **`launch` order.**
   - **Outside the queue, as today:** resolve binary (cache, then `resolveBinary` incl. `versionProbe`), absent handling, then the trust check (`restricted` + prompt). None of these spawn the server or count toward the budget.
   - **Only when the next step is `startServer`,** enter `private launchQueue: Promise<void>`. In the queue:
     1. `planEvictions(rec, residencySnapshot(now))`;
     2. for each evictee, re-run `isEvictable` on a fresh snapshot; skip it if no longer evictable;
     3. otherwise `evict(evictee)`;
     4. re-check `!disposed && gen === rec.generation && !rec.stopping && (hasVisibleDoc(rec) || rec.waiters.size > 0 || inFlightCount(rec) > 0)`;
     5. if true, `startServer`, which sets `rec.handle` inside the queue so the next queued launch counts it. Otherwise `setState(rec, 'stopped')` and leave.
   - Watch arming, initialize and the didOpen replay stay after the queue.
3. **`evict(rec)`.** Capture `h = rec.handle`, then `await this.stopRecord(rec)`, which keeps its docs and leaves it `stopped`. Then `await Promise.race([h.exited, delay(EVICT_EXIT_WAIT_MS)])`; on timeout, `log.warn` once per evictee.
4. **End of every residency stop (eviction or dormancy).** If the record has a visible doc, call `requestLaunch(rec, 'visible')`. This covers a doc that became visible during the stop.
5. **Nothing evictable:** launch anyway; `log.info` once per manager (`softCapLogged`).
6. **`refreshResidency()`** is the single place that:
   - derives each record's visibility from union × docs;
   - sets `hiddenSince = now` on a visible→hidden edge;
   - sets `lastActivity = now` on a hidden→visible edge and calls `requestLaunch(rec, 'visible')`;
   - (re)arms `rec.dormantTimer` for a live hidden record (`DORMANT_MS` after `max(lastActivity, hiddenSince)`), and clears it otherwise. When the timer fires: if `isDormant`, run the residency stop; else call `refreshResidency()`.

   It is called after `lsp:visible`, `open`, `close`/`afterRefsDropped`, `rehome`, `retireClient`, `dropWebContents` (which also deletes that webContents' minimized entry), `setWindowMinimized`, and `launch` reaching live. `clearTimers` clears `dormantTimer`.
7. `lastActivity` is also set on `change` and on `prepareRequest`. An invisible `open` is not activity.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides touched |
|---|---|---|---|
| language id of a path (§2.2) | `lang.ts` `langFromPath` (S0) | `file-service` (S0), diff-viewer, Review hljs, plan fences (A), lsp-nav targets (B), app.tsx rename (B), monaco GRAMMARS (A) | both |
| shebang language | `langFromPathAndText` (S0) via `readFile` DTO | code-viewer (unchanged: `code-viewer.tsx:220` already `setModelLanguage`s on mismatch, measured), lsp-sync + trust palette + rename + breadcrumb (B), lsp-nav targets (B), diff-viewer + Review (A) | both |
| new ids colour | `monaco-languages` GRAMMARS + `register` (A) | `ensureTokenizer` callers (code-viewer, diff-viewer, lsp-nav) | both. Callers are unchanged and pass ids through |
| hljs mapping | `MONACO_TO_HLJS` (A) | `review-view.tsx:2647`, `highlightLine` | both |
| served set | `languageInfo` → `lsp:statusSnapshot` (B) | `lsp-status` (any-id), app.tsx sync + hover registration, breadcrumb-bar, ts-nav, trust palette (B) | both |
| didOpen language id | `DocEntry.languageId` ← `lsp:open.languageId` ← lsp-sync input ← DTO (B) | server | both |
| not-synced | app.tsx `syncSkipCause(dto)` → `reconcileLspDocs(…, unsynced)` (B) | `lsp-nav` → `nav-outcome` copy (B) | both |
| trust tools list | registry `runsTools` → `raisePrompt` `string[]` (B) | `trust-prompt.tsx` (B) | both |
| settings | registry `settings` (B) | `lsp-server` initialize + configuration (B) | both |
| spawn path vs realpath | `findBinary` (B) | `resolveServerBinary` (spawn path), Go/C# `resolveToolDir` (realPath), Rust `resolveToolDir` (path) (B) | both |
| initializationOptions | registry `initializationOptions` (B) | `lsp-server` initialize (B) | both |
| visibility | app.tsx `visibleFilePaths` (`app.tsx:1678-1688`) → `setLspVisible` (C3); main.ts minimize (C2) | manager `refreshResidency` (C2) | both |
| weight | registry (C1) | `planEvictions` (C1), manager snapshot (C2) | both |
| process exit | `LspServerHandle.exited` (C2, `lsp-server.ts`) | manager `evict` (C2) | both |
| ADR 0006 §Trust | docs (B6) | readers of the trust model; `lsp-binary.ts` behaviour (B1) | both |
| launch trigger change (D7) | manager (C2) | go-lsp / csharp-lsp / csharp-lsp-idle / mf-files raw `lsp:open` flows (C4 adapts) | both |

## File map

| Path | Action | Lane | Responsibility |
|---|---|---|---|
| `src/lang.ts` | modify | S0 | §2.2 tables + prefix rules, `langFromShebang`, `langFromPathAndText`, exported `LanguageId`, DISPLAY_NAMES |
| `src/file-service.ts` | modify | S0 | text branches use `langFromPathAndText` |
| `test/unit/lang.test.ts` | modify | S0 | AC-A7 table |
| `test/unit/file-service.test.ts` | modify | S0 | shebang DTO cases |
| `webview/monaco-languages.ts` | modify | A | static-import newly mapped Monaco grammars; alias + custom entries; `register` custom ids; diff folding provider |
| `webview/toml-grammar.ts`, `diff-grammar.ts`, `makefile-grammar.ts`, `cmake-grammar.ts`, `ignore-grammar.ts` | create | A | §2.3 grammars |
| `webview/diff-folding.ts` | create | A | per-file and per-hunk folds |
| `webview/plan-fence-language.ts` | create | A | fence table |
| `webview/components/plan-code-block.tsx` | modify | A | use `planFenceLanguage` (replaces `monacoLanguageFor` at :47-52) |
| `webview/syntax-highlight.ts` | modify | A | typed `MONACO_TO_HLJS`, new entries, `hljsLanguageFor` |
| `webview/components/diff-viewer.tsx` | modify | A | `:112` → `langFromPathAndText(doc.path, workText)` |
| `webview/components/review-view.tsx` | modify | A | `:2647` → `hljsLanguageFor(change.path, firstNewLineIfHunkStartsAt1)` |
| `test/unit/grammar-runner.ts` | create | A | shared Monarch runner |
| `test/unit/log-grammar.test.ts` | modify | A | use the shared runner (remove inline copy :8-48) |
| `test/unit/{toml,diff,makefile,cmake,ignore}-grammar.test.ts`, `grammar-linear.test.ts`, `diff-folding.test.ts`, `plan-fence-language.test.ts` | create | A | units |
| `test/unit/syntax-highlight.test.ts` | modify | A | every LanguageId has an entry |
| `test/e2e/language-coverage.e2e.mjs` | create | A | AC-A1–A6 |
| `src/lsp-registry.ts` | modify | B, then C1 | spec shape, 3 new servers (B); `ServerWeight` + `weight` (C1) |
| `docs/adr/0006-host-side-language-servers.md` | modify | B | §Trust amendment (B6) |
| `src/lsp-binary.ts` | modify | B | `FoundBinary`, altBinaries, versionProbe |
| `src/lsp-root.ts` | modify | B | primary-id key |
| `src/lsp-protocol.ts` | modify | B, then C2 | `languageIds`, `runsTools[]`, `LspNotSyncedCause` (B); `lsp:visible` (C2) |
| `electron/lsp-server.ts` | modify | B, then C2 | initializationOptions + settings (B); `exited` on the handle (C2) |
| `electron/lsp-manager.ts` | modify | B, then C2 | any-id, DocEntry id, resolved cache, prompt list (B); residency (C2) |
| `webview/lsp-status.ts` | modify | B | any-id lookups, `servedLanguageIds` |
| `webview/lsp-sync.ts` | modify | B, then C3 | DTO language, skip causes, reconcile by language (B); `setLspVisible` (C3) |
| `webview/lsp-nav.ts` | modify | B | not-synced probe, content-aware target models |
| `webview/nav-outcome.ts` | modify | B | `lsp-not-synced` |
| `webview/ts-nav.ts` | modify | B | pass `notSynced` into classify |
| `webview/components/breadcrumb-bar.tsx` | modify | B | `:78` → `lspLanguage(language)` |
| `webview/components/trust-prompt.tsx` | modify | B | one line per server |
| `webview/app.tsx` | modify | B, then C3 | served union, hover ids, sync from DTO, trust palette, rename (B); visible sender (C3) |
| `test/unit/lsp-{registry,binary,root,server,manager,protocol,status,sync,nav}.test.ts`, `nav-outcome.test.ts`, `trust-prompt.test.ts` | modify | B (manager/protocol/sync again in C) | units |
| `test/e2e/lsp-fixture.mjs` | create | B | generic LSP e2e helpers MOVED from `csharp-fixture.mjs` (`lsp`, `recordTree`, `survivorsAfter`, `trustViaHost`, `waitDefinition`) + `waitServerState(page, languageId, state, log, ms)`, `serverInstalled(binary, args)` |
| `test/e2e/csharp-fixture.mjs`, `csharp-lsp.e2e.mjs`, `csharp-lsp-idle.e2e.mjs` | modify | B | import the moved helpers from `lsp-fixture.mjs` |
| `test/e2e/python-fixture.mjs`, `rust-fixture.mjs`, `clangd-fixture.mjs` | create | B | fixture writers |
| `test/e2e/lsp-missing-servers.e2e.mjs`, `python-lsp.e2e.mjs`, `rust-lsp.e2e.mjs`, `clangd-lsp.e2e.mjs`, `lsp-trust-multi.e2e.mjs` | create | B | AC-B1–B9 |
| `test/e2e/core-smoke.json` | modify | B | + `lsp-missing-servers` |
| `test/e2e/timings.seed.json` | modify | B, then C4 | seeds |
| `.github/workflows/e2e.yml` | modify | B, then C4 | install steps |
| `electron/main.ts` | modify | C2 | minimize/restore → manager, beside `gitDemand` (:4718-4719) |
| `src/lsp-residency.ts` | create | C1 | pure policy |
| `test/unit/lsp-residency.test.ts` | create | C1 | policy units |
| `test/e2e/lsp-residency.e2e.mjs`, `lsp-residency-replay.e2e.mjs`, `lsp-residency-launch.e2e.mjs` | create | C4 | AC-C1, C3, C5 |
| `test/e2e/go-lsp.e2e.mjs`, `mf-files.e2e.mjs` (if it uses raw `lsp:open`) | modify | C4 | wake via request after raw open |

### Lane file sets (disjointness proof)

- **S0:** `src/lang.ts`, `src/file-service.ts`, `test/unit/lang.test.ts`, `test/unit/file-service.test.ts`.
- **A:** `webview/monaco-languages.ts`, `webview/{toml,diff,makefile,cmake,ignore}-grammar.ts`, `webview/diff-folding.ts`, `webview/plan-fence-language.ts`, `webview/components/plan-code-block.tsx`, `webview/syntax-highlight.ts`, `webview/components/diff-viewer.tsx`, `webview/components/review-view.tsx`, `test/unit/grammar-runner.ts`, `test/unit/log-grammar.test.ts`, `test/unit/{toml,diff,makefile,cmake,ignore}-grammar.test.ts`, `test/unit/grammar-linear.test.ts`, `test/unit/diff-folding.test.ts`, `test/unit/plan-fence-language.test.ts`, `test/unit/syntax-highlight.test.ts`, `test/e2e/language-coverage.e2e.mjs`. **No** e2e.yml, timings, core-smoke edit: its seed is written by B5, and it needs no install.
- **B:** `src/lsp-registry.ts`, `src/lsp-binary.ts`, `src/lsp-root.ts`, `src/lsp-protocol.ts`, `electron/lsp-server.ts`, `electron/lsp-manager.ts`, `webview/lsp-status.ts`, `webview/lsp-sync.ts`, `webview/lsp-nav.ts`, `webview/nav-outcome.ts`, `webview/ts-nav.ts`, `webview/components/breadcrumb-bar.tsx`, `webview/components/trust-prompt.tsx`, `webview/app.tsx`, the 11 unit tests listed above, `test/e2e/lsp-fixture.mjs`, `csharp-fixture.mjs`, `csharp-lsp.e2e.mjs`, `csharp-lsp-idle.e2e.mjs`, `python-fixture.mjs`, `rust-fixture.mjs`, `clangd-fixture.mjs`, the 5 new B scenarios, `core-smoke.json`, `timings.seed.json`, `.github/workflows/e2e.yml`, `docs/adr/0006-host-side-language-servers.md`.
- **C (C1–C4, serial after B):** `src/lsp-registry.ts`, `src/lsp-residency.ts`, `src/lsp-protocol.ts`, `electron/lsp-server.ts`, `electron/lsp-manager.ts`, `electron/main.ts`, `webview/lsp-sync.ts`, `webview/app.tsx`, `test/unit/lsp-{residency,manager,protocol,registry,server,sync}.test.ts`, `test/e2e/lsp-residency.e2e.mjs`, `lsp-residency-replay.e2e.mjs`, `lsp-residency-launch.e2e.mjs`, `lsp-fixture.mjs`, `go-lsp.e2e.mjs`, `csharp-lsp.e2e.mjs`, `csharp-lsp-idle.e2e.mjs`, `mf-files.e2e.mjs` (conditional), `e2e.yml`, `timings.seed.json`.

A ∩ B = ∅: A is all colouring files, and B is all `lsp-*`/nav/trust/app/CI/ADR files. A imports
`lang.ts` read-only. B's `lsp-nav.ts` imports `ensureTokenizer` from A's `monaco-languages.ts`
read-only, and its export signature is unchanged. Lane C overlaps B by design and runs after it.
C does not touch any A file, so A may still be running when C starts.

## Scripts

None. Every repeated shape is either a data table (the §2.2 fixture list inside
`language-coverage.e2e.mjs`, generated by a loop over a `ROWS` array), or a few hand edits. The
AC-A9 bundle baseline is two commands (see S0.1), not a script. Count: 0.

## Slices

### Slice 0: recognition contract (serial — lands before anything else)

**Check:** `npx vitest run test/unit/lang.test.ts test/unit/file-service.test.ts` green; `npm run
verify` green; remote `npm run e2e:remote -- language-files go-files editor-first-paint`.

#### Task 0.1: bundle baseline + lang tables

**Files:** Modify `src/lang.ts`. Test `test/unit/lang.test.ts`.
**Interfaces:** Produces `LanguageId` (exported), `langFromShebang`, `langFromPathAndText`,
`SHEBANG_SNIFF_CHARS` (signatures in Contracts).
**Steps:**
- [ ] Before editing, run `npm run build` at the handed SHA and record `out/webview.js` byte size. Use `node -e "console.log(require('fs').statSync('out/webview.js').size)"`. Put it in the slice report as the AC-A9 baseline.
- [ ] Failing tests:
  - 'resolves every §2.2 name': a table over every §2.2 extension/exact name and every §4 row. Key assertions: `langFromPath('Makefile.toml')=='toml'`, `'.env.json'→'json'`, `'x.m'→'plaintext'`, `'Dockerfile.dev'→'dockerfile'`, `'CMakeLists.TXT'→'cmake'`, `'.envrc'→'shell'`, `'x.env'→'dotenv'`, `'x.d.ts'→'typescript'`, `'go.sum'→'plaintext'`.
  - 'langFromShebang': `'#!/usr/bin/env python3'→'python'`, `'#!/usr/bin/env -S deno run -A'→'typescript'`, `'\uFEFF#!/bin/bash\r'→'shell'`, `'#!/usr/bin/env NAME=v python3.12'→'python'`, `'#!/usr/bin/env -u X ruby'→'ruby'`, `'#! /usr/bin/env  pwsh-preview'→'powershell'`, `'#!/usr/bin/env uvx'→'python'`, `'#!/usr/bin/make -f'→'makefile'`, `'#!/opt/x/unknown'→null`, `'no shebang'→null`.
  - 'langFromPathAndText': `('bin/py','#!/usr/bin/env python3\n…')→'python'`; `('go.sum','#!/usr/bin/env python3')→'plaintext'`; `('run.golden','#!/bin/sh')→'shell'`; `('a.ts','#!/usr/bin/env python3')→'typescript'`; a 300-char first line containing a shebang after char 256 is not sniffed.
- [ ] Run `npx vitest run test/unit/lang.test.ts`. Expect FAIL (functions absent).
- [ ] Implement. DISPLAY_NAMES gets every new id (typecheck enforces it). Fix any existing expectation that was `toml→ini` or `vue→html` only where the spec changed it (`toml` changes; `vue` stays `html`).

#### Task 0.2: shebang in readFile

**Files:** Modify `src/file-service.ts` (`readFile` text branches, :110-142). Test `test/unit/file-service.test.ts`.
**Interfaces:** Consumes `langFromPathAndText(path: string, text: string): string`.
**Steps:**
- [ ] Failing tests:
  - 'extensionless shebang file reports python': temp file `tool` with `#!/usr/bin/env python3\nprint(1)\n`, so `readFile(p).language === 'python'`.
  - 'truncated shebang head is sniffed': cap 64, so `truncated && language==='python'`.
  - 'binary file is not sniffed': NUL bytes after `#!/bin/sh`, so `binary && language==='plaintext'`.
  - 'go.sum stays plaintext'.
- [ ] Run. Expect FAIL.
- [ ] Implement. Keep the up-front `langFromPath` for the media/`readBounded` decisions.

### Lane A — recognition + grammars (parallel, after S0)

### Slice A1: Monaco grammars mapped, aliases registered, hljs typed

**Check:** `npx vitest run test/unit/syntax-highlight.test.ts` green; `npm run typecheck` green.
**Claims (serial lane):** `webview/monaco-languages.ts`, `webview/syntax-highlight.ts` (lane A only).

#### Task A1.1: GRAMMARS + register + MONACO_TO_HLJS

**Files:** Modify `webview/monaco-languages.ts`, `webview/syntax-highlight.ts`. Test `test/unit/syntax-highlight.test.ts`.
**Interfaces:**
- Consumes `LanguageId` from `src/lang.ts`.
- Produces typed `MONACO_TO_HLJS` and `hljsLanguageFor(path: string, firstNewLine: string | null): string | null`.
**Steps:**
- [ ] Failing tests:
  - 'every LanguageId has an hljs entry': iterate a `const ALL_IDS = [...] satisfies readonly LanguageId[]` covering every id, so `monacoLangToHljs(id) !== undefined` and the value is in `hljs.listLanguages()` or `null`. `gomod`, `log`, `ignore`, `dotenv`→`ini`, `typespec`, `cypher`, `powerquery`, `qsharp`, `sparql`, `bicep`, `wgsl`, `pug`, `liquid`, `razor`, `restructuredtext`, `systemverilog`, `toml`→`ini` per spec §2.2. Map to `null` where hljs lacks the language: measure with `hljs.getLanguage(x)` in the test, not by memory.
  - 'hljsLanguageFor sniffs only when given a first line': `('bin/x', '#!/usr/bin/env python3')→'python'`, `('bin/x', null)→null`.
- [ ] Run. Expect FAIL.
- [ ] Implement:
  - Static-import `coffee handlebars twig pug liquid bicep wgsl scheme restructuredtext systemverilog typespec cypher powerquery qsharp sparql razor objective-c` from `monaco-editor/esm/vs/basic-languages/<dir>/<dir>.js`.
  - GRAMMARS keys: `coffeescript: coffee`, `verilog: systemverilog` (Monaco's own contribution loads `systemverilog.js` for both, `systemverilog.contribution.js`), `'objective-c'`, `razor`, `dotenv: ini`, `groovy: java`, `ocaml: fsharp`.
  - Add `monaco.languages.register({ id })` for `dotenv groovy ocaml` (and A2's five custom ids).
  - Type `MONACO_TO_HLJS` as `Record<Exclude<LanguageId,'plaintext'>, string | null>`.

### Slice A2: custom grammars

**Check:** `npx vitest run test/unit/toml-grammar.test.ts test/unit/diff-grammar.test.ts test/unit/makefile-grammar.test.ts test/unit/cmake-grammar.test.ts test/unit/ignore-grammar.test.ts test/unit/grammar-linear.test.ts test/unit/log-grammar.test.ts` green.
**Parallel groups:** G1: A2.1 then (A2.2, A2.3, A2.4, A2.5, A2.6 in any order, single executor) · Serial: A2.7

#### Task A2.1: shared runner

**Files:** Create `test/unit/grammar-runner.ts`. Modify `test/unit/log-grammar.test.ts` (replace :8-48 with an import).
**Interfaces:** Produces `tokenizeLines(grammar: Grammar, lines: readonly string[]): GrammarToken[][]`, `GrammarToken = [text: string, token: string]`. Rule shapes are listed in Contracts. Unsupported shapes throw `unsupported rule`.
**Steps:**
- [ ] The existing `log-grammar.test.ts` cases run through the shared runner and stay green. This is the proof (port task).
- [ ] Add a runner self-test in `grammar-linear.test.ts` (A2.7): a two-state toy grammar pops back to `root` across lines.

#### Tasks A2.2–A2.6: one grammar each

Same block per grammar. **Files:** create `webview/<g>-grammar.ts` + `test/unit/<g>-grammar.test.ts`. Produces `export const <id>: Grammar`. Failing tests first, then FAIL run, then implement.
- **toml** — `tokenizeLines(toml, ['[[bin]]'])[0]` equals `[['[[bin]]','type']]`. `'a.b-c = 1 # x'` gives key `keyword`, `1` `number`, `# x` `comment`. A 3-line `"""…"""` gives every line `string`. Also covered: `'''` literal multiline, `0x1F`, `1_000`, `inf`, `1979-05-27T07:32:00Z` `number`, `  indented.key = "v"`, `"quoted key" = 1`. Language config: `comments.lineComment '#'`, indentation folding (`folding.offSide: true`).
- **diff** — `diff --git a/x b/x`, `index …`, `--- a/x`, `+++ b/x` give `keyword`; `@@ -1,2 +1,3 @@ ctx` gives `type` for the `@@…@@` part and plain for the rest; `+x` `string`; `-x` `log-error`; `\ No newline at end of file` `comment`; ` ctx` plain. Column-0 whole-line rules only.
- **makefile** — `# c \` continuation then next line `comment`; `all: dep` gives `all:` `type`; `CC := gcc` gives `CC :=` `keyword`; `$(CC) $(shell $(X))` gives every `$(…)` `number` through a paren-counting state (`@push` on `$(`, `(`, `@pop` on `)`); `$@ $< $^ $*` `number`; `.PHONY: x`, `ifeq`, `include`, `define`, `export` `keyword`; TAB-led recipe line: strings + `$(…)` only.
- **cmake** — `add_executable(app main.cpp)` gives `add_executable` `keyword` (also `ADD_EXECUTABLE`); `${VAR}`, `$ENV{X}` `number`; `"q"` `string`; `[=[ … ]=]` bracket arg over 3 lines `string`; `#[[ … ]]` over 2 lines `comment`; `ON OFF TRUE FALSE` `number`.
- **ignore** — `# c` `comment` at col 0 only; `!keep` gives `!` `keyword`; `*.log`, `**/x`, `a?`, `[ab]` glob chars `type`; trailing `/` `type`.

#### Task A2.7: linearity gate

**Files:** Create `test/unit/grammar-linear.test.ts`.
**Steps:**
- [ ] Failing test 'each custom grammar tokenizes adversarial 20 000-char lines in < 50 ms': for `toml diff makefile cmake ignore gomod log`, lines `'['.repeat(20000)`, `'"'+'a'.repeat(19999)`, `'$('.repeat(10000)`, each `performance.now()` delta `< 50`.
- [ ] Failing test 'no nested quantifier in any rule': walk every tokenizer state's RegExp `.source`. Fail on `/\((?:[^()\\]|\\.)*[+*}]\)[+*{]/` (a quantified group whose body ends in a quantifier). The spec's AC-A8 static check.
- [ ] Run before the grammars exist. Expect FAIL (imports missing). Then green after A2.2–A2.6.

### Slice A3: register grammars + diff folding

**Check:** `npx vitest run test/unit/diff-folding.test.ts` green; `npm run typecheck`.

#### Task A3.1

**Files:** Create `webview/diff-folding.ts`, `test/unit/diff-folding.test.ts`. Modify `webview/monaco-languages.ts`: add `toml diff makefile cmake ignore` to GRAMMARS and `register`, and `registerFoldingRangeProvider('diff', …)` like the markdown one at :306-313.
**Interfaces:** Produces `diffFoldingRanges(lines: readonly string[]): { start: number; end: number }[]`.
**Steps:**
- [ ] Failing test: a 2-file, 3-hunk patch gives one range per `diff --git` block (start at its line, end at the line before the next `diff --git` or EOF) and one per `@@` hunk (start at `@@`, end before the next `@@`/`diff --git`/EOF). A patch with no `diff --git` (plain `---/+++/@@`) gives only hunk ranges. Single-line hunks are omitted (`end > start`).
- [ ] Run. FAIL. Implement.

### Slice A4: shebang-aware colour consumers + plan fences

**Check:** `npx vitest run test/unit/plan-fence-language.test.ts test/unit/syntax-highlight.test.ts` green; `npm run typecheck`.

#### Task A4.1

**Files:**
- Create `webview/plan-fence-language.ts`, `test/unit/plan-fence-language.test.ts`.
- Modify `webview/components/plan-code-block.tsx`: delete `monacoLanguageFor` (:47-52) and call `planFenceLanguage(fence)` at :94.
- Modify `webview/components/diff-viewer.tsx:112`: `langFromPathAndText(doc.path, workRef.current)`.
- Modify `webview/components/review-view.tsx:2647`: pass the first new-side line when the change's first hunk starts at new-side line 1, else `null`, to `hljsLanguageFor`. The executor reads the hunk shape in that component. The rule is fixed here.
**Interfaces:**
- Produces `planFenceLanguage(fence: string): string`. The table is `makefile make→makefile, cmake→cmake, toml→toml, diff patch→diff, dotenv env→dotenv, gitignore→ignore, groovy→groovy, ocaml→ocaml`, checked first, then `langFromPath('block.'+fence)`, then `fence` itself, and `''`→`'plaintext'`.
- Consumes `hljsLanguageFor` and `langFromPathAndText`.
**Steps:**
- [ ] Failing test: the fence table, plus `'ts'→'typescript'`, `'py'→'python'`, `'unknownlang'→'unknownlang'`, `''→'plaintext'`.
- [ ] Run. FAIL. Implement.

### Slice A5: e2e language-coverage + bundle budget

**Check:** remote `npm run e2e:remote -- language-coverage language-files review-diff-syntax plan-blocks editor-first-paint` all PASS. Then `npm run build` and record the `out/webview.js` size: delta vs the S0.1 baseline ≤ 40 960 B (AC-A9) in the lane report. Then `npm run verify`.

#### Task A5.1

**Files:** Create `test/e2e/language-coverage.e2e.mjs`.
**Steps:**
- [ ] Reuse `language-files.e2e.mjs`'s technique for reading a model's language id and its first-line token classes. `ROWS` holds one fixture per §2.2 table row (incl. aliases and newly mapped Monaco grammars).
- [ ] AC-A1: for each row, open the file and assert the model language id equals the row id and that the first non-blank line has ≥ 1 `.mtk*` class other than the default foreground, on the first frame after open (Neon theme).
- [ ] AC-A2: `bin/py`, `bin/d`, `bin/s` (CRLF), `bin/none`, `LICENSE`, `go.sum` give `python typescript shell plaintext plaintext plaintext`.
- [ ] AC-A3/A4/A6: token assertions as in A2 on the real tokenizer. `x.patch` has a fold chevron per hunk. In `tsconfig.json`/`.babelrc` the `//` line is `comment`. In `.jsonl` the keys and strings colour.
- [ ] AC-A5: the repo fixture is built with `changes-fixture.mjs` helpers. Change a `Makefile` and a `Cargo.toml`, then open Review: the rows carry `hljs-*` spans.
- [ ] Must finish < 200 s. If the row loop exceeds ~120 s locally, split the rows into `language-coverage` and `language-coverage-2` under the same file pattern. Do not drop rows.

### Lane B — registry, servers, LSP consumers, CI (parallel, after S0)

### Slice B1: generic registry fields

**Check:** `npx vitest run test/unit/lsp-registry.test.ts test/unit/lsp-binary.test.ts test/unit/lsp-root.test.ts test/unit/lsp-server.test.ts` green; `npm run typecheck`.
**Claims:** `src/lsp-registry.ts`, `src/lsp-binary.ts` (lane B).

#### Task B1.1: `languageIds` + `primaryLanguageId`

**Files:** Modify `src/lsp-registry.ts` (interface :17-43, GO/CSHARP `languageIds: ['go']`/`['csharp']`, `serverSpecFor` :199 any-id, `languageInfo` :206 + `languageIds`), `src/lsp-root.ts` (Pick + `serverKeyFor(primaryLanguageId(spec), …)` :384/:435), `src/lsp-protocol.ts` (`LspLanguageInfo.languageIds`). Tests: `lsp-registry.test.ts`, `lsp-root.test.ts`.
**Call sites:**
- `serverSpecFor`: `electron/lsp-manager.ts:339,420`, `test/unit/lsp-registry.test.ts:43-45,162`.
- `.languageId` on a spec: `electron/lsp-manager.ts:324,518,577,589,732,791` (B2 fixes these; B1 leaves them compiling via `primaryLanguageId`).
**Steps:**
- [ ] Failing tests: 'serverSpecFor matches any id' (a fake registry with `['cpp','c']`, so `serverSpecFor('c')` is that spec); 'languageIds unique across LANGUAGE_SERVERS'; 'root key uses the primary id' (`key === 'cpp:<root>'` for a `.h` file).
- [ ] Run. FAIL. Implement. Mechanical: replace each `spec.languageId` read with `primaryLanguageId(spec)`.

#### Task B1.2: `findBinary` path/realPath, `altBinaries`, `versionProbe`

**Files:** Modify `src/lsp-binary.ts` (:501-524), `src/lsp-registry.ts` (Go/C# `resolveToolDir` use `.realPath`). Test `test/unit/lsp-binary.test.ts` (update :48-57).
**Interfaces:** Produces `FoundBinary`, `findBinary(...): Promise<FoundBinary | null>`, `VERSION_PROBE_TIMEOUT_MS`. `resolveServerBinary` behaviour:
1. Search `binary`, then each `altBinaries` entry in order.
2. If `versionProbe` is set, run `ctx.execFile(found.path, spec.versionProbe, { cwd: ctx.tmpdir, env: spec.childEnv(ctx.env, toolDir, ctx.platform), timeout: VERSION_PROBE_TIMEOUT_MS })`; a rejection → `null`.
3. Return `{ binary: found.path, toolDir }`.
**Steps:**
- [ ] Failing tests:
  - 'spawn path is the non-realpath': `binary` is `'C:\\b\\x.exe'` while `realPath` is `'real:…'`.
  - 'altBinaries searched in order after binary'.
  - 'versionProbe runs in tmpdir with the child env'.
  - 'versionProbe failure → null'.
  - 'no versionProbe → no execFile'.
  - 'Go toolDir is dirname(realPath)'.
- [ ] Run. FAIL. Implement.

#### Task B1.3: `initializationOptions` + `settings` in lsp-server

**Files:** Modify `electron/lsp-server.ts` (`initializeParams` :33-60 gains `initializationOptions`; `workspace/configuration` handler :115-117), `src/lsp-registry.ts` (`initializationOptions?` and `settings?` fields). Test `test/unit/lsp-server.test.ts`.
**Steps:**
- [ ] Failing tests:
  - 'initializationOptions comes from the explicit field': spec `initializationOptions: {checkOnSave:false}` puts it deep-equal in the initialize params. With no field, the key is absent even when `settings` is set.
  - 'workspace/configuration answers by exact section': settings `{'basedpyright.analysis': A, 'python.analysis': A}`, items `[{section:'python.analysis'},{section:'basedpyright.analysis'},{section:'other'},{}]` give `[A, A, null, null]`.
- [ ] Run. FAIL. Implement.

### Slice B2: manager + protocol + trust prompt

**Check:** `npx vitest run test/unit/lsp-manager.test.ts test/unit/lsp-protocol.test.ts test/unit/trust-prompt.test.ts` green.
**Claims:** `electron/lsp-manager.ts`, `src/lsp-protocol.ts` (lane B).

#### Task B2.1

**Files:** Modify `electron/lsp-manager.ts`, `src/lsp-protocol.ts` (`LspTrustPrompt.runsTools: string[]` :79), `webview/components/trust-prompt.tsx:40`. Tests `test/unit/lsp-manager.test.ts` (:1386, :1402 expectations become arrays), `test/unit/trust-prompt.test.ts:36`.
**Steps:**
- [ ] Failing tests:
  - 'didOpen carries the doc's language id': a registry with `['cpp','c']`. Opening `x.h` as `c` and `x.cpp` as `cpp` gives one server record, and its didOpens carry `languageId` `c` and `cpp` respectively (AC-B7 unit half).
  - 'open with a different language id re-opens the doc': `p` as `shell` (served by a fake registry entry), then `p` as `python` gives didClose on the shell server and didOpen `python` on the python server. A second client's ref carries over (one later close of each client leaves no doc).
  - 'restart by a secondary id restarts the server'.
  - 'absent TTL is per server' (`.h` then `.cpp` while absent: one resolve).
  - 'resolve cached across stop/relaunch, cleared by restart and by a null resolve': count `resolveBinary` calls.
  - 'trust prompt lists one runsTools line per registry server'.
  - trust-prompt test: renders each line as its own element, wraps, no truncation.
- [ ] Run. FAIL. Implement per Contracts "Manager invariants (B)".

### Slice B3: renderer LSP consumers (shebang language, not-synced, any-id)

**Check:** `npx vitest run test/unit/lsp-status.test.ts test/unit/lsp-sync.test.ts test/unit/lsp-nav.test.ts test/unit/nav-outcome.test.ts` green; `npm run typecheck`.
**Claims:** `webview/app.tsx`, `webview/lsp-sync.ts` (lane B).

#### Task B3.1: lsp-status any-id

**Files:** Modify `webview/lsp-status.ts` (:42-48 `lspLanguage`, :89-96 `trustLanguageFor`, add `servedLanguageIds`), `webview/components/breadcrumb-bar.tsx:78` → `lspLanguage(language)`. Test `test/unit/lsp-status.test.ts`.
**Steps:**
- [ ] Failing tests: `lspLanguage('c')` returns the clangd info (seeded with `languageIds:['cpp','c']`); `trustLanguageFor('c', langs)` returns clangd; `servedLanguageIds` is the union. Then implement.
- [ ] Update every `LspLanguageInfo` literal in `test/unit/{lsp-status,lsp-nav,lsp-sync,nav-outcome,lsp-manager,lsp-registry}.test.ts` to carry `languageIds`.

#### Task B3.2: lsp-sync from DTO language + skip causes + reconcile by language

**Files:** Modify `webview/lsp-sync.ts` (:115-129, `SyncedDoc.languageId`), `src/lsp-protocol.ts` (add `LspNotSyncedCause`). Test `test/unit/lsp-sync.test.ts`.
**Interfaces:** Produces `syncLanguageFor`, `syncSkipCause`, `reconcileLspDocs(inputs, unsynced)` and `notSyncedCause` (Contracts).
**Steps:**
- [ ] Failing tests:
  - 'extensionless python is synced as python': `syncLanguageFor('/r/bin/tool','python',{python}) === 'python'`; a golden stays null.
  - 'truncated → too-large, invalid-utf8 → encoding, mixed-eol → null'.
  - 'language change closes and reopens': reconcile with `{p,'plaintext'…}` is not served. Then `{p,'python'}` sends `lsp:open python`. Then `{p,'shell'}` sends `lsp:close` then `lsp:open shell` if served.
  - 'notSyncedCause reflects the last reconcile'.
- [ ] Run. FAIL. Implement.

#### Task B3.3: lsp-nav + nav-outcome + ts-nav

**Files:** Modify `webview/lsp-nav.ts` (`LspNavProbe` :14-26, `EMPTY_PROBE`, `modelForTarget` :109-117 → `langFromPathAndText`, `probeLspNav` early return), `webview/nav-outcome.ts` (`NavOutcome` :16-37, `NavClassifyInput.lsp` :79-90, `classifyNavOutcome` :94, `lspOutcomeMessage` :207-239), `webview/ts-nav.ts` (~:677 pass `notSynced: probe.notSynced`). Tests `test/unit/lsp-nav.test.ts`, `test/unit/nav-outcome.test.ts`.
**Steps:**
- [ ] Failing tests:
  - nav-outcome: `classifyNavOutcome({…, lsp:{…, notSynced:'too-large'}})` gives `{kind:'lsp-not-synced', cause:'too-large'}`. Message text equals "File too large for code navigation" / "Code navigation needs UTF-8 text". `cancelled` still wins over notSynced.
  - lsp-nav: 'not-synced doc returns without a request' (no `lsp:request` invoked); 'target model for an extensionless shebang target is python'.
- [ ] Run. FAIL. Implement. `lsp-not-synced` is not in `POINTER_SILENT`.

#### Task B3.4: app.tsx wiring

**Files:** Modify `webview/app.tsx`:
- :1648-1651: hover ids `= [...servedLanguageIds(lspLanguages)]`.
- :1652-1669 sync effect: `served = servedLanguageIds(lspLanguages)`; `dto = files.get(d.path)`; `language = dto?.language ?? langFromPath(d.path)`; `languageId = syncLanguageFor(d.path, language, served)`. If `languageId` and `dto` and `syncSkipCause(dto)` → `unsynced.set(path, cause)` and skip. Then `reconcileLspDocs(inputs, unsynced)`.
- :3175 rename: `const byPath = langFromPath(m.to); language: byPath === 'plaintext' ? doc.language : byPath`.
- :3983 trust palette: `trustLanguageFor((activeFilePath && files.get(activeFilePath)?.language) || (activeFilePath ? langFromPath(activeFilePath) : null), lspLanguages)`.
**Steps:**
- [ ] No unit seam in app.tsx. The proof is B3.2/B3.3 units, `npm run typecheck`, and the B5 e2e (AC-B3 extensionless, B8, B9). Run `npm run verify:quick`.

### Slice B4: Python, Rust, C/C++ entries

**Check:** `npx vitest run test/unit/lsp-registry.test.ts` green.

#### Task B4.1

**Files:** Modify `src/lsp-registry.ts` (add `PYTHON_SERVER`, `RUST_SERVER`, `CLANGD_SERVER`, `LANGUAGE_SERVERS` :197). Test `test/unit/lsp-registry.test.ts`.
**Interfaces:** Every value is from spec §2.5, verbatim, plus these:
- Python: `languageIds ['python']`, `binary 'basedpyright-langserver'`, `altBinaries ['pyright-langserver']`, `args ['--stdio']`. With `const PY_ANALYSIS = {typeCheckingMode:'off', diagnosticMode:'openFilesOnly'}`: `settings {'basedpyright.analysis': PY_ANALYSIS, 'python.analysis': PY_ANALYSIS}`, so the pyright alt binary reads its own section. No `initializationOptions`. `extraSearchDirs` gives `[home/.local/bin]` when homedir, `resolveToolDir` gives `null`, `childEnv` is a copy of base.
- Rust: `languageIds ['rust']`, `requiresMarker true`, `versionProbe ['--version']`, `initializationOptions {checkOnSave:false}`, `settings {'rust-analyzer': {checkOnSave:false}}`.
  - `resolveToolDir`: `findBinary('cargo', [...pathDirs, $CARGO_HOME/bin, ~/.cargo/bin])`, then `dirname(found.path)`. The path, NOT realPath, so a distro symlink to `rustup` keeps argv0.
  - `extraSearchDirs`: `[$CARGO_HOME/bin, ~/.cargo/bin]` (absolute only).
  - `childEnv`: prepend toolDir to PATH, then `setUnlessPresent(env,'RUSTUP_AUTO_INSTALL','0',platform)`.
- C/C++: `languageIds ['cpp','c']`, `displayName 'C/C++'`, `binary 'clangd'`, `args ['--background-index','-j=2','--header-insertion=never']`, `requiresMarker false`, `watchIgnoreDirs ['CMakeFiles']`.
  - `extraSearchDirs`: win32 `joinFor(win32, env[envKey(env,'ProgramFiles','win32')], 'LLVM\\bin')` when set and absolute; darwin `/opt/homebrew/opt/llvm/bin`, `/usr/local/opt/llvm/bin`, `/Library/Developer/CommandLineTools/usr/bin`; linux `[]`.
  - `resolveToolDir` gives `null`.
- `runsTools` strings and install hints are from §2.5 rows.
**Steps:**
- [ ] Failing tests (AC-B6):
  - every new watch glob and marker compiles (`compileWatchGlobs`, `compileRootMarker`);
  - `languageIds` are unique;
  - `serverSpecFor('c') === CLANGD_SERVER`;
  - Rust `childEnv` sets `RUSTUP_AUTO_INSTALL=0` only when unset (incl. a win32 `rustup_auto_install` case), never mutates base, and prepends toolDir;
  - clangd win32 search dir derives from `ProgramFiles` (`D:\\PF` → `D:\\PF\\LLVM\\bin`) and is absent when unset;
  - Python `altBinaries` order;
  - Python `settings` answer both `basedpyright.analysis` and `python.analysis` with the same object;
  - Rust `initializationOptions` deep-equals `{checkOnSave:false}`.
- [ ] Run. FAIL. Implement.

### Slice B5: e2e + CI

**Check:**
- remote `npm run e2e:remote -- lsp-missing-servers python-lsp rust-lsp clangd-lsp lsp-trust-multi go-lsp csharp-lsp csharp-lsp-idle mf-files` all PASS. The installed-server scenarios must be PASS, not SKIP.
- Then `npm run verify`.
**Claims:** `.github/workflows/e2e.yml`, `test/e2e/timings.seed.json`, `test/e2e/core-smoke.json` (lane B).

#### Task B5.1: shared helpers + fixtures

**Files:**
- Create `test/e2e/lsp-fixture.mjs`: move `lsp`, `recordTree`, `survivorsAfter`, `trustViaHost`, `waitDefinition` from `csharp-fixture.mjs`, then add:
  - `waitServerState(page, languageId, state, log, ms)`: polls `lsp:statusSnapshot`, matches on the primary `languageId`.
  - `serverInstalled(binary, args)`: a `spawnSync` probe.
- Modify `csharp-fixture.mjs`, `csharp-lsp.e2e.mjs`, `csharp-lsp-idle.e2e.mjs` imports.
- Create:
  - `python-fixture.mjs`: `pyproject.toml`, `main.py` → `lib/util.py` `def greet()`, extensionless `bin/tool` (`#!/usr/bin/env python3`, imports `lib.util`), `loose/solo.py` with no marker. A 3 MB `big/huge.py` and an invalid-UTF-8 `big/latin.py` are written at test time.
  - `rust-fixture.mjs`: workspace `Cargo.toml` with `members=["app","util"]`, a `Cargo.lock` (written by `cargo generate-lockfile` if cargo is present, else a minimal valid v3 lockfile literal), `app/src/main.rs` calling `util::greet()`, `util/src/lib.rs`, plus `detached/x.rs` with no Cargo.toml.
  - `clangd-fixture.mjs`: `main.cpp` → `greet.hpp`/`greet.cpp`, `compile_commands.json` with absolute temp paths, a `.h` header.
**Steps:** Port task. The proof is `csharp-lsp csharp-lsp-idle` staying green remotely.

#### Task B5.2: scenarios

| Scenario | ACs | Install needed |
|---|---|---|
| `lsp-missing-servers` | B1: env `PATH`/`Path` = System32 only. `HOME`, `USERPROFILE`, `APPDATA`, `CARGO_HOME` and `ProgramFiles` point at one empty temp dir (go-lsp E5 mechanism, `test/e2e/go-lsp.e2e.mjs:338-352`). F12 in `.py`, `.rs`, `.cpp` gives exactly one install toast each, naming basedpyright / rust-analyzer / clangd with the §2.5 hint. No error toast. Files stay editable. A `.h` + `.cpp` pair gives one clangd toast | none |
| `python-lsp` | B3 Python (`main.py`→`lib/util.py`, hover signature, breadcrumb symbol; extensionless `bin/tool` F12), B5 Python ad-hoc (`loose/solo.py` gets a server, `adHoc`), B8 (`huge.py` alone: snapshot has no python record after 5 s, F12 copy "File too large for code navigation"; `latin.py` copy "Code navigation needs UTF-8 text") | python |
| `rust-lsp` | B3 Rust (one rust-analyzer record rooted at the workspace for both members), B4 (after `ready` and 10 s with no `cargo` descendant, save a `.rs` → no `cargo` descendant in 10 s, via `recordTree`), B5 Rust (`detached/x.rs` gives the no-root outcome) | rust |
| `clangd-lsp` | B3 C++ (`main.cpp`→`greet.hpp`/`greet.cpp`), B7 (`.h` and `.cpp` → one clangd pid in the snapshot) | clangd |
| `lsp-trust-multi` | B2 (untrusted folder with `.py`+`.rs`+`.cpp` open: zero server descendants, one prompt with a `runsTools` line per server); B9 (extensionless python active, so palette "Trust Current Folder" names Python) | python, rust, clangd |

Each must complete < 200 s. `lsp-missing-servers` is added to `core-smoke.json`.

#### Task B5.3: CI + seeds

**Files:** Modify `.github/workflows/e2e.yml` (after the C# steps, ~:225), `test/e2e/timings.seed.json`, `test/e2e/core-smoke.json`.
- Python (`if:` `' python-lsp '`, `' lsp-trust-multi '`): `actions/setup-python@v5` `python-version: '3.12'`, then pwsh `python -m pip install basedpyright==1.40.2` and `basedpyright-langserver --version`. 1.40.2 is the PyPI latest measured 2026-10-08. setup-python puts `Scripts` on PATH.
- Rust (`' rust-lsp '`, `' lsp-trust-multi '`): pwsh `rustup toolchain install 1.98.1 --profile minimal --component rust-analyzer`, `rustup default 1.98.1`, `rust-analyzer --version`, `Join-Path $HOME '.cargo' 'bin' >> $env:GITHUB_PATH`.
- clangd (`' clangd-lsp '`, `' lsp-trust-multi '`): pwsh `$llvm = Join-Path $env:ProgramFiles 'LLVM\bin'`; `if (-not (Test-Path (Join-Path $llvm 'clangd.exe'))) { choco install llvm --version=20.1.8 -y --no-progress }`; `& (Join-Path $llvm 'clangd.exe') --version`. Nothing goes on PATH: the server finds it through `%ProgramFiles%`.
- Use the same `contains(format(' {0} ', matrix.names), ' name ')` shape as the existing steps.
- Seeds (`medians`, seconds): `language-coverage: 60`, `lsp-missing-servers: 45`, `python-lsp: 90`, `rust-lsp: 120`, `clangd-lsp: 90`, `lsp-trust-multi: 60`. Extra seeds for scenarios on other lanes are harmless (`test/e2e/ci-state.mjs:34` only reads names that run).

### Slice B6: ADR 0006 §Trust amendment (docs-only)

**Check:** the amended paragraph matches `src/lsp-binary.ts` as built in B1.2 (reviewer reads both); `npm run check` green.

#### Task B6.1

**Files:** Modify `docs/adr/0006-host-side-language-servers.md` §Trust (the bullet at :100-103 "No workspace-supplied configuration…", which says "`realpath`'d, and spawned by absolute path").
**Steps:**
- [ ] Replace the binary sentence and add one bullet, stating:
  1. The binary is found by name on absolute `PATH` entries and the registry's fixed directory list, never the repo, and spawned by that **found absolute path** (not its realpath), so an argv0-dispatching proxy (rustup) works. The realpath is kept for `resolveToolDir` only (e.g. C#'s `DOTNET_ROOT`).
  2. Before trust, the only execution allowed is a version/tool probe (`versionProbe`, `go env GOPATH`): run with `cwd` = the OS temp dir and the server's stripped child env, with a 5 s timeout. Nothing runs in the repo before trust.
- [ ] Add a dated "Amended 2026-10-08 (language coverage)" line pointing to spec `docs/specs/2026-10-08-language-coverage.md` §2.5. Follow ADR 0003: amend in place, no new ADR.

### Lane C — residency (serial, after B lands)

### Slice C1: `ServerWeight` + pure policy

**Check:** `npx vitest run test/unit/lsp-residency.test.ts test/unit/lsp-registry.test.ts` green; `npm run typecheck`.
**Claims:** `src/lsp-registry.ts`.

#### Task C1.1

**Files:**
- Modify `src/lsp-registry.ts`: `export type ServerWeight`, `weight` field, and values on all five specs.
- Create `src/lsp-residency.ts` and `test/unit/lsp-residency.test.ts`.
- Modify `test/unit/lsp-registry.test.ts`.
**Interfaces:** Produces `ServerWeight` and everything under "src/lsp-residency.ts" in Contracts. C2 consumes them.
**Steps:**
- [ ] Failing tests (AC-C2 policy half, `now` injected):
  - over heavy cap evicts the LRU evictable heavy;
  - never evicts visible / inFlight > 0 / starting / loading / hidden < 60 s / `live:false`;
  - total cap evicts the LRU of any weight after the heavy pass;
  - nothing evictable gives `{evict: [], overBudget: true}`;
  - `incoming` already in the list is ignored;
  - `live:false` records never count toward a cap;
  - `isDormant` true at exactly `DORMANT_MS` after `max(lastActivity, hiddenSince)`, false while visible or in-flight;
  - registry: every spec has a weight; Go/Python are `light` and C#/Rust/C++ are `heavy`.
- [ ] Run. FAIL. Implement.

### Slice C2: manager residency

**Check:** `npx vitest run test/unit/lsp-manager.test.ts test/unit/lsp-protocol.test.ts test/unit/lsp-server.test.ts` green; `npm run typecheck`.
**Claims:** `electron/lsp-manager.ts`, `src/lsp-protocol.ts`, `electron/lsp-server.ts`, `electron/main.ts`.

#### Task C2.1: `lsp:visible`, handle `exited`, minimize wiring

**Files:**
- Modify `src/lsp-protocol.ts`: `LspCalls['lsp:visible']`, `LSP_VISIBLE_MAX`, and a parse case.
- Modify `electron/lsp-server.ts`: `exited` on `LspServerHandle`, exposing the internal `exitedP`.
- Modify `electron/main.ts`: at :4718-4719, beside `gitDemand.setSuspended`, capture `const wcId = w.webContents.id`, then `w.on('minimize', …)` / `w.on('restore', …)` also call `lspManager.setWindowMinimized(wcId, true|false)`. Window close needs no new hook: the existing `destroyed` → `dropWebContents` (:4431-4432) clears the minimized entry (C2.2).
- Tests: `lsp-protocol.test.ts`, `lsp-server.test.ts`.
**Steps:**
- [ ] Failing tests:
  - `parseLspMessage({type:'lsp:visible', paths:[abs]})` copies the array; 65 paths → null; a relative path → null; `..` → null.
  - lsp-server: `exited` resolves after the fake child emits `exit` and after `error`, not before.
- [ ] Run. FAIL. Implement.

#### Task C2.2: manager integration

**Files:** Modify `electron/lsp-manager.ts`. Test `test/unit/lsp-manager.test.ts` (fake clock already at :280).
**Interfaces:**
- Consumes `planEvictions`, `isEvictable`, `isDormant`, `DORMANT_MS`, `ResidencyServer`, `ServerWeight`, `LspServerHandle.exited` (signatures in Contracts).
- Produces `setWindowMinimized`, `EVICT_EXIT_WAIT_MS`, the `lsp:visible` dispatch case (`{ ok: true }`), private `requestLaunch` / `refreshResidency` / `residencySnapshot` / `evict`.
**Call sites changed:** `touch` (:570-582) is reduced to the idle-timer cancel. Its launch callers move to `requestLaunch`: `open` :458, `rehome` :769, `prepareRequest` :842, `waitLive` :876. `applyTrust` :380-382 also moves to `requestLaunch`. The crash-restart timer (`onExit` :679-682) keeps calling `launch` directly.
**Steps:**
- [ ] Failing tests (AC-C2 manager half), with fake handles + fake clock:
  - invisible open does not call `startServer`; a later `lsp:visible` with that path does; visible-then-open launches;
  - a request on an invisible doc launches, including with a cached resolve;
  - **absent binary and restricted (untrusted) launches evict nothing** (the budget is full of hidden evictable servers; `stop` is never called);
  - **Trust with only hidden docs launches nothing**; showing a doc afterwards launches;
  - **window dropped mid-launch → no spawn** (`resolveBinary` deferred; `dropWebContents` before it settles; `startServer` never called, the record ends `stopped`);
  - third heavy launch: `stop()` of the LRU, then its `exited`, then `startServer` (assert order). With `exited` never resolving, the launch proceeds after `EVICT_EXIT_WAIT_MS` and logs once;
  - **evictee re-checked**: it becomes visible between plan and stop, so it is not stopped and the launch goes over budget (soft cap);
  - **evictee visible at the end of its stop → relaunched**: it becomes visible while `stop()` is pending, so a second `startServer` follows;
  - the evictee keeps its docs: re-visible relaunches and replays didOpen with the latest unsaved text (AC-C3 unit half);
  - hidden < 60 s is not evicted, so a soft-cap launch happens, logged once;
  - in-flight is not evicted;
  - dormancy stops after `DORMANT_MS` hidden and idle; `change` re-arms it; dormancy of a server whose doc becomes visible at the end of the stop relaunches it;
  - union across two clients; `dropWebContents` drops that client's set and its minimized entry; a minimized client counts as empty; restore re-wakes;
  - two concurrent launches over the cap evict exactly one (`launchQueue`).
- [ ] Run. FAIL. Implement per "Manager residency invariants (C2)". Existing manager tests that open and expect a launch now send `lsp:visible` first. That follows D7 and is not a weakened test. Any test whose assertion changes meaning is called out in the slice report.

### Slice C3: renderer visibility

**Check:** `npx vitest run test/unit/lsp-sync.test.ts` green; `npm run verify:quick`.
**Claims:** `webview/lsp-sync.ts`, `webview/app.tsx`.

#### Task C3.1

**Files:**
- Modify `webview/lsp-sync.ts`: add `setLspVisible`.
- Modify `webview/app.tsx`: a `useEffect` on `visibleFilePaths` (:1678-1688) calls `setLspVisible([...visibleFilePaths])`. No `document.visibilityState` gating (see Spec staleness).
- Test `test/unit/lsp-sync.test.ts`.
**Steps:**
- [ ] Failing tests:
  - 'setLspVisible sends only on change': `['/a','/b']` then `['/b','/a']` gives one `lsp:visible`; `[]` gives a second.
  - 'a refused send is retried': `lspInvoke` resolves `{ok:false}` (or rejects) for `['/a']`, so a second `setLspVisible(['/a'])` sends again.
- [ ] Run. FAIL. Implement.

### Slice C4: residency e2e + CI + existing-scenario adaptation

**Check:**
- remote `npm run e2e:remote -- lsp-residency lsp-residency-replay lsp-residency-launch go-lsp csharp-lsp csharp-lsp-idle mf-files python-lsp rust-lsp clangd-lsp lsp-trust-multi lsp-missing-servers` all PASS.
- Then `npm run verify`.
**Claims:** `.github/workflows/e2e.yml`, `test/e2e/timings.seed.json`.

#### Task C4.1: adapt raw-open scenarios

**Files:** Modify `test/e2e/go-lsp.e2e.mjs` (`openGoDoc` :154), plus `csharp-lsp.e2e.mjs`, `csharp-lsp-idle.e2e.mjs` and `mf-files.e2e.mjs` wherever they send `lsp:open` without showing the tab.
**Steps:** After each raw `lsp:open`, send `lsp:request {op:'documentSymbol', version}` at the same version. That is the request wake (spec §2.6), and the scenario then waits for `ready` as before. Grep `type: 'lsp:open'` across `test/e2e/` to find every site.

#### Task C4.2: scenarios

| Scenario | ACs | Installs |
|---|---|---|
| `lsp-residency` | C1. Show `.rs` (t0). Show `.cpp` (t1; `.rs` hidden from t1). Wait to t1 + 61 s. Open `.cs` from the `.cpp` tab. Assert: `.rs` evicted (LRU, hidden 61 s); `.cpp` kept (hidden ~1 s, hysteresis); csharp-ls starts; and at every 250 ms sample from t0 to the end, **never more than 2 heavy server pids alive** (snapshot pids + `process.kill(pid, 0)` on each recorded heavy pid, so an evictee still exiting counts) | rust, clangd, csharp |
| `lsp-residency-replay` | C3. The same three-step setup reaches the `.rs`-evicted state. Then edit the `.rs` tab unsaved (rename the called fn at the call and the definition), show it, and F12: rust-analyzer relaunches (evicting clangd, hidden > 60 s by then) and lands on the edited target | rust, clangd, csharp |
| `lsp-residency-launch` | C5: session with `.py` + `.rs` tabs and the Terminal tab active. Relaunch the app: for 5 s the snapshot holds no live python/rust record. Click the `.py` tab: python reaches `starting` within 10 s | python, rust |

Seeds: `lsp-residency: 130`, `lsp-residency-replay: 170`, `lsp-residency-launch: 60`. All under 200 s. The fixture/setup steps shared by the two residency scenarios live in `test/e2e/lsp-fixture.mjs` (C4 appends `reachRustEvicted(page, dirs, log)`). Do not shorten the 60 s hysteresis via any hook.

#### Task C4.3: CI conditions

**Files:** Modify `.github/workflows/e2e.yml`. Add `' lsp-residency '` and `' lsp-residency-replay '` to the rust, clangd, setup-dotnet and csharp-ls step conditions. Add `' lsp-residency-launch '` to the python and rust conditions. Add the seeds to `timings.seed.json`.

## Execution order

```
S0 (one executor) ──▶ ┬─ Lane A  (A1→A2→A3→A4→A5)          ───────────────────────────────┐
                      └─ Lane B  (B1→B2→B3→B4→B5→B6) ──▶ Lane C (C1→C2→C3→C4, one executor) ┴─▶ conductor: verify + e2e:remote --full
```

- A and B branch from the S0 SHA. Every lane runs `npm run verify` before handback.
- The conductor merges A and B in either order; their file sets are disjoint.
- C branches from the tree with B merged. A may still be running: C touches no A file.
- Integration gate: `npm run verify` + `npm run e2e:remote -- --full`.

## Verification

- Per task: the named `npx vitest run <file>` red, then green.
- Per slice: its Check, plus `npm run verify:quick`.
- Per lane, before handback: `npm run verify` (exit code read directly, never piped) and the lane's remote scenarios.
- Merged tree: `npm run verify` + `npm run e2e:remote -- --full`. Manually: `npm run text-fit` once for the trust prompt at 5 servers (spec §10).

## Deviation rule

If a task's assumption turns out wrong, that task **stops**, and fixing the misaligned piece
becomes the work. Examples: a line number has moved, a locked signature doesn't fit, a scenario
can't fit 200 s, `lspManager` is out of scope at window creation, or basedpyright ignores a
non-`.py` URI (A9). Never use a shim, a second copy, a special case, a widened type, a fallback,
a test-only hook, or a narrowed check. The report leads with the fix that keeps the locked
decision. One case has a spec-sanctioned outcome: if A9 fails, the extensionless-Python
navigation sub-case moves to a non-goal (spec §12 A9). That is a reported outcome, not a silent
skip.

## Decisions Needed

- [normal] Minimized-window detection is host-side `BrowserWindow` `minimize`/`restore`, not the renderer's `document.visibilityState`. The latter is `hidden` for every e2e window (`show:false`, `electron/main.ts:987`) and for occluded windows. Default taken: host-side.
- [normal] Scenario set differs from spec §7: added `lsp-trust-multi` (B2 + B9 need all three servers installed in one shard), and split residency into `lsp-residency` (C1), `lsp-residency-replay` (C3) and `lsp-residency-launch` (C5), keeping each under the 200 s deadline. Default taken: as planned.
- [resolved by conductor, rev 2] Eviction awaits the evictee's process exit (≤ 2 s, then proceed + log). The shared root watch is deferred.
- [normal] AC-B7's didOpen-id half and AC-B8's "no didOpen" are asserted by unit and by snapshot, not by host log. The host logs no didOpen. Default taken: no new logging.
- [normal] CI pins: basedpyright 1.40.2, Rust toolchain 1.98.1 + rust-analyzer component, clangd from the image's LLVM 20.1.8 with a `choco install llvm --version=20.1.8` fallback. Default taken: as listed. Bump only with a remote run.
