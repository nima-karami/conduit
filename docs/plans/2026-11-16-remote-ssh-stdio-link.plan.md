# Remote over SSH, slice 2: stdio link (CON-37) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.2 steps 1, 5–7; §5.5; §8; RS-D3, RS-D8) **Tier:** FULL
**Gates:** `docs/runs/2026-11-16-CON-35/gates.md` (stdio byte-transparent over sshd; dead link in 16–18 s; MaxSessions 10)

## Goal
A controller A holds a CON-27 link to a remote server B whose bytes travel over `ssh … node main.js --link-stdio`.
On B, a per-start secret proves that the bridge came over SSH. The same secret closes C2 to other users (RS-D8).

## Architecture
The CON-27 link code already uses only stream methods. `openConnection` and `adopt` take a plain `Duplex`,
so TLS (parked, RS-D3) and the ssh child's stdio feed the same code.

- **A side.** An ssh link is a `LinkRecord` with `transport: 'ssh'`. The link manager's dial loop gets its stream
  from an injected `sshDial`, which spawns the system `ssh` with a fixed argv.
- **B side.** `main.js --link-stdio` is a bridge. It reads B's per-start secret, connects to B's local **link
  endpoint** (a user-only socket or pipe beside C2), writes one preamble frame carrying the secret, then pipes
  stdin/stdout. The server checks the preamble before any link frame. A good preamble hands the stream to
  `manager.acceptStream`, which pins the controller from its hello. A bad one is audited and dropped.
- **C2.** C2 needs the same secret: `hello.auth` must hold it before any method other than `hello` runs.

## Data flow
```
A: link.sshAdd (C2) ─► manager.addSshPeer(ssh) ─► deps.sshDial(ssh) ─► spawn ssh -T … -- target 'node' 'main.js' '--link-stdio' '--user-data' '<dir>'
                                                     │ child.stdin/stdout = Duplex
B: sshd ─► bridge (server/lifecycle/link-stdio-bridge.ts)
           1 read <userData>/server-secret (0600)
           2 connect names.linkEndpoint
           3 write frame {t:'bridge',v:1,secret}
           4 pipe stdin→sock, sock→stdout; exit when either side ends
B: stdio-link endpoint (server/network/stdio-link-endpoint.ts)
           read ONE frame (≤1 KiB) → timingSafeEqual(secret) ─ no → audit 'bridge-refused', destroy
                                                           └ yes → manager.acceptStream(sock)
both: openConnection(Duplex) → hello → identity pin → messaging/monitor/view/drive as CON-27
down: ssh child exit = stream 'close' → link down → redial with CON-27 backoff (A only)
```

## Settled decisions — do not re-litigate
- RS-D1: a Conduit server over SSH stdio. RS-D3: CON-27 pairing/TLS stay parked; frames, outbox, monitor, view
  and drive are reused. RS-D8: C2 is hardened in MVP (current user only, no remote clients).
- §4.2.1 ssh argv is fixed, with the target after `--`. A target starting with `-` is refused. The argv never
  carries `StrictHostKeyChecking=no` or `accept-new`. Every prompt becomes a typed failure.
- §4.2.5: SSH's host key authenticates the machine. Hello's server key is pinned per ssh peer, and a changed key
  is `identity-changed`.
- §4.2.7: `owner`/`owner.ack` frames are refused on ssh links.
- §5.5: nothing listens on a non-loopback interface. No SSH secret is stored. No forwarding.

## Technical decisions this plan makes
1. **One secret, two gates.** `<userData>/server-secret` holds a 32-byte random value as base64url. The server
   rewrites it at every start, atomically (temp file plus rename), with mode 0600. On Windows it sits in the
   user's userData (`%APPDATA%`), which is user-only by default. This is the RS-D8 hardening, and it works on
   Windows, where Node can't set a pipe DACL. The posix C2 and link sockets are also `chmod 0600` right after
   `listen`, as defence in depth.
2. **C2 `hello` stays frozen and auth-free in its result,** so version negotiation (app older or newer) still
   works across versions. `hello.auth` (the reserved field) carries the secret, and a match marks the peer
   authed. Every other method on an un-authed peer returns `RpcFault('refused', 'auth required')`. An old app
   talking to a new server learns its order, then gets refused (see Decisions Needed).
3. **A separate link endpoint,** not a mode of C2: `names.linkEndpoint` = `<userData>/conduit-link.sock`, falling
   back to `<tmpdir>/conduit-link-<instance>.sock` past 100 bytes (the same rule as C2), or
   `\\.\pipe\conduit-link-<instance>` on Windows. It is started by `createNetwork` only (network on), and stopped
   with it. The server records the endpoint it listens on in `<userData>/link-endpoint` after listen and removes it on stop; the bridge reads that record and never derives a path, since sshd's TMPDIR can differ from the app's.
4. **`Duplex`, not a new socket type.** `openConnection(sock: Duplex, …)` and `adopt(p, sock: Duplex, …)`.
   `listener.ts` keeps `tls.TLSSocket` for its TLS-only calls and passes the socket on as a `Duplex`.
5. **ssh peers are `LinkRecord`s** with `transport: 'ssh'` plus `ssh: SshEndpoint | null`:
   - A side: `ssh` = how to dial B.
   - B side: `ssh = null`. B never dials, it only accepts.
   - For ssh records, `cert`, `fingerprint` and `addresses` are empty; `ownerKey` = the peer hello's at creation
     and is not compared (ssh links carry no owner semantics); `ownerTransfer = null`.
   - `trustedCerts()` skips ssh records.
   - A record without `transport` parses as `'tls'`, so existing `links.json` files keep working.
6. **Pin on first use.** A's `addSshPeer` dials, takes `machineId` and `serverKey` from B's hello, and stores the
   record. B's `acceptStream` does the same for the controller: the preamble proved SSH access. An existing
   record whose `serverKey` differs gives `identity-changed`, and nothing crosses. A TLS record for the same
   `machineId` gives `identity-conflict` (one transport per peer while TLS is parked).
7. **Remote command (Linux remotes in this slice).**
   - The argv is `[node, mainJs, '--link-stdio', '--user-data', userData]`, joined with POSIX single quotes.
   - An element containing NUL, `\n` or `\r` is refused.
   - Windows quoting arrives with the shell-family probe in slice 3. The `SshEndpoint` fields come from slice 3's
     probe; here the caller supplies them.
8. **ControlPath** `<dir>/%C`. Measured on the Linux VM (review of CON-37 T2.2, `scratchpad/lanes/review-t22.md`):
   a 49-byte dir binds and a 50-byte dir fails with `unix_listener: path … too long`. OpenSSH binds
   `<ControlPath>.<16 chars>` before it renames into place, so the expanded ControlPath (dir + 41) must be at most 90 bytes.
   - `controlDir` picks the first candidate that fits (bytes, not characters):
     (a) `<userData>/ssh`;
     (b) `<XDG_RUNTIME_DIR>/conduit-ssh-<instance>`, only when `XDG_RUNTIME_DIR` is set and absolute;
     (c) `<tmpdir>/conduit-ssh-<uid>-<instance>`. The uid keeps another local user from pre-creating the name.
   - If none fits, `controlDir` returns `null` and the dial fails with `{ code: 'ssh_failed', detail: 'control_dir_too_long' }`.
   - The dir is created with mode 0700. An existing dir is trusted only after `lstat`: it must be a directory (not a
     symlink), owned by `process.getuid()`, with no group or other bits. Otherwise the dial fails with
     `control_dir_unsafe` and ssh is never spawned. The check is posix-only: Windows has no getuid.
   - Why: ssh's mux client does not check who owns the socket it connects to, so a dir another local user pre-created would
     receive our link's stdio.
   - gates.md G6 showed that a long scratch path fails `unix_listener: path … too long`.
9. **Bridge failures are typed.** The bridge exits 3 after writing one stderr line, `conduit-bridge: <code>`, with
   `code ∈ no_secret | no_server | refused`. The dialer maps those lines and ssh's own stderr to `SshFailure`.
10. **Interim producer:** C2 `link.sshAdd { ssh }` → `manager.addSshPeer`. Slice 4's machine registry and
    `connect_machine` call the same manager method. This slice adds no MCP tool or UI.

## Spec staleness
- "behind the network flag" (§10): **no flag exists** (grep of `src/`, `server/`, `electron/`; the only gate is
  `identity.json` from a newer build making `network = null`, `server/services.ts:242-262`). Here, the link
  endpoint runs whenever the network runs. A typed flag stays the proposal in
  `docs/specs/2026-11-07-feature-flags.md`.
- §2.1 "C2 … M28 exposure": confirmed. No chmod and no auth exist today (`server/transport/pipe.ts:87-119`,
  `server/compose.ts:126-143`).

## Global constraints
- Gate: `npm run verify` (exit code captured directly). Inner loop: `npx vitest run <files>`. CI is ubuntu, so unit
  tests must not depend on win32 behaviour. Keep path logic pure, and test win32 shapes with injected
  `platform`/`path.win32`, as `src/instance-names.ts` does.
- Placement: pure logic in `src/network/*.ts` and `src/contracts/*.ts`, IO in `server/network/*.ts` and
  `server/lifecycle/*.ts`. Names are kebab-case files and camelCase functions; types are PascalCase.
- Comments explain WHY only. No `as any`, no `@ts-ignore`, no swallowed errors (every catch logs or returns a
  typed failure). Spawn git only via `runGitBin`; ssh is spawned only in `server/network/ssh-dialer.ts`.
- Never kill processes by name. No GUI.

## Out of scope
- Bootstrap, the probe, install and Windows remote quoting (slice 3).
- The machine registry, ControlMaster lifecycle UI, the needs-person pane and MCP tools (slice 4).
- `call` frames and principal scoping (slice 5). The spec's S2 criterion "a `call` names another principal" is
  proven in slice 5.
- Pairing/TLS changes. A Windows pipe DACL or `PIPE_REJECT_REMOTE_CLIENTS` (unmeasured; Decisions Needed).

## Contracts
`src/contracts/ssh-link.ts` (new; committed by the orchestrator before lanes start, so the parallel lanes share it):
```ts
export interface SshEndpoint { target: string; node: string; mainJs: string; userData: string }
export type SshNeedsPersonReason = 'host_key_unknown' | 'host_key_changed' | 'passphrase' | 'password' | 'mfa';
export type SshFailure =
  | { code: 'ssh_needs_person'; reason: SshNeedsPersonReason }
  | { code: 'ssh_unreachable'; detail: string }
  | { code: 'ssh_auth_failed' }
  | { code: 'bridge_no_server' } | { code: 'bridge_no_secret' } | { code: 'bridge_refused' }
  | { code: 'ssh_failed'; detail: string };
export interface SshDialed { stream: import('node:stream').Duplex; failure(): Promise<SshFailure | null> }
export type SshDial = (ssh: SshEndpoint) => SshDialed;
export const BRIDGE_PREAMBLE_MAX_BYTES = 1024;
export interface BridgePreamble { t: 'bridge'; v: 1; secret: string }
export const BRIDGE_EXIT_CODE = 3;
export type BridgeFailureCode = 'no_secret' | 'no_server' | 'refused';
export type AddSshPeerResult =
  | { ok: true; machineId: string }
  | { ok: false; error: SshFailure | { code: 'identity-changed' } | { code: 'identity-conflict' } | { code: 'bad-hello' } | { code: 'incompatible' } | { code: 'timeout' } };
```
The rest are owned by the task that first needs them (pinned here so the lanes agree). `src/network/link-file.ts` `LinkRecord` gains (T2.1) `transport: 'tls' | 'ssh'` and `ssh: SshEndpoint | null`.
`parseLinksFile` defaults a missing `transport` to `'tls'` and a missing `ssh` to `null`, and validates `ssh` as
four non-empty strings when present.
`src/contracts/server-protocol.ts` `ServerMethods` gains (T3.3)
`'link.sshAdd': { params: { ssh: SshEndpoint }; result: AddSshPeerResult }`, and the `hello.auth` doc comment
changes to "the per-start secret from `<userData>/server-secret`; required before any other method" (T1.1).
`src/contracts/session-identity.ts` `InstanceNames` gains `linkEndpoint: string` (T3.1).

## Producer/consumer map
| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| C2 requires `hello.auth` | `server/compose.ts` | `electron/server-client.ts` (via `electron/server-lifecycle.ts` deps), `server/lifecycle/stop-all.ts`, every e2e C2 client (`test/e2e/*.mjs` that send `hello`), `test/unit/fake-c2-server.ts` users, `test/unit/server-shell-transport.test.ts`, `test/unit/server-lifecycle.test.ts` | both: T1.2 enumerates by `grep -rln "'hello'" electron server test` |
| `server-secret` file | `server/lifecycle/server-secret.ts` (server start, `server/main.ts`) | `src/server-secret.ts` readers: C2 clients and the bridge | both |
| `LinkRecord.transport/ssh` | `link-store` (pairing writes `'tls'`; `addSshPeer`/`acceptStream` write `'ssh'`) | `link-manager` dial loop, `trustedCerts`, `server/network/c2.ts` `link.list` output, `remote-directory` | both; `link.list` output adds `transport` (renderer has no consumer yet: no Machines UI ships, CON-27 D-H1) |
| `openConnection` param type | `link-connection.ts` | `link-manager.ts` adopt/accept, `test/unit/network-link-connection.test.ts` | both |
| Link endpoint socket | `stdio-link-endpoint.ts` | the bridge | both |
| ssh child exit → link down | `ssh-dialer.ts` (stream close) | `link-connection.ts` `close` handler → manager `onClose` → existing backoff | both (existing consumer unchanged; measured: `link-connection.ts:172` treats `close` as down) |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/contracts/ssh-link.ts` | create (orchestrator) | ssh link types and constants above |
| `src/server-secret.ts` | create | `SERVER_SECRET_FILE = 'server-secret'`; `readServerSecret(userData: string): string \| null` (sync read, trimmed, `null` on ENOENT; other errors throw) |
| `server/lifecycle/server-secret.ts` | create | `writeServerSecret(userData: string): string` (random 32 B base64url, temp + rename, mode 0600, returns it) |
| `server/main.ts` | modify | write the secret before `transport.listen`; pass it to compose; `--link-stdio` mode dispatch (T3.3) |
| `server/compose.ts` | modify | `hello.auth` check, `peer.authed`, refuse un-authed methods |
| `server/transport/pipe.ts` | modify | posix `chmod 0600` after listen |
| `electron/server-client.ts`, `electron/server-lifecycle.ts`, `electron/main.ts` | modify | read the secret at each hello and send it as `auth` |
| `server/lifecycle/stop-all.ts` | modify | send `auth` |
| `test/e2e/c2-auth.mjs` | create | `c2Auth(userData)` → secret for e2e C2 clients |
| `test/e2e/*.mjs` (C2 hello senders) | modify | send `auth` via `c2Auth` |
| `src/instance-names.ts` | modify | `linkEndpoint` (rule in decision 3) |
| `src/network/link-file.ts` | modify | `transport`, `ssh` fields and parsing |
| `server/network/link-store.ts` | modify | ssh records: `addSsh(record)`, `trustedCerts` skips ssh |
| `server/network/link-connection.ts` | modify | `sock: Duplex` |
| `server/network/link-manager.ts` | modify | `Duplex` adopt; `acceptStream`; `addSshPeer`; dial loop branches on `transport`; refuse `owner` frames on ssh |
| `server/network/listener.ts` | modify | pass `TLSSocket` on as `Duplex` (type only) |
| `src/network/ssh-argv.ts` | create | `posixQuote`, `sshArgv`, `controlDir`, `classifySshFailure` (pure) |
| `server/network/ssh-dialer.ts` | create | `createSshDial(o: { sshPath: string; controlDir: string \| null; log }): SshDial` |
| `server/network/audit-log.ts` | modify | `AuditKind` gains `'bridge.refused'` (T3.1) |
| `server/network/stdio-link-endpoint.ts` | create | `listenStdioLink(o): Promise<{ close(): Promise<void> }>` (preamble check, audit, hand-off) |
| `server/lifecycle/link-stdio-bridge.ts` | create | `runLinkStdioBridge(o): Promise<number>` (exit code) |
| `server/network/index.ts` | modify | wire `createSshDial`, `listenStdioLink`, `acceptStream` |
| `server/network/c2.ts` | modify | `link.sshAdd` |
| `test/e2e/fixtures/fake-ssh.cjs` | create | test-only ssh stand-in: drops the options, parses the POSIX-quoted remote command, spawns it locally with stdio inherited, echoes ssh-like failures on demand via `FAKE_SSH_FAIL=<stderr text>` |
| `test/e2e/net-ssh-link.e2e.mjs` | create | two real servers; A adds B over fake-ssh; message → kill bridge → exactly-once after redial; secret-less client refused |
| tests listed per task | create/modify | |

## Scripts
1. `test/e2e/fixtures/fake-ssh.cjs` (above). It replaces a real sshd in unit and e2e tests. Real sshd is proven by the
   orchestrator's VM smoke (Verification).
2. `test/e2e/c2-auth.mjs`: one helper instead of repeating secret reading in about 12 e2e files.

## Slices

### Slice 1: C2 per-start secret (RS-D8)
**Check:** `npx vitest run test/unit/server-secret.test.ts test/unit/server-compose-auth.test.ts test/unit/server-shell-transport.test.ts test/unit/server-lifecycle.test.ts`. `npm run verify` green. e2e `server-standalone` passes remotely.
**Parallel groups:** Serial: T1.1 → T1.2 (T1.2 edits every C2 client).
**Claims:** `server/main.ts`, `server/compose.ts`, `src/contracts/server-protocol.ts` (doc comment only)

#### Task 1.1: secret file + compose gate
**Files:** create `src/server-secret.ts`, `server/lifecycle/server-secret.ts`; modify `server/main.ts` (write the
secret before `transport.listen`, pass it into the compose options as `secret: string`), `server/compose.ts`,
`server/transport/pipe.ts` (posix `fs.chmodSync(endpoint, 0o600)` after a successful listen; Windows skipped
with a one-line why-comment pointing to this plan's decision 1). Tests: `test/unit/server-secret.test.ts`,
`test/unit/server-compose-auth.test.ts`.
**Interfaces:** Produces `readServerSecret(userData: string): string | null`, `writeServerSecret(userData: string): string`, `SERVER_SECRET_FILE`.
**Steps:**
- [ ] Failing test 'writeServerSecret writes 0600 and a new value each start' (posix only via `it.skipIf(process.platform === 'win32')`): mode `& 0o777 === 0o600`, and two calls return different values that read back equal to the file.
- [ ] Failing test 'a method before an authed hello is refused': a hello with no or a wrong `auth` returns its result, and the next `events.subscribe` throws `RpcFault` with kind `'refused'`, message `'auth required'`.
- [ ] Failing test 'hello with the right auth unlocks methods'.
- [ ] Failing test 'the posix C2 socket is 0600 after listen' (skip on win32).
- [ ] Implement. Compare with `crypto.timingSafeEqual` on equal-length buffers (a length mismatch is false).

#### Task 1.2: every C2 client sends auth
**Files:** modify `electron/server-client.ts` (the `hello` params get `auth` from a new constructor option
`readSecret: () => string | null`), `electron/server-lifecycle.ts` (the deps pass `readSecret`), `electron/main.ts`
(`readSecret: () => readServerSecret(userData)` at both `ServerClient` sites, L1199-1202 and L2588-2594),
`server/lifecycle/stop-all.ts`; create `test/e2e/c2-auth.mjs` (`export function c2Auth(userData)` → string; throws
if missing); modify every e2e/unit C2 hello sender found by
`grep -rln "method: 'hello'\|'hello'," test/e2e test/unit electron server`. Expected e2e list (verify it):
asks-no-window, agents-survive-update, auto-resume-helpers, attention-footer-helpers, auto-resume-server-restart,
hc-client, harness-server-teardown, server-runtime, net-helpers, net-monitor, server-restart-supervisor,
server-standalone. Fake servers in unit tests (`test/unit/fake-c2-server.ts`) accept and ignore `auth`.
**Call sites:** every `new ServerClient(` and every raw `'hello'` request in the grep above.
**Steps:**
- [ ] Failing test in `test/unit/server-client.test.ts`: 'hello carries auth from readSecret'.
- [ ] Update all senders; run the touched unit files; `npm run verify`.

### Slice 2: link over any Duplex, ssh records, ssh dial (A side) — parallel
**Check:** `npx vitest run test/unit/network-link-connection.test.ts test/unit/network-link-manager.test.ts test/unit/network-link-file.test.ts test/unit/network-link-store.test.ts test/unit/ssh-argv.test.ts test/unit/ssh-dialer.test.ts`
**Parallel groups:** G1: T2.1 · G2: T2.2 (file-disjoint: G1 = `server/network/link-*.ts`, `listener.ts`, `src/network/link-file.ts` and their tests; G2 = `src/network/ssh-argv.ts`, `server/network/ssh-dialer.ts`, `test/e2e/fixtures/fake-ssh.cjs` and their tests)
**Claims:** none (shared entries are in slice 3)

#### Task 2.1: Duplex link, ssh records, acceptStream, addSshPeer
**Files:** modify `server/network/link-connection.ts`, `server/network/link-manager.ts`,
`server/network/link-store.ts`, `server/network/listener.ts`, `src/network/link-file.ts`; tests
`test/unit/network-link-connection.test.ts`, `test/unit/network-link-manager.test.ts`,
`test/unit/network-link-file.test.ts`, `test/unit/network-link-store.test.ts`.
**Interfaces:**
- Consumes (from `src/contracts/ssh-link.ts`): `SshEndpoint`, `SshDial`, `SshDialed`, `AddSshPeerResult`.
- Produces:
  - `openConnection(sock: Duplex, opts: ConnectionOptions)` (otherwise unchanged).
  - `createLinkManager` deps gain `sshDial: SshDial`.
  - `LinkManager` gains `acceptStream(stream: Duplex): void` and `addSshPeer(ssh: SshEndpoint): Promise<AddSshPeerResult>`.
  - `LinkStore` gains `addSsh(r: { machineId: string; serverKey: string; ownerKey: string | null; name: string; ssh: SshEndpoint | null }): LinkRecord`. It assigns `linkId`, `createdAt`, default `capabilities` (the own defaults pairing uses), `trust: 'own'`, `transport: 'ssh'`, empty `cert`/`fingerprint`/`addresses`, and `ownerTransfer: null`.
**Behaviour:**
- `dialPeer` with `record.transport === 'ssh'`:
  - `record.ssh === null` → never dial;
  - else `const d = deps.sshDial(record.ssh)`, then `adopt(p, d.stream, own machineId)`;
  - if the stream closes before the hello, log `await d.failure()` at debug and back off as for a TLS dial failure.
- `adopt` skips the `ownerMatches` comparison for ssh records, and never calls `sendOwnerKey` for them.
- `onFrame`: an `owner`/`owner.ack` frame on an ssh peer is logged at warn and dropped.
- `acceptStream`:
  - `openConnection` → hello;
  - look up by `machineId`:
    - none → `store.addSsh({…, ssh: null})` and adopt;
    - ssh record with the same `serverKey` → adopt;
    - different `serverKey` → `close('identity-changed')` plus an `identity-changed` event;
    - TLS record → `close('identity-conflict')`.
- `addSshPeer`:
  - dial;
  - if a record for `hello.machineId` already exists, apply the same identity rules;
  - else `store.addSsh({…, ssh})`;
  - return `{ok:true, machineId}`;
  - failures map as follows: a stream close before hello → `{ok:false, error: await failure() ?? {code:'ssh_failed', detail:'closed'}}`; `ConnectionError` `incompatible|bad-hello|timeout` → that code.
- Concurrent `addSshPeer` calls for the same target share one promise.
**Steps (red first):**
- [ ] 'openConnection runs a full hello over a PassThrough duplex pair': build the pair with two `PassThrough`s and `Duplex.from({readable, writable})`.
- [ ] 'links.json without transport parses as tls'; 'ssh record round-trips with ssh null'.
- [ ] 'trustedCerts skips ssh records'.
- [ ] 'acceptStream pins a new controller and a second stream with another serverKey is identity-changed'.
- [ ] 'addSshPeer pins B, and a stream close redials with backoff using the injected sshDial' (fake `sshDial` returns duplex pairs wired to a second in-test manager's `acceptStream`).
- [ ] 'an owner frame on an ssh link is dropped'.
- [ ] 'messages queued while an ssh link is down are delivered once after redial': reuse the existing messaging test pattern in `test/unit/network-link-manager.test.ts`, or the service test if messaging is composed there.

#### Task 2.2: ssh argv, failure classification, dialer
**Files:** create `src/network/ssh-argv.ts`, `server/network/ssh-dialer.ts`, `test/e2e/fixtures/fake-ssh.cjs`; tests
`test/unit/ssh-argv.test.ts`, `test/unit/ssh-dialer.test.ts`.
**Interfaces (produces):**
- `posixQuote(args: readonly string[]): string | null`: each arg is wrapped in `'…'` with `'` → `'\''`, joined by spaces. Returns `null` if any arg contains `\0`, `\n` or `\r`.
- `sshArgv(o: { target: string; controlPath: string; remote: readonly string[] }): string[] | { error: 'bad_target' | 'bad_arg' }`. It returns exactly `['-T','-o','BatchMode=yes','-o','ClearAllForwardings=yes','-o','ForwardAgent=no','-o','ForwardX11=no','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=3','-o','ControlMaster=auto','-o',`ControlPath=${controlPath}`,'-o','ControlPersist=60','--',target, posixQuote(remote)]`. The target must match `^[A-Za-z0-9._@:%+\[\]-]+$` and not start with `-`, else `bad_target` (ssh expands `%h`/`%r` in a user's ProxyCommand, CVE-2023-51385; review of T2.2).
- `controlDir(o: { userData: string; tmpdir: string; xdgRuntimeDir: string | undefined; uid: number; instance: string; join: (...p: string[]) => string }): string | null`: decision 8 (the first candidate that fits, or `null`).
- `classifySshFailure(exitCode: number | null, stderr: string): SshFailure | null`, matched case-insensitively:
  - `conduit-bridge: no_server|no_secret|refused` → `bridge_*`;
  - `REMOTE HOST IDENTIFICATION HAS CHANGED` → needs_person `host_key_changed`;
  - `Host key verification failed` or `No .* host key is known` → `host_key_unknown`;
  - `passphrase` → `passphrase`;
  - `password` → `password`;
  - `verification code|one-time|keyboard-interactive` → `mfa`;
  - `Permission denied \([a-z,-]+\)` → `ssh_auth_failed` (anchored, so a remote EACCES line is not an auth failure; checked before `password`, see deviations);
  - `Could not resolve hostname|Connection timed out|Connection refused|No route to host|Network is unreachable|Timeout, server .* not responding` → `ssh_unreachable` with `detail` = the matched line;
  - otherwise a non-zero exit → `ssh_failed` with the last stderr line (≤200 chars);
  - exit 0 with empty stderr → `null`.
- `createSshDial(o: { sshPath: string; controlDir: string | null; log: NetLog; sshArgsPrefix?: string[] }): SshDial` (`controlDir` is `controlDir()`'s result; `null` fails every dial with `control_dir_too_long`):
  - `mkdirSync(controlDir, {recursive:true, mode:0o700})`;
  - `spawn(sshPath, argv, { stdio: ['pipe','pipe','pipe'], windowsHide: true })`;
  - stderr is collected up to 16 KiB;
  - `stream = Duplex.from({ readable: child.stdout, writable: child.stdin })`;
  - `failure()` resolves after exit with `classifySshFailure(code, stderr)`;
  - destroying the stream kills the child by its PID (`child.kill()`);
  - a `bad_target`/`bad_arg` argv returns an already-destroyed stream whose `failure()` gives `{code:'ssh_failed', detail:'bad_target'|'bad_arg'}`.
**Steps (red first):** exact-argv test; quoting tests including `'` and a space; refusal of a leading `-`; one
classifier row per pattern; dialer test with `sshPath = process.execPath` and `fake-ssh.cjs` giving `createSshDial` an optional `sshArgsPrefix: string[]` used ONLY by tests) running a remote `cat`-like node
one-liner: bytes round-trip; `FAKE_SSH_FAIL='Host key verification failed.'` → `failure()` gives
`host_key_unknown`.

### Slice 3: bridge, link endpoint, wiring, C2 `link.sshAdd`, e2e
**Check:** `npx vitest run test/unit/stdio-link-endpoint.test.ts test/unit/link-stdio-bridge.test.ts test/unit/instance-names.test.ts test/unit/network-service.test.ts`. `npm run verify`. `npm run e2e:remote -- net-ssh-link` plus affected.
**Parallel groups:** Serial: T3.1 → T3.2 → T3.3 (shared entries).
**Claims:** `server/network/index.ts`, `server/network/c2.ts`, `server/main.ts`, `src/instance-names.ts`, `src/contracts/session-identity.ts`

#### Task 3.1: link endpoint
**Files:** modify `src/instance-names.ts` (`linkEndpoint`), `test/unit/instance-names.test.ts`; create
`server/network/stdio-link-endpoint.ts`, `test/unit/stdio-link-endpoint.test.ts`.
**Interfaces:**
- Produces `listenStdioLink(o: { endpoint: string; platform: NodeJS.Platform; secret: () => string; accept: (s: Duplex) => void; audit: AuditSink; log: NetLog }): Promise<{ close(): Promise<void> }>`.
- Behaviour:
  - `net.createServer` → listen → posix `chmod 0600`; stale posix socket handling as `PipeTransport.listen`.
  - On a connection: pause, then read with a `FrameDecoder(BRIDGE_PREAMBLE_MAX_BYTES)`. Accept exactly one valid `BridgePreamble` within 5 s.
  - Compare with timingSafeEqual. On a match, unshift any extra bytes read past the frame back into the socket (`sock.unshift`) before `accept(sock)`. Otherwise call `audit.record({ kind: 'bridge.refused', peer: null, detail: { reason } })` with `reason ∈ 'bad_secret' | 'bad_preamble' | 'timeout'`, then destroy. Add `'bridge.refused'` to `AuditKind` in `server/network/audit-log.ts` (this task owns that one-line edit).
**Steps:**
- [ ] 'a good preamble hands over the socket with the following bytes intact'.
- [ ] 'a wrong secret is audited and closed'.
- [ ] 'an oversize frame is bad_preamble'.
- [ ] 'silence is timeout' (fake timers).
- [ ] 'win32 names'.

#### Task 3.2: bridge mode
**Files:** create `server/lifecycle/link-stdio-bridge.ts`, `test/unit/link-stdio-bridge.test.ts`; modify
`server/main.ts` (when `--link-stdio` is present: `process.exitCode = await runLinkStdioBridge({...})`, and skip
everything else; `--user-data` is still required).
**Interfaces:**
- Produces `runLinkStdioBridge(o: { userData: string; stdin: Readable; stdout: Writable; stderr: Writable; connect?: (endpoint: string) => Duplex }): Promise<number>`; it reads the endpoint from `<userData>/link-endpoint` and exits 3 `no_server` when that record is missing.
- Exit codes:
  - `0` when either side ended cleanly;
  - `BRIDGE_EXIT_CODE` with `conduit-bridge: no_secret` (no file) or `no_server` (connect ENOENT/ECONNREFUSED);
  - `refused` if the endpoint closes before any byte comes back within 5 s of the preamble.
- stdout carries ONLY link bytes. Diagnostics go to stderr.
**Steps:**
- [ ] 'pipes bytes both ways after the preamble' (in-process endpoint from T3.1).
- [ ] 'no secret file → exit 3 + line'.
- [ ] 'no server → exit 3 + line'.

#### Task 3.3: wire it, C2 `link.sshAdd`, e2e
**Files:**
- modify `server/network/index.ts`:
  - `createLinkManager({…, sshDial: createSshDial({ sshPath: settings ssh path or 'ssh', controlDir: controlDir({...}), log })})`;
  - in `start()`, `listenStdioLink({ endpoint: names.linkEndpoint, secret, accept: (s) => manager.acceptStream(s), audit, log })` (the existing `audit` sink in `createNetwork`)`, closed in `stop()`.
  - Pass `names` and `secret` in from `server/services.ts`. That needs only a construction-argument change there, which is acceptable inside this task.
- modify `server/network/c2.ts` (`link.sshAdd` → `manager.addSshPeer(params.ssh)`; validate the four strings, else `RpcFault('invalid')`);
- `server/services.ts` (construction args only);
- create `test/e2e/net-ssh-link.e2e.mjs`, following `test/e2e/net-messaging.e2e.mjs` and `net-helpers.mjs` (`startServerPair`, `startAgent`, `callTool`). Phases:
  1. A `link.sshAdd` B with `ssh = { target: 'fake', node: process.execPath, mainJs: <B's main.js>, userData: B.userData }` and the ssh path set to fake-ssh. Assert `ok` and `link.list` on both sides shows `transport: 'ssh'`.
  2. An agent on A sends to an agent on B, and it is delivered.
  3. Kill the bridge child by PID (fake-ssh prints its child PID to stderr first: `fake-ssh: pid <n>`), send a message while down, and assert it is delivered exactly once after redial (`messages.log` count).
  4. A raw connection to B's link endpoint with a wrong secret is closed, and B's `network/audit.jsonl` has a `bridge.refused` line.
  5. A raw C2 client without auth is refused after hello.
- the ssh path setting: add `sshPath` to `src/settings.ts` only if a settings key is the established way for server options. Otherwise read the env `CONDUIT_SSH_PATH` (default `'ssh'`) in `createNetwork`. **Use the env**: §7 says the ssh path is configurable, but no settings UI ships in this slice. No CHANGELOG entry (nothing user-facing yet).
**Steps:** a red unit test in `test/unit/network-service.test.ts`: 'link.sshAdd links two services over fake-ssh and delivers a message' (two in-process services, fake-ssh). Then the e2e.

## Verification
- Per task: the named vitest files.
- Per lane: `npm run verify` (exit captured directly).
- After each merge to `CON-35-remote-ssh`: the orchestrator runs `npm run verify`.
- After slice 3: `npm run e2e:remote` (affected plus `net-ssh-link`).
- **Real sshd smoke (orchestrator, runtime proof):** on the local VM, copy `out/server/` and the vendored linux node to `~/conduit-smoke/`, start B's server there (`setsid -f node main.js --user-data ~/.conduit-smoke`), then run A locally with `link.sshAdd { target: 'vm' }` through the VM ssh config (`CONDUIT_SSH_PATH` wrapper adding `-F <cfg>`). Then check the following, with every ssh call under `timeout`:
  - the message is delivered;
  - pausing the VM (SIGSTOP of its QEMU PID, trap SIGCONT) gives link down within about 20 s and exactly-once delivery after resume;
  - a bridge run by hand with the secret file removed exits 3 with `no_secret`.

## Deviation rule
If a task's assumption turns out wrong, that task **stops**, and fixing the misaligned piece becomes the work.
Examples: `openConnection` turns out to need a TLS-only member, or messaging isn't keyed by `machineId`. Never a
shim, a second copy, a special case, a widened type or a fallback routed around it. The report leads with the fix
that keeps the locked decision.

## Decisions Needed
- [normal] Old app with a new server: hello still answers (so the app learns it is older), then every other method
  is `refused: auth required`. Default taken. A downgrade was already unsupported (`appOlder` → `downgrade` state).
- [high] Windows: whether Node's named pipes reject SMB (remote) clients is unmeasured. The secret makes a remote
  client useless past `hello`, which leaks only versions/instance/pid. Default taken: the secret is the gate.
  Measure on the Windows box (G-gate list). Add a DACL only if the owner wants versions hidden too.
- [normal] The ssh path is the env `CONDUIT_SSH_PATH` until the Machines settings exist (slice 4/6). Default taken.
- [normal] A known ssh target that answers with a new machine id (a reinstall or an impostor) is `identity-changed`, and the old pin stays (spec §6). Re-pinning needs the owner's explicit action, which lands in slice 4. Default taken: refuse.
