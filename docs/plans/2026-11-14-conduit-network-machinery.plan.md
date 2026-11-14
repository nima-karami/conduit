# Conduit network machinery (CON-27, NET MVP) — implementation plan

**Spec:** `docs/specs/2026-11-14-conduit-network.md` (NET v4, §13 locked) **Tier:** FULL
**Test environment:** `docs/runs/2026-11-14-CON-27/test-env.md` (Tier 1 = two servers on this host,
Tier 2 = local Linux VM, Tier 3 = Linux ↔ Windows over Tailscale in CI)

## Goal
Two Conduit servers owned by one person pair with three words and a fingerprint, then hold an
authenticated, encrypted link over direct TCP. Over an `own` link:
- agents see each other in `list_sessions` and message each other exactly once across drops;
- each side sees the other's sessions, attention, limit state and read-only asks;
- with `drive` on, a person can watch and type into a remote pane.

Either side can revoke by hand. Everything is reachable over C2 and proven by e2e driving two real
servers. **No renderer UI ships here** (see D-H1). The C2 surface and events are what the Machines UI
card will consume.

## Settled decisions — do not re-litigate
- NET-D1 one mechanism, `own` only in MVP. NET-D2 the owner key is copied at pairing, and a new
  machine never confirms itself into `own`. NET-D3 direct TCP to a user-given address, no relay.
  NET-D4 own defaults: `messaging` + `monitor` on, `drive` off. NET-D18 `drive` in MVP, opt-in per
  link. NET-D19 Kiro is out until measured. Guest decisions stay open, and no guest code ships.
- Design defaults NET-D9 (the peer server relays pane output), D10 (read-only viewers never resize;
  the last typer sets the size), D13 and D14 (a machine id behind names) apply.
- From the lead: Haiku lanes write code and unit tests only. I own the plan, reviews, gates and merges.
  At most 3 lanes at once. Red-first tests. `code-review` per lane. Merge one at a time and run
  `npm run verify` after each. No listener beyond loopback without telling the lead first.

## Technical decisions this plan makes
1. **Placement.** Pure logic goes in `src/network/*.ts` (unit-tested, no IO), like
   `src/conduit-mcp/*`. IO goes in `server/network/*.ts`, a sibling of `server/mcp`. The wire
   contract goes in `src/contracts/link-protocol.ts`. One composer, `server/network/index.ts`
   (`createNetwork`), owns the wiring. `server/services.ts` only constructs, starts, stops and
   dispatches to it, which keeps that shared claim thin.
2. **Identity.** `<userData>/network/identity.json` (versioned, written atomically, mode 0600) holds:
   - an Ed25519 **server key**, generated with `node:crypto` on first start;
   - an **owner key**, Ed25519 or `null` until the first own pairing.

   **Machine id** = `m-` + the first 8 hex chars of SHA-256(raw 32-byte server public key). That
   keeps the 8-hex format `src/conduit-mcp/machine-id.ts` already uses; the spec's `m-7f3a9c` is only
   an example. It replaces the provisional random id. That id is only ever *written* into
   `RequestRecord.origin`/`.machine` (`src/conduit-mcp/request-queue.ts:253,260,294,301`) and is
   never compared, so old records stay valid. CON-21 isn't on `main`, so no release carries the old
   file.
3. **Pairing: numeric comparison (lead's ruling on D-H2). No PAKE and no new dependency.** The human
   confirming that the two fingerprints match *is* the authentication. The three words are only a
   short-lived rendezvous and rate-limit token.
   - Pairing runs inside a TLS 1.3 connection (decision 4) where each side presents its own server
     key. During an open window, the opener accepts a certificate it doesn't know.
   - **Commit, then reveal.** This is the Bluetooth SSP numeric-comparison pattern: without it, a
     man in the middle could grind keys or nonces until the short fingerprint collides.
     1. The joiner sends `pair.hello {code, commit = SHA-256("conduit-pair-commit-v1" ‖ pkB ‖ nB)}`.
     2. The opener checks the code, then sends `pair.nonce {nA}`.
     3. The joiner reveals `pair.reveal {nB}`.
     4. The opener checks the commitment against the joiner's certificate key.

     `nA` and `nB` are 32 random bytes each. `pkA` and `pkB` are the raw Ed25519 keys taken from each
     side's TLS certificate.
   - Fingerprint = the first 32 bits of SHA-256("conduit-pair-v1" ‖ pkA ‖ pkB ‖ nA ‖ nB), shown
     `XXXX-XXXX` (uppercase hex). With the commitment, an active attacker gets one guess per window,
     a 2⁻³² chance, and the window burns after that one attempt.
   - A wrong code burns the window. A second connection during a window gets `pair.fail used`.
   - After both people confirm, the rest goes over the same TLS connection: `pair.id` (names,
     addresses, owner public key), `pair.accept`, and `pair.owner`, the owner-key copy under
     decision 10. TLS gives it confidentiality, and the confirmed fingerprint rules out a
     man in the middle.
   - **Residual risk (stated for the lead):** if a person confirms without comparing, an attacker on
     the path during the window can pair. CPace would have stopped that, because the code was the
     secret. Mitigations: one attempt per window, the 10-minute window, and the fingerprint shown
     on both screens.
   - All pairing crypto and auth code is written by me, not a lane.
4. **Link channel: TLS 1.3 with mutual auth, self-signed certificates pinned to the paired Ed25519
   server keys** (lead's ruling on D-H3). `node:tls` with `minVersion/maxVersion: 'TLSv1.3'`,
   `requestCert: true`, `rejectUnauthorized: false` and `checkServerIdentity: () => undefined`. There
   is no CA.
   - Authorization is our own pin check on `secureConnection` / `secureConnect`, **before any frame
     is read**: the raw key in `getPeerX509Certificate().publicKey` must equal the link's stored
     `serverKey`. TLS 1.3's CertificateVerify proves the peer holds that private key.
   - Each server builds its certificate at startup from its server key, with a minimal DER encoder
     (`src/network/self-signed-cert.ts`, no dependency; I write it):
     - X.509 v3, serial 1, issuer and subject `CN=<machineId>`, valid 2000-01-01 to 9999-12-31;
     - the SPKI is `publicKey.export({type:'spki', format:'der'})`;
     - signed with `crypto.sign(null, tbs, privateKey)`.
   - **Measured on this host** (Node 26, OpenSSL 3.5.9): `TLSv1.3 TLS_AES_256_GCM_SHA384`. The
     right key passes the pin. A third key is destroyed before any data. Node's own
     `X509Certificate.verify` accepts the self-signature.
   - Bundled Node 24.18 on Windows is proven by Slice 4's remote e2e.
   - `linkId` = `l_` + the first 16 base32 chars of SHA-256 over the two server keys, sorted. It's an
     identifier, not a secret.
5. **One TCP port per server.** Every connection is TLS 1.3, and the pin decides what it is:
   - a certificate key that matches a link (or a tombstone) → a link connection;
   - an unknown key while a pairing window is open → a pairing attempt;
   - anything else → destroyed after the handshake, before any read.

   The listener is off until the first pairing window opens. After that it runs while any link
   exists or a window is open.

   Bind is the server setting `networkBindHost`:
   - `'auto'` (default) binds each loopback, RFC 1918, 100.64.0.0/10 (tailnet CGNAT) and fc00::/7
     address, and never a public one;
   - an explicit IP binds that address only.

   Port is `networkPort` (default `47391`; `0` = ephemeral, used by tests). Every test binds
   `127.0.0.1` (see D-H4).
6. **Dialing.** Both sides dial a down link with backoff 1 s → 2 → 4 … capped at 60 s, ±20 % jitter.
   An address edit dials at once. When two connections are up for one link, the one dialed by the
   **lower machine id** stays, and the other gets `bye {reason:'duplicate'}`.
7. **Frames.** Each frame is a 4-byte big-endian length followed by UTF-8 JSON, capped at 16 MiB.
   Pane bytes travel as base64. The first frame each way is `hello`.
   - Heartbeat: a `ping` every 5 s. No frame for 10 s → `degraded`; for 20 s, or a socket close →
     `down`.
   - A protocol major mismatch → `incompatible` and close.
   - A missing feature name → that capability shows "doesn't support".
8. **Exactly once.** The sender keeps a persisted FIFO outbox per link and resends unacked entries in
   order on every `up`. The receiver dedupes by message id **against the message store itself**: it
   appends the message (fsynced log), then acks; a resend of a stored id acks without appending. So
   dedupe is durable in the same write as delivery, and store retention (30 days) far outlasts the
   outbox TTL (24 h).
   - Message ids keep today's format. `MessageRecord` gains `origin?: string`, the origin machine id;
     absent means local.
   - Receipts (`noticed`/`read`) flow back best effort and idempotently. While a link is down they
     are held in memory and sent on `up`; a server restart may drop one, which is accepted and
     documented.
9. **Names (NET-D14).** Every server has a **self-name** (`networkSelfName`, default the OS
   hostname). It travels in `hello`, and a peer's name is the peer's self-name. Own servers share
   names because each machine names itself. A clash on a server (two peers with one name, or a peer
   named like self) shows the colliding peers as `<name> (m-xxxxxxxx)` and keeps working. Addresses
   are canonical `handle@m-xxxxxxxx`, shown as `handle@<name>`, and tools accept both.
10. **Own-key rule at pairing.** The window opener is A; the joiner is B.

    | A owner key | B owner key | Result |
    |---|---|---|
    | K | none | After both confirm, A sends K to B. A is the existing own machine whose confirm counts |
    | none | K | B sends K to A after both confirm (B is the existing machine) |
    | none | none | A generates K at confirm time and sends it (first-ever link) |
    | K | K | Fine (re-pair) |
    | K1 | K2 | Refused before the fingerprint step: "These machines have different owners" |
11. **Revoke.** On the revoking side, at once:
    - close the connection;
    - delete the live record and keep a **tombstone** `{linkId, machineId, serverKey, revokedAt}` for
      30 days;
    - mark that link's outbox entries `undelivered`;
    - emit `network.changed`;
    - write an audit entry.

    The tombstone exists only so a later dial from the peer can finish TLS and receive
    `revoked` + close. No other frame is ever accepted on it. The peer then shows `revoked` (by
    peer). POL grant deletion and REQ withdrawal hook in when CON-24 lands (D-H5).
12. **Remote human framing.** A message from `you@m-x` over an own link frames as from the human
    **only while that link has `drive` on**. Otherwise it frames as from another agent. Drive
    already lets that person type anything, so this adds no power (D-N3).
13. **Pane relay.** The serving server takes its own hc `observe` attach per remote view (new
    `TerminalRuntime.observe`). The first paint is hc's synthetic full screen; after that it relays
    `data`/`size`/`end`. If the link's socket write buffer passes 4 MiB, it drops the view's attach
    and re-attaches (a fresh paint), which is also how a reconnect resyncs. `windowsPty` comes from
    the serving host (`currentWindowsPty()`, `src/windows-pty-info.ts`) and travels in the view's
    open reply.
14. **Drive.** `drive.input` and `drive.resize` from a peer go through the same function C2
    `term.input` uses: a new `applyHumanInput` extracted in `server/services.ts`, using the session's
    current generation. Drops while down are never replayed, because the viewer never queues them.
    Remote open and close of sessions is MVP `drive` **only as a human action over C2**
    (`remote.open`/`remote.close`). NET §4.1 defines `drive` as "(a **human** at a GUI): type into,
    resize, open and close remote sessions". Agent-initiated `open_session`/`close_session` on a peer
    is `orchestrate` (§4.1 table, R21), which is v1. No MCP tool reaches a peer here except the
    `messaging` tools and `wait_sessions` (`monitor`).
15. **Audit.** `<userData>/network/audit.jsonl`, append-only, one JSON object per line
    `{v:1, at, kind, peer, ...}`. It records link events (pairing outcome, state changes to and from
    down/incompatible/identity-changed, revoke, capability change) and crossings (message
    in/out/refused, drive session start/stop). Keystrokes are never logged. It sits behind an
    `AuditSink` port, so POL's Activity store can replace the file later (D-H5).

## Architecture

```
            linux-box (A)                                     win-box (B)
 app ──C2── server ──────────────────── TCP (TLS 1.3, pinned keys) ─── server ──C2── app
            │ services.ts                                       │
            │  └ createNetwork ── listener ◄── pin: link key → link / unknown + window → pairing
            │      ├ pairing-service  (commit/reveal, fingerprint, confirm, persist)
            │      ├ link-manager ── link-connection (hello, ping, frames) ×N
            │      ├ outbox-store ──► msg frames ──►  inbound ──► mcp port ─► store.append ─► notifier
            │      │          ◄── ack / receipt ◄──── receipts ◄── store.onChange
            │      ├ monitor-publisher ──► snapshot frames ──► remote-directory (peer)
            │      ├ view-relay  ◄── view.data ◄── runtime.observe (hc observe attach)
            │      ├ drive  ──► drive.input ──► applyHumanInput ─► PtyWriter
            │      └ audit-log (network/audit.jsonl)
            │ mcp host ── network port: remoteEntries / resolve / enqueue / waitReading
            └ C2: pairing.* link.* remote.*   events: network.changed remote.data remote.state
```

State: `network/identity.json`, `network/links.json` (links + tombstones), `network/outbox.json`,
`network/audit.jsonl`. All are server-owned and versioned through `SERVER_FILE_VERSION`, except
audit, which carries `v` per line like `messages.log`.

## Contracts (the seams lanes share — pin exactly)

### `src/contracts/link-protocol.ts` (Slice 1)
```ts
export const LINK_PROTOCOL = { major: 1, minor: 0 } as const;
export const LINK_FEATURES = ['messaging', 'monitor', 'drive', 'view'] as const;
export type LinkFeature = (typeof LINK_FEATURES)[number];
export const LINK_FRAME_MAX_BYTES = 16 * 1024 * 1024;
export const LINK_PING_MS = 5_000; export const LINK_DEGRADED_MS = 10_000; export const LINK_DOWN_MS = 20_000;
export const PAIRING_WINDOW_MS = 10 * 60_000; export const PAIRING_WARN_MS = 60_000;
export const OUTBOX_TTL_MS = 24 * 60 * 60_000;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_NETWORK_PORT = 47391;

export type Capability = 'messaging' | 'monitor' | 'drive';
export type Capabilities = Record<Capability, boolean>;
export const OWN_DEFAULT_CAPABILITIES: Capabilities = { messaging: true, monitor: true, drive: false };
export type LinkState = 'connecting' | 'up' | 'degraded' | 'down' | 'incompatible' | 'identity-changed' | 'revoked';

export interface HelloFrame { t: 'hello'; protocol: { major: number; minor: number }; machineId: string;
  serverKey: string /* base64 raw */; ownerKey: string | null; selfName: string; features: LinkFeature[];
  capabilities: Capabilities /* what the sender enables on this link */ }
export type LinkFrame =
  | HelloFrame
  | { t: 'ping' } | { t: 'pong' }
  | { t: 'bye'; reason: 'duplicate' | 'revoked' | 'incompatible' | 'shutdown' }
  | { t: 'revoked' }
  | { t: 'caps'; capabilities: Capabilities }
  | { t: 'msg'; message: WireMessage }
  | { t: 'ack'; messageId: string; recipients: WireRecipientOutcome[] }
  | { t: 'receipt'; messageId: string; handle: string; status: 'noticed' | 'read' | 'undelivered' }
  | { t: 'snapshot'; snapshot: MonitorSnapshot }
  | { t: 'view.open'; viewId: string; sessionId: string }
  | { t: 'view.opened'; viewId: string; firstPaint: string /* base64 */; size: { cols: number; rows: number };
      windowsPty: { backend: 'conpty'; buildNumber: number } | null }
  | { t: 'view.data'; viewId: string; data: string /* base64 */ }
  | { t: 'view.size'; viewId: string; size: { cols: number; rows: number } }
  | { t: 'view.end'; viewId: string; reason: 'exited' | 'closed' | 'refused' | 'resync'; exitCode: number | null }
  | { t: 'view.close'; viewId: string }
  | { t: 'drive.input'; sessionId: string; data: string }
  | { t: 'drive.resize'; sessionId: string; cols: number; rows: number }
  | { t: 'drive.open'; requestId: string; agentId: string; folder: string }
  | { t: 'drive.close'; requestId: string; sessionId: string }
  | { t: 'drive.result'; requestId: string; ok: boolean; sessionId: string | null; error: string | null };

export interface WireMessage { messageId: string; threadId: string; from: string /* handle on origin */;
  to: string[] /* local handles on the receiver */; subject: string; kind: MessageKind; priority: Priority;
  sentAt: string; body: string; attachments: { name: string; mime: string; data: string /* base64 */ }[] }
export interface WireRecipientOutcome { handle: string; status: 'delivered' | 'refused';
  reason: 'unknown_session' | 'not_messageable' | 'messaging_off' | 'capability_off' | 'thread_limit' | 'rate_limited' | null }

export interface MonitorSession { sessionId: string; handle: string | null; label: string; agent: string;
  presence: Presence; messaging: 'connected' | 'unavailable'; messageable: boolean; notices: 'typed' | 'pull';
  home: string; roots: string[]; attention: SessionAttentionFacts; completions: number;
  limit: { state: string; resumeAt: string | null } | null; status: 'running' | 'exited' | 'stale' }
export interface MonitorSnapshot { seq: number; sessions: MonitorSession[];
  requests: { requestId: string; type: string; summary: string; sessionHandle: string | null; createdAt: string }[];
  youUnread: number; ownerPresence: 'here' | 'away';
  agents: { id: string; label: string }[] /* for drive.open */ }

export function parseLinkFrame(raw: unknown): LinkFrame | null; // strict: unknown t or bad field → null
```
(`MessageKind`, `Priority`, `Presence` come from `src/conduit-mcp/types.ts`.
`SessionAttentionFacts` comes from `src/types.ts`.)

### Server settings (Slice 4 claims `src/contracts/server-protocol.ts` and `src/settings.ts`)
`networkBindHost: string` (default `'auto'`), `networkPort: number` (default `47391`),
`networkSelfName: string` (default `''`, which means the OS hostname, resolved by the server). All
three go in `SERVER_SETTINGS_KEYS` and `DEFAULT_SETTINGS`.

### C2 additions (`ServerMethods`, Slice 4 / 6 / 7 / 8)
```ts
'pairing.start':   { params: {}; result: { pairingId: string; code: [string, string, string]; addresses: string[]; expiresAt: string } };
'pairing.join':    { params: { code: string; address: string }; result: { pairingId: string } };
'pairing.confirm': { params: { pairingId: string }; result: {} };
'pairing.decline': { params: { pairingId: string }; result: {} };
'pairing.cancel':  { params: { pairingId: string }; result: {} };
'link.list':       { params: {}; result: NetworkState };
'link.revoke':     { params: { machineId: string }; result: {} };
'link.setCapability': { params: { machineId: string; capability: Capability; on: boolean }; result: {} };
'link.setAddresses':  { params: { machineId: string; addresses: string[] }; result: {} };
'remote.attach':   { params: { machineId: string; sessionId: string }; result: { viewId: string; firstPaint: string; size: TermGeometry; windowsPty: WindowsPtyInfo | null; drive: boolean } }; // Slice 7
'remote.detach':   { params: { viewId: string }; result: {} };                                   // Slice 7
'remote.input':    { params: { machineId: string; sessionId: string; data: string }; result: {} }; // Slice 8
'remote.resize':   { params: { machineId: string; sessionId: string; cols: number; rows: number }; result: {} }; // Slice 8
'remote.open':     { params: { machineId: string; agentId: string; folder: string }; result: { sessionId: string } }; // Slice 8
'remote.close':    { params: { machineId: string; sessionId: string }; result: {} };              // Slice 8
```
`ServerEvents` gains:
- `'network.changed': NetworkState`
- `'remote.data': { viewId: string; data: string /* utf8 */ }` (Slice 7)
- `'remote.state': { viewId: string; state: 'live' | 'frozen' | 'exited' | 'resyncing'; since: string | null; size: TermGeometry | null }` (Slice 7)

`ServerErrorKind` gains `'peer_unreachable' | 'peer_revoked' | 'capability_off' | 'pairing_failed'`
(also added to `SERVER_ERROR_KINDS`, `electron/server-client.ts:47-54`). `remote.data` and
`remote.state` go through `emitTo` to the attaching connection only.

```ts
// src/contracts/server-protocol.ts
export interface NetworkLinkView { machineId: string; name: string; trust: 'own'; state: LinkState; since: string;
  addresses: string[]; capabilities: Capabilities /* mine */; peerCapabilities: Capabilities;
  unsupported: LinkFeature[]; fingerprint: string; lastActivity: string | null; snapshot: MonitorSnapshot | null }
export interface NetworkPairingView { pairingId: string; role: 'opener' | 'joiner';
  state: 'showing-code' | 'connecting' | 'confirm' | 'waiting-peer' | 'done' | 'expired' | 'used' | 'mismatch' | 'declined' | 'unreachable' | 'different-owner' | 'cancelled';
  code: [string, string, string] | null; expiresAt: string | null; fingerprint: string | null; peerName: string | null; peerMachineId: string | null }
export interface NetworkState { machineId: string; selfName: string; listening: string[]; links: NetworkLinkView[]; pairing: NetworkPairingView | null }
```
The app forwards `network.changed` to renderers as `{ type: 'network:state'; state: NetworkState }`
(`src/protocol.ts` `HostToWebview`). The Machines UI card consumes it.

### MCP ↔ network ports (Slice 5)
```ts
// src/conduit-mcp/remote-routing.ts
export interface RemoteEntry extends DirectoryEntry { address: string /* handle@m-… */; display: string /* handle@name */;
  machineId: string; machine: string; trust: 'own'; link: 'up' | 'degraded' | 'down' }
export type RemoteResolution =
  | { kind: 'local'; handle: Handle }
  | { kind: 'remote'; entry: RemoteEntry }
  | { kind: 'unknown'; hint: string };              // unlinked machine id/name or unknown remote handle
export interface RemoteRecipientOutcome { address: string; status: 'queued' | 'refused';
  reason: 'peer_unreachable' | 'peer_revoked' | 'peer_incompatible' | 'capability_off' | null }
/** Implemented by server/network; read by the mcp host and tools. */
export interface NetworkPort {
  remoteEntries(): RemoteEntry[];
  resolve(target: string): RemoteResolution;       // 'x', 'x@m-…', 'x@name'
  enqueue(msg: MessageRecord, recipients: RemoteEntry[]): RemoteRecipientOutcome[];
  waitReading(address: string): WaitReading | 'unreachable' | null;
  onChange(listener: () => void): () => void;
}
/** Implemented by the mcp host; read by server/network. */
export interface McpNetworkPort {
  localDirectory(): DirectoryEntry[];
  hasMessage(messageId: string): boolean;
  deliverInbound(msg: MessageRecord & { origin: string }, blobs: { name: string; mime: string; bytes: Buffer }[],
    framedAsHuman: boolean): WireRecipientOutcome[];
  setRemoteStatus(messageId: string, address: string, status: RecipientStatus): void;
  onLocalStatus(listener: (messageId: string, handle: Handle, status: RecipientStatus, origin: string) => void): () => void;
  youUnread(): number; ownerPresence(): 'here' | 'away';
  requestsSummary(): MonitorSnapshot['requests'];
}
export function mergeDirectory(local: DirectoryEntry[], remote: RemoteEntry[]): (DirectoryEntry | RemoteEntry)[];
export const isRemote = (e: DirectoryEntry | RemoteEntry): e is RemoteEntry => 'address' in e;
```
`ToolErrorCode` gains `peer_unreachable` (also added to `RETRYABLE`), `peer_incompatible`,
`peer_unsupported`, `peer_revoked`, `refused`. `ListSessionsOutput` rows gain optional
`machine`, `machine_id`, `address`, `trust`, `link`, present on remote rows only.

### Runtime observe (Slice 7)
```ts
// src/contracts/terminal-runtime.ts, TerminalRuntime
observe(sessionId: string, events: { data(data: string): void; size(size: TermGeometry): void; end(reason: 'exited' | 'closed', exitCode: number | null): void }):
  Promise<{ firstPaint: string; size: TermGeometry; close(): void } | null>; // null = no live terminal
```

## File map
**Create**
- `src/contracts/link-protocol.ts` — wire frames, constants, `parseLinkFrame`.
- `src/network/identity-file.ts` — `IdentityFile` type, parse/serialize, `deriveMachineId(publicKeyRaw: Buffer): string`.
- `src/network/link-file.ts` — `LinkRecord`, `Tombstone`, `LinksFile`, parse/serialize.
- `src/network/pairing-words.ts` — the BIP-39 English list (2048 words), generated (script S-1).
- `src/network/pairing-code.ts` — `newCode(rand): [string,string,string]`, `normalizeCode(input): string | null`.
- `src/network/self-signed-cert.ts` — minimal DER X.509 builder for the server key's certificate; `rawEd25519`.
- `src/network/pairing-transcript.ts` — `fingerprint(...)`, `deriveLinkSecrets(...)`.
- `src/network/pairing-protocol.ts` — pure opener/joiner state machines (`step(state, input) → {state, out}`).
- `src/network/frame-codec.ts` — length-prefixed frame encoder and incremental decoder.
- `src/network/link-state.ts` — pure link state machine + backoff schedule + duplicate tie-break.
- `src/network/addresses.ts` — `parseAddress`, `formatAddress`, `displayName` (clash suffix).
- `src/network/bind-addresses.ts` — `bindableAddresses(interfaces, setting): string[]` (the `'auto'` rule).
- `src/network/outbox.ts` — pure outbox model (enqueue / onUp batch / ack / expire / revoke) + file parse/serialize.
- `src/network/remote-directory.ts` — per-link snapshots → `RemoteEntry[]`, `resolve`, `waitReading`.
- `src/conduit-mcp/remote-routing.ts` — the ports above + `mergeDirectory`, `isRemote`.
- `server/network/index.ts` — `createNetwork(deps): NetworkService`.
- `server/network/identity.ts` — load or create identity on disk.
- `server/network/link-store.ts` — persisted links + tombstones.
- `server/network/listener.ts` — TLS 1.3 listener, pin classification.
- `server/network/link-connection.ts` — one framed TLS connection: hello, ping, frame dispatch.
- `server/network/link-manager.ts` — dialing, states, duplicates, revoke, capability frames.
- `server/network/pairing-service.ts` — windows, the commit/reveal exchange over a pairing TLS connection, confirm, persist.
- `server/network/outbox-store.ts` — persisted outbox + delivery loop.
- `server/network/inbound.ts` — `msg` → checks → `McpNetworkPort.deliverInbound` → `ack`; receipts out.
- `server/network/monitor-publisher.ts` — builds and pushes `snapshot` (coalesced 500 ms).
- `server/network/view-relay.ts` — serving-side views (`runtime.observe`) and viewer-side forwarding to C2.
- `server/network/drive.ts` — inbound `drive.*` and outbound `remote.input/resize/open/close`.
- `server/network/audit-log.ts` — `AuditSink` + JSONL implementation.
- `server/network/c2.ts` — C2 handlers for `pairing.*`, `link.*`, `remote.*`.
- `test/e2e/net-helpers.mjs` — `startServerPair()`, `pairServers()`, `LinkProxy` (pause / cut / resume / cutBeforeAck).
- `test/e2e/net-pairing.e2e.mjs`, `net-messaging.e2e.mjs`, `net-monitor.e2e.mjs`, `net-drive.e2e.mjs`.
- `tools/gen-pairing-words.mjs` — script S-1.
- `tools/vm-peer.mjs` — Tier 2 VM helper (script S-2): `up | down | pause | resume | status`.

**Modify**
- `src/contracts/session-identity.ts` — `SERVER_FILE_VERSION`: add `network/identity.json: 1`,
  `network/links.json: 1`, `network/outbox.json: 1`; remove `conduit-mcp/machine-id.json`.
- `src/conduit-mcp/host.ts` — take `machineId` and `network?: NetworkPort` deps, expose
  `networkPort(): McpNetworkPort`, remote rows in `directory()`/`runWait`, `scheduleBroadcast` on
  `network.onChange`.
- `src/conduit-mcp/tools.ts` — remote recipients in `sendMessage`, remote rows in `listSessions`,
  remote `frameBody` relation.
- `src/conduit-mcp/types.ts` — `MessageRecord.origin?`, the new error codes, the
  `ListSessionsOutput` optional fields.
- `src/conduit-mcp/store.ts` — accept and keep `origin` on records; `has(messageId)`.
- `src/contracts/server-ports.ts` — `McpHostDeps` gains `machineId: string; network?: NetworkPort`.
- `src/contracts/terminal-runtime.ts`, `server/runtime/runtime.ts` — `observe`.
- `server/services.ts` — construct/start/stop `createNetwork`, `applyHumanInput`, dispatch hook.
- `server/mcp/index.ts` — pass `machineId`/`network` through.
- `src/contracts/server-protocol.ts`, `src/settings.ts`, `electron/server-client.ts`,
  `electron/server-events.ts`, `src/protocol.ts` — C2 + settings + forwarding (above).
- `THIRD_PARTY_NOTICES.txt` — the BIP-39 word list (BSD-2-Clause).
- `CHANGELOG.md` — Slice 9.

**Delete**
- `src/conduit-mcp/machine-id.ts` (+ its unit test, if any).

### Seams with CON-24 (agreed in writing with claude-21, lead CC'd, 2026-11-14)
1. **`src/contracts/remote-principal.ts`** is byte-identical on both branches: `Capability`,
   `Capabilities`, `RemotePrincipal {kind:'remote', handle, machineId, trust:'own'}`,
   `principalAddress`. `link-protocol.ts` re-exports `Capability`/`Capabilities` from it. POL's
   remote principal is `RemotePrincipal & { capabilities: Capabilities }`.
2. **Capability floor:** NET's inbound boundary is the gate. POL keeps floor (d) as a second check
   on the `capabilities` its composer fills from `NetworkPort.capabilitiesOf(machineId):
   Capabilities | null` (null or false → deny). NET adds `capabilitiesOf` to `NetworkPort` (Slice 5).
3. **`AuditSink`:** `record(e: AuditEvent)`, where `AuditEvent.kind` is the closed union
   `'pairing.linked' | 'pairing.failed' | 'link.state' | 'link.revoked' | 'link.capability' |
   'message.in' | 'message.out' | 'message.refused' | 'drive.start' | 'drive.stop' |
   'drive.refused'`, plus `peer: string | null` and `principal?: string`. It never carries a body or
   keystroke. Whichever branch merges second writes `activityAuditSink(log)` and swaps it into
   `createNetwork`'s deps.
4. **Revoke hook:** `NetworkService.onRevoked(listener: (machineId: string) => void): () => void`
   (Slice 4). Whichever branch lands second wires it to POL `peerRevoked(machineId)` and REQ
   withdrawal (`withdrawnBy: 'conduit'`, reason "link revoked").

## Producer / consumer scan
| Behaviour changed | Producer | Consumer | Plan touches |
|---|---|---|---|
| Machine id source | `server/network/identity.ts` (new) | `request-queue` via host deps (`host.ts:643`) | both: host gets `machineId` from deps, `loadMachineId` deleted (Slice 1 T1.3) |
| `MessageRecord.origin` | network inbound (`deliverInbound`) | store log parse (`store.ts:156` region), `frameBody`, `uiState` threads | both: store keeps it; the renderer ignores an unknown field (measured: `McpThreadSummary` doesn't carry records) |
| Remote rows in the directory | `remote-directory` via `NetworkPort` | `listSessions`, `sendMessage` resolution, `runWait`, `gateToolCall` reach ("listed sessions only", `host.ts:1176`) | all four, Slice 5. Control tools (`send_input`, …) must **refuse** remote rows: `orchestrate` is v1, so `resolve` returns remote only to messaging + wait paths |
| Recipient statuses for remote addresses | outbox acks/receipts → `setRemoteStatus` | the sender's `read_inbox`/thread views, `uiState` | both |
| `network.changed` | `server/network` | `electron/server-events.ts` → renderer `network:state` | producer + forwarder. The renderer consumer is the UI card (D-H1) |
| `remote.data`/`remote.state` | view-relay | e2e C2 client now; app `TerminalLinkFactory` remote later (UI card) | producer only, stated |
| Human input path | `applyHumanInput` (extracted) | C2 `term.input` (`server/services.ts:353-360`) and network drive | both; the C2 path's behaviour is unchanged (existing e2e `server-standalone` covers it) |
| New server settings | `DEFAULT_SETTINGS` | network listener; app settings mirror (ADR 0007 §10) | both; the mirror is generic over `SERVER_SETTINGS_KEYS` |
| Thread 20-message pause | store counts per thread | inbound refuses with `thread_limit` | both sides count, as each stores the crossing messages |

## Slices

Tier column: **1** = provable with two servers on this host (loopback); **2** = also run on the Linux
VM; **3** = needs Linux ↔ Windows (owner setup).

| # | Slice | Proven on | Check |
|---|---|---|---|
| 1 | Identity, link store, wire contract | 1 | unit |
| 2 | Pairing core (cert, transcript, protocol) | 1 | unit (incl. MITM simulation) |
| 3 | Frames, listener, link connection | 1 (+ Windows runner for TLS 1.3/Ed25519 on bundled Node) | unit with loopback sockets |
| 4 | Pairing service + link C2 + audit + revoke | 1 | `net-pairing` e2e |
| 5 | Remote directory + list_sessions + monitor snapshot | 1 | unit + `net-messaging` part A |
| 6 | Messaging exactly once | 1, 2 (real sleep) | `net-messaging` e2e |
| 7 | Pane relay (monitor) + remote waits | 1, 3 (ConPTY facts) | `net-monitor` e2e |
| 8 | Drive | 1, 3 (ConPTY resize) | `net-drive` e2e |
| 9 | Tier 2 run, CHANGELOG, run report | 2 | VM run log |

### Slice 1 — Identity, link store, wire contract
**Parallel groups:** G1: T1.1 · G2: T1.2 · Serial: T1.3

- **T1.1 `src/contracts/link-protocol.ts`** + `test/unit/link-protocol.test.ts`.
  - **Produces:** everything in the contract block above.
  - **Tests:** `parseLinkFrame` accepts one valid sample of every `t`; rejects an unknown `t`, a
    missing field, a wrong type, and extra keys (an extra key → null).
- **T1.2 `src/network/identity-file.ts`, `src/network/link-file.ts`** + tests.
  - **Produces:**
    ```ts
    export interface IdentityFile { version: 1; serverKey: { publicKey: string; privateKey: string } /* base64 DER spki/pkcs8 */; ownerKey: { publicKey: string; privateKey: string } | null }
    export function parseIdentityFile(text: string): { kind: 'ok'; file: IdentityFile } | { kind: 'newer' } | { kind: 'corrupt' };
    export function serializeIdentityFile(f: IdentityFile): string;
    export function deriveMachineId(publicKeyRaw: Buffer): string; // 'm-' + sha256 hex [0,8)
    export interface LinkRecord { linkId: string; machineId: string; serverKey: string; ownerKey: string; name: string;
      trust: 'own'; addresses: string[]; capabilities: Capabilities; fingerprint: string; createdAt: string }
    export interface Tombstone { linkId: string; machineId: string; serverKey: string; revokedAt: string }
    export interface LinksFile { version: 1; links: LinkRecord[]; tombstones: Tombstone[] }
    export function parseLinksFile(text: string, now: number): { kind: 'ok'; file: LinksFile } | { kind: 'newer' } | { kind: 'corrupt' }; // drops tombstones older than TOMBSTONE_TTL_MS
    export function serializeLinksFile(f: LinksFile): string;
    ```
  - Versions are judged with `judgePersistedVersion` (`src/contracts/session-identity.ts:207`).
  - **Tests:**
    - `deriveMachineId` of a fixed 32-byte key matches `/^m-[0-9a-f]{8}$/` and is stable;
    - a newer version → `newer`;
    - a missing field → `corrupt`;
    - a tombstone past its TTL is dropped.
- **T1.3 (serial; claims `src/contracts/session-identity.ts`, `src/conduit-mcp/host.ts`,
  `src/contracts/server-ports.ts`, `server/mcp/index.ts`, `server/services.ts`)**
  `server/network/identity.ts`:
  ```ts
  export interface Identity { machineId: string; serverPublicKey: KeyObject; serverPrivateKey: KeyObject;
    ownerKey: { publicKey: KeyObject; privateKey: KeyObject } | null; serverKeyRaw: Buffer }
  export function loadIdentity(dir: string /* <userData>/network */, io?: { read(p: string): string | null; write(p: string, s: string): void }): Identity | { error: 'newer' | 'corrupt' };
  export function setOwnerKey(dir: string, id: Identity, owner: { publicKey: KeyObject; privateKey: KeyObject }): Identity;
  ```
  - A missing file is created: Ed25519 via `generateKeyPairSync('ed25519')`, written by
    `atomicWriteFileSync`, then `chmodSync(0o600)` on POSIX.
  - `corrupt` → back the file up to `identity.corrupt.json` and create a new one, with a `log.error`.
  - `newer` → the server runs with networking off and logs it.
  - Delete `src/conduit-mcp/machine-id.ts` and its registry entry.
  - `McpHostDeps.machineId: string`. `createServices` loads the identity before `createMcp` and
    passes `machineId` down (`server/services.ts:194-257` → `server/mcp/index.ts` → host deps).
    `host.ts:643` reads `deps.machineId`. Every `createConduitMcpHost` call site in tests gets
    `machineId: 'm-00000000'`. Enumerate them with `grep -rn createConduitMcpHost test src server`.
  - **Tests:** `test/unit/network-identity.test.ts`:
    - creates once, then reloads the same id;
    - corrupt → backup + new id;
    - newer → error.
  - **Check:** `npm run verify:quick`, then `npm run verify`.

### Slice 2 — Pairing core (pure; crypto by me)
**Parallel groups:** G1: T2.2 (lane) · Serial (me): T2.4, T2.1, T2.3

- **T2.4 (me; claims `THIRD_PARTY_NOTICES.txt`):** run script S-1:
  `node tools/gen-pairing-words.mjs <bip39-english.txt> --sha256 <hex>`.
  - It refuses unless the file's SHA-256 equals the `--sha256` it's given and the file has 2048 lines.
  - I take the list from `bitcoin/bips` (`bip-0039/english.txt`) at a pinned commit and cross-check
    the hash against a second source before passing it.
  - It writes `src/network/pairing-words.ts` (`export const PAIRING_WORDS: readonly string[]`).
  - Add the BIP-39 notice (BSD-2-Clause).
  - No dependency is added.
- **T2.1 (me) `src/network/self-signed-cert.ts`** + `test/unit/self-signed-cert.test.ts`.
  - **Produces:**
    ```ts
    export function selfSignedCert(keys: { publicKey: KeyObject; privateKey: KeyObject }, commonName: string): string; // PEM, decision 4
    export function rawEd25519(publicKey: KeyObject): Buffer; // 32 bytes, from the SPKI DER tail
    ```
  - **Tests:**
    - `new X509Certificate(pem)` parses it;
    - `verify(publicKey)` is true;
    - the subject is `CN=<name>`;
    - `rawEd25519(x509.publicKey)` equals the key's own raw bytes;
    - two keys → different certificates;
    - a TLS 1.3 loopback handshake with two such certificates succeeds.
- **T2.2 (lane) `src/network/pairing-code.ts`** + tests.
  - **Produces:**
    ```ts
    export function newCode(rand: (n: number) => Uint8Array, words?: readonly string[]): [string, string, string]; // uniform: 11-bit chunks, default PAIRING_WORDS
    export function normalizeCode(input: string, words?: readonly string[]): string | null; // lowercase, whitespace/hyphen separated, each word in the list, exactly 3 → 'w1 w2 w3'
    ```
  - **Tests:**
    - `normalizeCode('  Apple-ZOO  ability ', fixture)` → `'apple zoo ability'`;
    - 2 words or an unknown word → null;
    - `newCode` with a fixed `rand` is deterministic and every word comes from the list.

    The tests use a 4-word fixture list, so the lane doesn't wait for T2.4.
- **T2.3 (me) `src/network/pairing-transcript.ts`, `src/network/pairing-protocol.ts`** + tests.
  - **Produces:**
    ```ts
    export function commitment(pkJoiner: Buffer, nonce: Buffer): Buffer;            // SHA-256('conduit-pair-commit-v1' ‖ pk ‖ n)
    export function fingerprint(pkOpener: Buffer, pkJoiner: Buffer, nOpener: Buffer, nJoiner: Buffer): string; // 'XXXX-XXXX'
    export function linkIdFor(a: Buffer, b: Buffer): string;                        // 'l_' + base32(sha256(sorted a‖b))[0,16)
    export type PairingMsg =   // all inside the pairing TLS connection
      | { t: 'pair.hello'; v: 1; code: string; commit: string }                     // joiner → opener
      | { t: 'pair.nonce'; nonce: string }                                          // opener → joiner
      | { t: 'pair.reveal'; nonce: string }                                         // joiner → opener
      | { t: 'pair.id'; machineId: string; ownerKey: string | null; selfName: string; addresses: string[]; protocol: { major: number; minor: number } } // each way, after the reveal
      | { t: 'pair.accept' } | { t: 'pair.decline' }
      | { t: 'pair.owner'; publicKey: string; privateKey: string }                  // the existing own machine → the other (decision 10)
      | { t: 'pair.fail'; reason: 'wrong-code' | 'bad-commit' | 'different-owner' | 'expired' | 'used' | 'incompatible' };
    export function openerStep(s: OpenerState, input: PairingInput): { state: OpenerState; out: PairingMsg[]; done?: PairingOutcome };
    export function joinerStep(s: JoinerState, input: PairingInput): { state: JoinerState; out: PairingMsg[]; done?: PairingOutcome };
    export type PairingInput = { kind: 'msg'; msg: PairingMsg } | { kind: 'confirm' } | { kind: 'decline' } | { kind: 'cancel' } | { kind: 'expire' };
    export type PairingOutcome =
      | { kind: 'linked'; peer: { machineId: string; serverKey: string; ownerKey: string; selfName: string; addresses: string[] }; linkId: string; fingerprint: string; ownerKeyToStore: { publicKey: string; privateKey: string } | null }
      | { kind: 'failed'; reason: 'wrong-code' | 'bad-commit' | 'different-owner' | 'declined' | 'expired' | 'used' | 'incompatible' | 'cancelled' };
    ```
  - Each state is created with its own raw key, the peer's raw key from the TLS certificate, its
    identity, the window's code (opener only) and `rand`.
  - The fingerprint becomes visible only after the reveal checks out. `pair.id` is exchanged right
    after it, so the different-owner check (decision 10) happens before anyone confirms.
  - **Tests:**
    - an in-memory happy path gives equal `linkId` and `fingerprint` on both sides;
    - a wrong code → `wrong-code`;
    - a reveal that doesn't match the commitment → `bad-commit`;
    - a MITM simulation, where the joiner's certificate key differs from the committed key →
      `bad-commit`;
    - every row of the owner-key table;
    - a decline on either side → `declined` on both;
    - an out-of-order message → `failed`.
  - **Check (slice):** `npm run verify:quick`, then `npm run verify`.

### Slice 3 — Frames, listener, link connection
**Parallel groups:** G1: T3.1 · G2: T3.2 · Serial: T3.3

- **T3.1 `src/network/frame-codec.ts`, `src/network/link-state.ts`** + tests.
  - **Produces:**
    ```ts
    export function encodeFrame(frame: LinkFrame | PairingMsg): Buffer;
    export class FrameDecoder { constructor(max: number); push(chunk: Buffer): { frames: unknown[]; error: 'too_large' | 'bad_json' | null } }
    export interface LinkStateMachine { state: LinkState; since: number }
    export function linkEvent(s: LinkStateMachine, e: { kind: 'dial' | 'up' | 'frame' | 'silence' | 'closed' | 'incompatible' | 'identity-changed' | 'revoked'; at: number; silentMs?: number }): LinkStateMachine;
    export function backoffMs(attempt: number, rand: () => number): number; // 1000·2^n capped 60000, ±20 %
    export function keepConnection(a: { dialerMachineId: string }, b: { dialerMachineId: string }): 'a' | 'b'; // lower dialer id wins
    ```
  - **Tests:**
    - a split frame across chunks;
    - two frames in one chunk;
    - an over-cap length → `too_large` before buffering;
    - `silence` at 10 s → degraded, at 20 s → down;
    - `revoked` is terminal (later events are ignored);
    - backoff bounds;
    - the tie-break.
- **T3.2 `src/network/bind-addresses.ts`, `src/network/addresses.ts`** + tests.
  - **Produces:**
    ```ts
    export function bindableAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, setting: string): string[]; // 'auto' rule of decision 5; explicit IP → [ip] if valid else []
    export function parseAddress(s: string): { handle: string; machine: string | null } | null; // 'x' | 'x@m-…' | 'x@name'
    export function formatAddress(handle: string, machineId: string): string;
    export function displayNames(peers: { machineId: string; name: string }[], selfName: string): Map<string, string>; // clash → 'name (m-…)'
    ```
  - **Tests:**
    - a public IPv4 is excluded;
    - 100.64.0.1 is included;
    - fd12::1 is included;
    - 127.0.0.1 is included;
    - an explicit `0.0.0.0` → `[]` (never all interfaces);
    - name clashes, including with self.
- **T3.3 (serial; me, as it holds the pin check) `server/network/listener.ts`,
  `server/network/link-connection.ts`** + tests `test/unit/network-link-connection.test.ts`, using
  real sockets on `127.0.0.1:0`.
  - **Produces:**
    ```ts
    export interface Listener { addresses(): string[]; close(): Promise<void> }
    export function listen(opts: { hosts: string[]; port: number; cert: string; key: string;
      classify(peerKeyRaw: Buffer): 'link' | 'pairing' | 'reject'; onLink(sock: tls.TLSSocket, peerKeyRaw: Buffer): void;
      onPairing(sock: tls.TLSSocket, peerKeyRaw: Buffer): void; log: NetLog }): Promise<Listener>;
    export function dial(opts: { address: string /* host:port */; cert: string; key: string; expectKeyRaw: Buffer | null /* null only for a pairing join */; timeoutMs: number }):
      Promise<{ sock: tls.TLSSocket; peerKeyRaw: Buffer }>; // rejects 'pin_mismatch' before any read
    export interface LinkConnection { send(f: LinkFrame): boolean /* false past 4 MiB buffered */; bufferedBytes(): number; close(reason: string): void; readonly peerHello: HelloFrame }
    export function openConnection(sock: tls.TLSSocket, opts: { hello: HelloFrame; onFrame(f: LinkFrame): void; onClose(why: string): void; now(): number; log: NetLog }): Promise<LinkConnection | { error: 'incompatible' | 'bad-hello' | 'timeout' }>;
    ```
  - TLS options are those of decision 4. The socket is paused until `classify` has run on
    `secureConnection`, and `reject` destroys it.
  - **Tests:**
    - a dial with the right pin exchanges hellos;
    - a server or client with an unpinned key → destroyed, and no frame is delivered;
    - an unknown key while `classify` → `'pairing'` reaches `onPairing`;
    - a hello with a different major → `incompatible` on both;
    - pings keep the link alive, and silence closes it (fake `now` and short constants through opts);
    - `send` returns false past the buffer cap.
  - **Check:** `npm run verify`. The `net-pairing` e2e in Slice 4 then proves TLS 1.3 + Ed25519 on the
    Windows runner's bundled Node.

### Slice 4 — Pairing service, link C2, audit, revoke (Tier 1 e2e)
**Parallel groups:** G1: T4.1 · G2: T4.2 · Serial: T4.3, T4.4

- **T4.1 `server/network/link-store.ts`, `server/network/audit-log.ts`** + tests.
  - **Produces:**
    ```ts
    export interface LinkStore { links(): LinkRecord[]; get(machineId: string): LinkRecord | null; byLinkId(id: string): LinkRecord | { tombstone: Tombstone } | null;
      put(r: LinkRecord): void; update(machineId: string, patch: Partial<Pick<LinkRecord, 'addresses' | 'capabilities' | 'name'>>): void;
      revoke(machineId: string, at: number): Tombstone | null; writable: boolean }
    export function openLinkStore(file: string, now: () => number, log: NetLog): LinkStore; // atomicWriteFileSync + chmod 0600; newer → read-only, writable=false
    export type AuditKind = 'pairing.linked' | 'pairing.failed' | 'link.state' | 'link.revoked' | 'link.capability' | 'message.in' | 'message.out' | 'message.refused' | 'drive.start' | 'drive.stop' | 'drive.refused';
    export interface AuditEvent { kind: AuditKind; peer: string | null; principal?: string; detail?: Record<string, string | number | boolean | null> }
    export interface AuditSink { record(e: AuditEvent): void }
    export function openAuditLog(file: string, now: () => number): AuditSink; // appendFileSync line, {v:1, at, ...}
    ```
  - **Tests:**
    - put → reopen → same;
    - revoke moves the record to a tombstone with the same server key;
    - a newer file is never overwritten;
    - an audit line is valid JSON with `v:1` and `at`.
- **T4.2 `server/network/pairing-service.ts`** + tests (two instances over loopback with stub
  stores).
  - **Produces:**
    ```ts
    export interface PairingService { start(): Promise<{ pairingId: string; code: [string, string, string]; addresses: string[]; expiresAt: string }>;
      join(code: string, address: string): Promise<{ pairingId: string }>; confirm(id: string): void; decline(id: string): void; cancel(id: string): void;
      onPairingSocket(sock: net.Socket, first: Buffer): void; view(): NetworkPairingView | null }
    export function createPairingService(deps: { identity: () => Identity; selfName: () => string; addresses: () => string[];
      ensureListening(): Promise<void>; onLinked(o: Extract<PairingOutcome, { kind: 'linked' }>): void; onOwnerKey(k: { publicKey: string; privateKey: string }): void;
      audit: AuditSink; changed(): void; now(): number; rand(n: number): Uint8Array; setTimer; clearTimer }): PairingService;
    ```
  - Rules:
    - one window at a time;
    - 10 min, with an expiry timer;
    - one socket per window: a second pairing connection gets `pair.fail used`;
    - a failed MAC burns the window (`mismatch`);
    - "New code" is `cancel` + `start`;
    - a joiner that can't connect is `unreachable`.
  - **Tests:**
    - a happy path, with both `onLinked` outcomes equal;
    - a wrong code → `mismatch` on both, and the window can't be reused;
    - expiry → `expired`;
    - a decline → nothing linked, audit on both;
    - a second joiner → `used`;
    - `different-owner`.
- **T4.3 (serial) `server/network/link-manager.ts`, `server/network/c2.ts`,
  `server/network/index.ts`**.
  - **Produces:**
    ```ts
    export interface NetworkService { start(): Promise<void>; stop(): Promise<void>;
      handle(request: RpcRequest, peer: Peer): RpcResult | Promise<RpcResult> | null; // null = not mine
      state(): NetworkState; port(): NetworkPort; setMcp(p: McpNetworkPort): void }
    export function createNetwork(deps: { dir: string; identity: Identity; settings: () => Pick<ServerSettings, 'networkBindHost' | 'networkPort' | 'networkSelfName'>;
      emit: (type: 'network.changed', data: NetworkState) => void; emitTo: ServerTransport['emitTo']; runtime: TerminalRuntime;
      applyHumanInput(sessionId: string, data: string): boolean; openSession(agentId: string, folder: string): Promise<{ sessionId: string } | { error: string }>;
      closeSession(sessionId: string): Promise<{ ok: boolean; error: string | null }>; log: NetLog; now?: () => number }): NetworkService;
    ```
  - Link-manager rules:
    - It owns per-link dialing (decision 6), state events, `caps` frames on `link.setCapability`, and
      revoke (decision 11).
    - A peer's hello `serverKey`/`ownerKey` differing from the record → `identity-changed`, close,
      nothing crosses.
    - The listener starts in `start()` only if any link exists. `pairing.start` starts it otherwise.
  - In Slice 4, `runtime`, `applyHumanInput`, `openSession` and `closeSession` are wired in
    `createServices` but unused until Slices 7–8. The deps object is fixed now so `services.ts` is
    touched once.
  - **Tests:** `test/unit/network-link-manager.test.ts` — two managers on loopback:
    - link up → both `up`;
    - one stops → the other `down` → it restarts → `up`;
    - revoke on A → B gets `revoked`, and A's tombstone refuses every frame but the notice;
    - a duplicate connection resolves to the lower dialer;
    - a capability change reaches the peer's `peerCapabilities`.
- **T4.4 (serial; claims `src/contracts/server-protocol.ts`, `src/settings.ts`,
  `electron/server-client.ts`, `electron/server-events.ts`, `src/protocol.ts`,
  `server/services.ts`)**:
  - the C2 methods `pairing.*` and `link.*`, `network.changed`, the settings keys and error kinds;
  - `createServices` constructs, starts (after `server.start()`) and closes the network (before
    `server.stop()`);
  - `dispatch` tries `network.handle` after `domain.handle`;
  - the app forwards `network.changed` → `network:state`.

  `test/e2e/net-helpers.mjs` + `test/e2e/net-pairing.e2e.mjs`:
  - two standalone servers with their own userData, `networkBindHost: '127.0.0.1'` and
    `networkPort: 0`;
  - pair (start on A, join on B with A's code and address, confirm both) → both `link.list` show the
    other `up`, with equal fingerprints and `own` trust;
  - a wrong code → `mismatch` on both, and nothing is stored;
  - revoke on B → A shows `revoked`, and B's `link.list` no longer lists A;
  - B's `network/audit.jsonl` has the pairing and revoke entries.

  **Check:** `npm run verify`, then `npm run e2e -- net-pairing` locally, then
  `npm run e2e:remote -- net-pairing` (Windows: TLS 1.3 + Ed25519 on the bundled Node).

### Slice 5 — Remote directory, list_sessions, monitor snapshot
**Parallel groups:** G1: T5.1 · Serial: T5.2, T5.3

- **T5.1 `src/network/remote-directory.ts`, `src/conduit-mcp/remote-routing.ts`** + tests.
  - **Produces:** the port types and `mergeDirectory`/`isRemote` (contract block), plus:
    ```ts
    export interface RemoteDirectory { apply(machineId: string, snapshot: MonitorSnapshot): void; setLink(machineId: string, view: { name: string; state: LinkState; capabilities: Capabilities; peerCapabilities: Capabilities }): void;
      drop(machineId: string): void; entries(): RemoteEntry[]; resolve(target: string): RemoteResolution; waitReading(address: string, callerHandle: Handle): WaitReading | 'unreachable' | null }
    export function createRemoteDirectory(): RemoteDirectory;
    ```
  - Rules:
    - Entries come only from links whose peer enables `messaging` toward me (`peerCapabilities.messaging`).
    - `home`/`roots` are kept (own links only).
    - `resolve('x')` → local. `resolve('x@<unlinked>')` → `unknown` with hint "no link to <machine>;
      link it in Settings → Machines".
    - `waitReading` → `'unreachable'` unless the link is `up`/`degraded`.
  - **Tests:**
    - two snapshots → entries with canonical addresses;
    - resolution by id and by name;
    - name clash display;
    - a down link → `link: 'down'` rows still listed, and `waitReading` unreachable;
    - messaging off on the peer → no rows.
- **T5.2 (serial; claims `src/conduit-mcp/host.ts`, `tools.ts`, `types.ts`, `store.ts`,
  `src/contracts/server-ports.ts`)**:
  - The host takes `network?: NetworkPort`.
  - `directory()` returns `mergeDirectory`.
  - `listSessions` maps remote entries to rows with `machine`, `machine_id`, `address`, `trust`,
    `link`. The `handle` field of a remote row is its canonical address.
  - Control tools (`send_input`, `read_screen`, `close_session`, `focus_session`, editor tools)
    resolve only local entries; a remote target → `peer_unsupported` with hint "orchestrate is not
    available yet".
  - The host exposes `networkPort(): McpNetworkPort`, implemented over the store, the directory, the
    request service summary and human presence.
  - The new error codes and `MessageRecord.origin`; `store.has(messageId)`.
  - `network.onChange` → `scheduleBroadcast()` and `sessionWaits.notify()`.
  - **Tests:** extend `test/unit/conduit-mcp-tools.test.ts` (or its sibling for `listSessions`):
    - remote rows appear with the new fields;
    - local rows are unchanged byte for byte;
    - `send_input` to `x@m-…` → `peer_unsupported`.
- **T5.3 (serial) `server/network/monitor-publisher.ts`**:
  - It builds `MonitorSnapshot` from `McpNetworkPort.localDirectory()`, session attention facts and
    completions (`SessionView`), limit state (`server/domain/limit-monitor.ts` through a getter dep),
    `requestsSummary`, `youUnread`, `ownerPresence` and the agents list (the domain's agents).
  - It pushes on `up` and coalesced (500 ms) on change, only to links where **I** enable `monitor`
    (for the sessions/attention/requests fields) and `messaging` (for the session rows). With
    neither, it pushes nothing.
  - The `net-messaging` e2e part A: after pairing, a fake MCP agent on A calls `list_sessions` and
    sees B's fake agent as `e2e-fake-mcp-1@m-…` with `link: 'up'`.
  - **Check:** `npm run verify`, then `npm run e2e -- net-messaging` (part A only at this point).

### Slice 6 — Messaging exactly once
**Parallel groups:** G1: T6.1 · Serial: T6.2, T6.3

- **T6.1 `src/network/outbox.ts`** + tests.
  - **Produces:**
    ```ts
    export interface OutboxEntry { linkId: string; machineId: string; message: WireMessage; addresses: string[]; enqueuedAt: number; state: 'queued' | 'sent' }
    export interface Outbox { enqueue(e: Omit<OutboxEntry, 'state'>): void; batchFor(machineId: string): OutboxEntry[] /* FIFO; marks sent */; onDown(machineId: string): void /* sent → queued */;
      ack(messageId: string): OutboxEntry | null; expire(now: number): OutboxEntry[]; revoke(machineId: string): OutboxEntry[]; entries(): OutboxEntry[] }
    export function createOutbox(initial: OutboxEntry[]): Outbox;
    export function parseOutboxFile(text: string): { kind: 'ok'; entries: OutboxEntry[] } | { kind: 'newer' } | { kind: 'corrupt' };
    export function serializeOutboxFile(entries: OutboxEntry[]): string; // {version:1, entries}
    ```
  - **Tests:**
    - FIFO per machine;
    - `onDown` requeues sent entries in their original order;
    - an ack of an unknown id → null;
    - expiry at exactly 24 h;
    - revoke returns all entries for that machine.
- **T6.2 (serial; claims `src/conduit-mcp/tools.ts`, `host.ts`)** sender side:
  - `sendMessage` resolves each `to` through `deps.resolve` (a new `ToolDeps.resolve(target):
    RemoteResolution`, wired to `network.resolve` or local-only when there's no network).
  - Remote recipients are stored in the local record's `to` as canonical addresses.
  - After `store.append`, `deps.enqueueRemote(msg, entries)` (a new `ToolDeps` member, the host
    calls `network.enqueue`) returns outcomes merged into `recipients`: `queued` +
    `reason: 'peer_unreachable'` when the link is down, `refused` + `peer_revoked` /
    `peer_incompatible` / `capability_off`.
  - Thread participant checks accept canonical addresses.
  - `frameBody` for an `origin` record names the sender as `handle@<name>`, with relation `peer`, or
    `human` when `from` is `you` and the link has `drive` on (decision 12, passed in as
    `framedAsHuman`).
  - **Tests:**
    - to a remote up → queued;
    - to a remote down → queued with `peer_unreachable`;
    - to an unlinked id → `unknown_session` with a hint;
    - a mixed local + remote send keeps local behaviour.
- **T6.3 (serial) `server/network/outbox-store.ts`, `server/network/inbound.ts`**:
  - **Outbox store:**
    - persisted `network/outbox.json` (coalesced async atomic write, `atomicWriteFile`);
    - a delivery loop on `up` sends `batchFor` in order;
    - an `ack` with `delivered` leaves the remote status `queued` until a receipt; an `ack` with
      `refused` → `setRemoteStatus(id, address, 'undelivered')`;
    - a 60 s timer runs `expire` → `'expired'`;
    - revoke → `'undelivered'`.
  - **Inbound:**
    - Order: link `messaging` on (mine) → messaging master on → `hasMessage` (dedupe: ack
      `delivered` for all recipients, no append) → per recipient (exists, messageable, thread limit,
      rate 60/min per remote principal) → `deliverInbound` → `ack`.
    - Receipts: `onLocalStatus` for records with `origin` → `receipt` frames, held per link while
      down.
    - Audit `message.in` / `message.out` / `message.refused` with peer, from, to and messageId.
      Bodies are never logged.
  - `net-messaging` e2e part B:
    1. A's fake agent sends to B's fake agent → B's agent `read_inbox` has it once, and A sees status
       `noticed` after B's notice.
    2. Link down (`LinkProxy.cut`) → send → A's result `queued` + `peer_unreachable` →
       `LinkProxy.cutBeforeAck` on resume, so the message is resent twice → B has it exactly once.
    3. Both sides send while down → order kept per sender.
    4. Revoke while queued → A's status `undelivered`.
  - **Check:** `npm run verify`, `npm run e2e -- net-messaging`, then remote. **Tier 2 rerun in
    Slice 9.**

### Slice 7 — Pane relay (monitor) and remote waits
**Parallel groups:** G1: T7.1 · Serial: T7.2, T7.3

- **T7.1 (claims `src/contracts/terminal-runtime.ts`, `server/runtime/runtime.ts`)**
  `TerminalRuntime.observe` (contract above).
  - It uses an `hc.attach({terminal, observe: true, history: 0, cols, rows})` observer, the
    `PaintCollector` until the first paint ends (as `electron/terminal-link.ts:55-63` does), and
    credits as it goes.
  - `cols`/`rows` = the session's `lastSize`.
  - **Tests:** `test/unit/runtime-observe.test.ts` with `src/hc-client/testing/fake-hc.ts`:
    - the first paint is collected;
    - data after it is relayed;
    - an exit → `end('exited', code)`;
    - `close()` detaches;
    - a session with no live terminal → null.
- **T7.2 (serial) `server/network/view-relay.ts`**.
  - Serving side: `view.open` → requires that I enable `monitor` on the link (else `view.end
    refused`) → `runtime.observe` → `view.opened` with `windowsPty: currentWindowsPty()` → relays
    data/size/end. Past 4 MiB buffered → close the observe, send `view.end resync`, re-open.
  - Viewer side:
    - `remote.attach` → `view.open` → resolves on `view.opened` → events via `emitTo` to the
      attaching C2 peer;
    - a link down → `remote.state frozen` with `since`;
    - a link up → re-open each open view, `remote.state resyncing`, then a fresh paint delivered as
      `remote.data` after `remote.state live` with `size`;
    - the C2 peer's disconnect → close its views.
  - Remote waits: the host's `runWait` accepts canonical/name addresses through `network.resolve`,
    reads them with `network.waitReading` (fed by snapshots), and `'unreachable'` returns
    `peer_unreachable`.
  - `wait_sessions` on remote rows needs my link's `monitor` capability *from the peer*
    (`peerCapabilities.monitor`), else `capability_off`.
- **T7.3 (serial; claims `src/contracts/server-protocol.ts`)**: C2 `remote.attach/detach`, events
  `remote.data/state`.

  `test/e2e/net-monitor.e2e.mjs`:
  - B runs the echo agent;
  - A's C2 `remote.attach` → the first paint contains `E2E-READY`;
  - typing on B's own C2 → A's `remote.data` shows `ECHO:`;
  - `LinkProxy.cut` → `remote.state frozen`;
  - resume → `resyncing` → `live`, with a paint that has the current screen;
  - an ask/request raised on B appears in A's `link.list` snapshot `requests`;
  - A's fake agent `wait_sessions` on B's echo session (`exited`) fires when B's echo exits;
  - with B's link cut it returns `peer_unreachable`.

  **Check:** `npm run verify`, local e2e, then remote. **Tier 3** for `windowsPty` non-null from a
  Windows peer.

### Slice 8 — Drive
**Serial: T8.1, T8.2**

- **T8.1 (claims `server/services.ts`)**: extract
  `applyHumanInput(sessionId: string, data: string, generation: number | null): boolean`.
  - With `null`, it uses `runtime.get(sessionId)?.generation`.
  - Its body is today's `term.input` case (`server/services.ts:353-360`): `server.termInput` then
    `domain.humanInput` on counted input.
  - C2 `term.input` calls it with the given generation. Network drive gets `(id, data) =>
    applyHumanInput(id, data, null)`.
  - `openSession` → `domain.handle({method:'sessions.create'…})` then `sessions.start` semantics, as
    the C2 path does. `closeSession` follows the `sessions.close` semantics.
  - **Tests:** the existing `server-standalone` e2e stays green (C2 path unchanged), plus a unit test
    that a null generation uses the current one.
- **T8.2 (serial) `server/network/drive.ts`** + C2 `remote.input/resize/open/close` (claims
  `src/contracts/server-protocol.ts`).
  - Serving side: `drive.*` requires that I enable `drive` on the link. A refused frame is dropped
    and audited once per link per minute (never per keystroke). Otherwise it calls
    `applyHumanInput`, `runtime.resize` + `domain.resized`, or `openSession`/`closeSession` →
    `drive.result`. Each first input per session per link-up is audited `drive.start`, and the link
    going down audits `drive.stop`.
  - Viewer side: `remote.input` while the link isn't `up` → `peer_unreachable` error, never queued.
    `remote.*` without the peer's `drive` → `capability_off`.
  - `test/e2e/net-drive.e2e.mjs`:
    - with `drive` off, `remote.input` → `capability_off`, and B's echo gets nothing;
    - B enables drive (`link.setCapability`) → `remote.input 'ping\r'` → A's `remote.data` shows
      `ECHO:ping`;
    - `remote.resize` → B's session `lastSize` changes;
    - input sent during a cut → `peer_unreachable`, and after resume B never sees it;
    - `remote.open` the echo agent on B → a new session appears in A's snapshot;
    - `remote.close` → it exits.
  - **Check:** `npm run verify`, local e2e, then remote. **Tier 3** for ConPTY resize.

### Slice 9 — Tier 2 run, CHANGELOG, run report (me)
- After plan approval and this slice, run script S-2 `tools/vm-peer.mjs up`:
  1. Download `https://cloud-images.ubuntu.com/releases/26.04/release/` amd64 `.img` + `SHA256SUMS`,
     verify, store in my scratchpad.
  2. Create a cloud-init seed with `xorriso`.
  3. Run `qemu-system-x86_64 -enable-kvm -m 2048 -smp 2 -display none -nic
     user,hostfwd=tcp:127.0.0.1:<p>-:22,hostfwd=tcp:127.0.0.1:<q>-:47391`, recording its PID.
     `down` stops it by that PID; `pause`/`resume` go over QMP on a unix socket in the scratchpad.
- Copy `out/server` + hc into the VM over ssh. Start server B there with
  `networkBindHost: '0.0.0.0'` *inside the VM* (only reachable through QEMU's loopback forward).
  Pair from the host. Run the `net-messaging` steps with `pause`/`resume` as the blip. Log the result
  in the run report.
- `CHANGELOG.md`: agents can address sessions on linked machines, and C2 pairing/link surfaces exist
  (wording per `docs/UX.md` §8: "Background service", never "server", in user copy).
- Run report `docs/runs/2026-11-14-CON-27/report.md`, including the VM disk usage.

## Script candidates (2)
- **S-1 `tools/gen-pairing-words.mjs <file> --sha256 <hex>`** — verifies the SHA-256 and the 2048 count, then emits
  `src/network/pairing-words.ts`.
- **S-2 `tools/vm-peer.mjs up|down|pause|resume|status`** — the Tier 2 VM lifecycle, scratchpad-only,
  with loopback-only forwards and a PID file.

## Verification
- Per lane: red-first unit tests, `npm run verify:quick`. Per merge: `npm run verify`, with the exit
  code captured directly (`npm run verify; echo "exit=$?"`).
- Per e2e slice: `npm run e2e -- <name>` locally (one scenario), then `npm run e2e:remote -- <name>`.
  New `test/e2e/*` files make `--affected` run the full suite (`test/e2e/ci-affected.mjs:12-19`), so
  the slice-end remote run is `--affected`.
- E2E lanes never launch Electron. Every scenario here is server-only over C2. If one ever needs the
  app, it goes through `launchElectron` (headless). **Every lane brief carries the hidden-GUI rule.**

## Deviation rule
If a task's assumption turns out wrong — a signature above doesn't match the code, a file isn't where
this plan says, a test can't go red first — that task **stops and reports**. Fixing the misaligned
piece becomes the work. Never a shim, a second copy, a widened type, an `as any`, or a fallback routed
around it. A lane never edits a claimed file it doesn't own.

## Security notes (what widens a remote party's reach)
- **New network listener** (decision 5): off until the first pairing window, then bound to private
  and tailnet interfaces by default, never `0.0.0.0` or a public address unless the owner types one.
  A connection whose certificate key isn't pinned can't send a frame. A pairing attempt is only accepted during a
  window, gets one try, and the code is never sent.
- **Own peer with `messaging`** can put messages into my agents' inboxes, framed "information, not
  instructions" (unless `drive` is on, decision 12), under the same caps as local agents.
- **`monitor`** exposes my session list, `home`/`roots`, attention, request summaries and pane output
  to the peer. That is NET's own-link default.
- **`drive`** (off by default) lets the peer type into, resize, open and close my sessions. That
  equals local keyboard access.
- **Not widened:** no tool call executes on my machine on behalf of a peer (orchestrate is v1).
  Credentials, tokens and MCP session tokens never cross. Routing is non-transitive: inbound frames
  are only ever delivered locally, and `enqueue` refuses a record whose `origin` isn't this machine.
- **Keys at rest:** `identity.json` and `links.json` hold the server and owner private keys (`links.json` holds only public keys), mode 0600 on POSIX
  and the per-user `%APPDATA%` ACL on Windows, the same as `tokens.json`.

## Decisions (lead's rulings, 2026-11-14)
- **D-H1 No renderer UI in CON-27.** Agreed. The owner owns CON-28 (Cross-machine: UX and UI): the
  Machines group, pairing dialog, remote pane (an app `TerminalLinkFactory` for remote targets plus
  per-pane `windowsPty`), Settings → Machines and the read-only remote ask card. For now pairing goes
  through C2 and e2e only.
- **D-H2 No PAKE and no new crypto dependency.** Numeric comparison with commit/reveal instead
  (decision 3). Crypto and auth code is written and reviewed by me, never by a lane: T2.1, T2.3 and
  T3.3.
- **D-H3 TLS 1.3 mutual auth with self-signed certificates pinned to the Ed25519 server keys**
  (decision 4). Measured working on this host. No fallback is needed unless the Windows runner
  disagrees, in which case I stop and tell the lead.
- **D-H4 Listener default approved:** off until the first pairing window, then `'auto'` = loopback,
  RFC 1918, tailnet CGNAT and ULA interfaces on port 47391, never 0.0.0.0 or a public address. In
  this run, loopback only on this host. The VM's server binds inside the VM behind QEMU's
  loopback-only forward.
- **D-H5 Seams with CON-24:**
  - NET enforces the "capability off → deny" floor itself.
  - NET writes `network/audit.jsonl` behind `AuditSink`.
  - NET deletes no grants on revoke, because none exist yet.

  I agree the principal shape, `AuditSink` and the capability floor in writing with claude-21 (the
  CON-24 orchestrator), CC the lead. The interfaces stay small and are recorded on both branches.

- **[accepted] D-N1 Machine id is 8 hex** (matches the existing code), not the spec example's 6.
- **[accepted] D-N2 Peer names are the peer's self-name** (no local rename of own peers). A clash
  shows `name (m-…)`.
- **[accepted] D-N3 `you@m-x` frames as the human only while that link has `drive` on.**
- **[accepted] D-N4 Different owner keys refuse own pairing.** There's no "reset owner" in MVP.
- **[accepted] D-N5 Receipts are best effort** (held in memory while down, lost on a restart). Delivery
  itself is exactly once.
- **[accepted] D-N6 Remote open/close follows NET §4.1 exactly.** A *human* open or close over C2
  (`remote.open`/`remote.close`) is `drive`. An agent's `open_session`/`close_session` on a peer is
  `orchestrate`, which is v1, and is refused with `peer_unsupported`. Remote Editor & views tools wait
  for v1.
- **[accepted] D-N7 Tier 3 (Tailscale CI job)** is planned after the owner's secrets exist. Not in
  these slices.

## Self-review
```
#1 Coverage: ok — pairing/fingerprint/store-on-confirm (S4), own-key rule (S2 T2.3, S4), queued+TTL+exactly-once (S6), revoke stops traffic + event (S4), incompatible + doesn't support (S3, S4), non-transitive (security note + S6 enqueue origin check), watch remote session (S7), pane freeze/resync (S7), remote ask read-only data (S5 snapshot requests; UI card), address by machine id + unknown_session hint (S5). Guest criteria: out (CON-17).
#2 Placeholder scan: fixed: named the rate limit (60/min per remote principal) and the audit kinds in T6.3
#3 Signature consistency: ok — RemoteEntry/RemoteResolution/WireRecipientOutcome/MonitorSnapshot are defined once and consumed verbatim
#4 Placement: ok — every Files path is in the file map; the src/network ↔ server/network split mirrors src/conduit-mcp ↔ server/mcp
#5 Caller scan: fixed: runtime.observe moved from Slice 4 to Slice 7 (its first caller); createNetwork deps fixed in S4 but only exercised later (one services.ts touch, stated)
#6 Producer/consumer: ok — the network.changed / remote.* renderer consumer is the UI card, stated (D-H1)
#7 Handoff arithmetic: counted below
```

```
PLAN: docs/plans/2026-11-14-conduit-network-machinery.plan.md
TIER: FULL
SLICES: 9
GROUPS: 10
CLAIMS: src/contracts/session-identity.ts, src/conduit-mcp/host.ts, src/conduit-mcp/tools.ts, src/conduit-mcp/types.ts, src/conduit-mcp/store.ts, src/contracts/server-ports.ts, server/mcp/index.ts, server/services.ts, src/contracts/server-protocol.ts, src/settings.ts, electron/server-client.ts, electron/server-events.ts, src/protocol.ts, src/contracts/terminal-runtime.ts, server/runtime/runtime.ts, THIRD_PARTY_NOTICES.txt, CHANGELOG.md
SCRIPT_CANDIDATES: 2
```
