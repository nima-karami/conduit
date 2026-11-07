---
status: proposal
date: 2026-11-07
card: CON-146
---

# Feature flags: ship unfinished work dark

Related: CON-145 (release channels). Output of research; nothing built.

## Problem

Unfinished features either sit on long branches or ship half-visible. We want them merged to
`main` and dark, then on in Preview and off in Stable. Constraints from how Conduit works:

- Desktop app, often offline, no phoning home by default (a local tool for agent CLIs).
- Three runtimes need the same answer: Electron main, the renderer (`webview/`), and the background
  server process (ADR 0007). The server must agree with the app without its own config.
- Releases are electron-builder + GitHub releases, CHANGELOG-driven (`package.json` `build.publish`,
  `electron/updater.ts`). We have no backend to host flag state.
- Flags here are **channel-scoped release gates**, not per-user targeting or experiments.

## Options

| Option | Offline | Privacy (default) | Cost | Complexity | Main + renderer + server | Per-channel defaults | Dev / e2e override |
|---|---|---|---|---|---|---|---|
| **OpenFeature SDK + in-memory provider** | Yes | No network | Free, Apache-2.0 | Low-medium: neutral API, but channel logic is still ours | Server SDK in main/server, web SDK in renderer; two SDKs, our own sync | Ours to build | Ours to build |
| **Unleash** (OSS self-host) | Only via Edge offline file, which is Enterprise Edge (licence key) | Self-host is ours | OSS free but capped (1 project, 2 envs, 5k flags); Pro $75/seat/mo | High: a server to run for a pre-1.0 app | Needs reachable server or bundled file | Environments map to channels | Env tokens |
| **GrowthBook** | Local eval of a JSON payload; payload still fetched or bundled | Self-host is ours; SDK telemetry not confirmed | Self-host free (open core, some dirs commercial); Cloud per seat | Medium-high: UI + Mongo to host; built for A/B tests we do not need | JS SDK runs anywhere; payload sync is ours | Environments | SDK overrides |
| **LaunchDarkly** | Offline mode exists; docs steer Electron to a client-side SDK that talks to LD | Sends contexts/events to LD by design | Paid; client-side priced by MAU | Medium: little code, hard vendor dependency | Electron SDK (client) vs Node SDK (docs discourage server SDK in distributed apps) | Environments | Offline mode / file data |
| **Built-in registry** (recommended) | Yes, compiled in | Zero network | Free | Low: ~150 lines | One shared TS module for all three | Default per channel in the registry | Env, CLI, Settings; e2e launch option |

Sources (checked 2026-11-06; vendor pages move, re-verify any number before relying on it):
- OpenFeature in-memory provider is spec-recommended, aimed at testing: https://openfeature.dev/specification/appendix-a , https://npmjs.com/package/@openfeature/server-sdk
- Unleash pricing and limits: https://getunleash.io/pricing ; Edge offline file needs Enterprise Edge: https://docs.getunleash.io/unleash-edge/deploy . A competitor post claims OSS Edge reaches end of life 2026-12-31 (https://www.growthbook.io/blog/unleash-alternatives); not confirmed by Unleash.
- GrowthBook licence and pricing, third-party summaries only and conflicting: https://posthog.com/blog/posthog-vs-growthbook , https://www.growthbook.io/growthbook-vs-launchdarkly . SDK telemetry behaviour not found.
- LaunchDarkly Electron SDK, offline mode, server-SDK-in-Electron warning: https://launchdarkly.com/docs/sdk/client-side/electron , https://docs.launchdarkly.com/sdk/server-side/node-js ; pricing by MAU: https://launchdarkly.com/pricing

## Criteria and verdict

- **Offline + no telemetry by default**: only built-in and OpenFeature-in-memory pass without work.
  Hosted systems need a fetch or a bundled snapshot, which is the built-in design with extra steps.
- **Reach**: every option still needs us to hand the answer to the server process and renderer.
- **Per-channel defaults**: the channel is known at build/launch time, so a registry default per
  channel is exact. A remote service adds nothing here.
- **Remote kill switch, % rollout, per-user targeting**: the only things a hosted system buys.
  Not needed now (open question 3).
- **OpenFeature** is worth keeping in view: if remote flags ever arrive, a narrow `isEnabled()` call
  surface can be fronted by an OpenFeature provider without touching call sites. Not adopted now;
  it would wrap a three-line lookup.

## Recommendation

**Build a small built-in system.** One typed registry, evaluated once per process from
(channel default, saved setting, env/CLI override). No network, no new dependency.

## Proposed design

### Registry: `src/flags.ts` (pure, shared by main, renderer, server)

```ts
export type Channel = 'stable' | 'preview' | 'dev';

export interface FlagDef {
  readonly description: string;   // shown in Settings -> Labs
  readonly owner: string;         // card id, e.g. 'CON-123'
  readonly added: string;         // 'YYYY-MM-DD', drives removal
  readonly defaults: Readonly<Record<Channel, boolean>>;
  readonly userToggle: boolean;   // false = only env/CLI can change it
}

export const FLAGS = {
  planV2: { description: 'Plan whiteboard', owner: 'CON-90', added: '2026-11-07',
            defaults: { stable: false, preview: true, dev: true }, userToggle: true },
} as const satisfies Record<string, FlagDef>;   // example entry

export type FlagId = keyof typeof FLAGS;
export type FlagOverrides = Partial<Record<FlagId, boolean>>;
export function resolveFlags(channel: Channel, saved: FlagOverrides, forced: FlagOverrides): Record<FlagId, boolean>;
```

Precedence, highest first: **forced** (env/CLI) > **saved** (Settings, only if `userToggle`) > **channel default**.
Unknown ids in saved/forced are dropped (coerced like the rest of `src/settings.ts`).

### Channel

Depends on CON-145. Assumed: the build bakes a `channel` string (electron-builder `extraMetadata` or a
generated build-info file; `dev` when unpackaged). Flags only call `getChannel()`; they do not define
channels. If the channel is missing or unrecognised the fallback is `stable`, so nothing leaks by accident.

### Where it is evaluated

| Process | How it gets the resolved map |
|---|---|
| Main | `resolveFlags(channel, settings.flags, parseEnvAndArgv())` at startup and on settings change |
| Server | Main sends the resolved map at spawn and on change over the existing server-calls channel. The server never reads settings or env for flags, so app and server cannot disagree |
| Renderer | Bridge exposes the resolved map (`window.agentDeck.flags`); the fake shell in `webview/bridge.ts` returns `dev` defaults. `isEnabled` is a sync lookup |

Flag changes say "Restart to apply" rather than hot-swapping; a flag opts into live re-render explicitly.

### Overrides

- Env: `CONDUIT_FLAGS=planV2,-other` (comma list, `-` prefix disables). CLI: `--flags=...`, same grammar,
  one parser in `electron/arg-utils.ts`.
- E2E: `launchElectron` takes a `flags` option that sets `CONDUIT_FLAGS`. `CONDUIT_E2E=1` does not change
  defaults, so e2e exercises what the channel ships; a scenario for a dark feature forces it on.
- Settings -> Labs (advanced): lists `userToggle` flags with description; stored as
  `flags: Record<string, boolean>` in `settings.json` (ADR 0007 settings-mirror rule applies).
  Whether it appears on Stable is open question 1/2.

### Tests

- Unit: `resolveFlags` precedence, unknown ids dropped, `stable` fallback.
- Unit guard (in the style of `test/unit/drag-region.test.ts`): every flag has `owner` and a valid
  `added` date; a flag older than 60 days fails unless it carries a reviewed `keep` reason.
- Unit guard: a flag that is `true` on every channel fails ("delete me").

### Removal discipline

A flag is temporary. Graduating a feature deletes the registry entry, every `isEnabled` call and the
dead branch in the same PR. The age guard forces the conversation. Permanent preferences are Settings,
not flags. The CHANGELOG entry is written when the flag turns on in Stable, not when it merges dark.

### Not in v1

Remote config, percentage rollout, per-user targeting, exposure analytics, any network call.

## Open questions (product)

1. Can Stable users opt in to Preview features from Labs, or is the channel the only switch? (Opt-in gives early feedback without a second install; costs support surface on Stable.)
2. Should Labs exist on Stable at all, or only in Preview/dev with env override for staff?
3. Will you ever want a remote kill switch for a shipped feature? That is the one case that would justify a hosted or OpenFeature setup, and it breaks "no phoning home".
4. Is 60 days the right forcing function for flag age, or should graduation be tied to a release count?
5. Should Preview-only flags get an "Experimental" section in the Preview channel's release notes?
