# herdr-core 0.1.16 network audit (2026-11-02)

**Verdict: hc sends nothing on its own.** No telemetry, analytics, crash reporting, update check,
version ping or licence check exists in 0.1.16, so there is no off switch to set.

## Evidence
- **Source (tag v0.1.16).** Cargo.lock has 51 crates (clap, serde, toml, schemars, tokio, windows-sys,
  libc, ghostty-vt); no HTTP/TLS/DNS/telemetry crate. tokio `net` serves only local named pipes / Unix
  sockets. Env vars read: `HC_*`, `HC_SESSION`, `HC_SOCKET`, `HC_SSH`, `HERDR_RELEASES_URL`, `XDG_*`.
  Config keys: shell, detach_key, wait_timeout, notes, notes_quiet, headless, history_mb, socket,
  machine_timeout.
- **The only outbound paths, all user-invoked:** `hc update` (curl to releases.herdr.dev; "hc never
  checks for updates on its own"), `hc machine add|update` (ssh/scp to the given host, plus a release
  fetch for a different OS/CPU), and `--on <machine>` / `machine.*` (ssh to stored machines).
- **Machine id** (Windows MachineGuid) stays local in `<state>/core.json` to detect cloned disks.
- **Bundled binary** (`build/vendor/hc/hc.exe`): imports no ws2_32 / winhttp / wininet / urlmon;
  conpty.dll imports no networking DLLs.
- **Runtime:** a private core + terminal sampled every 5 s for 60 s — 0 TCP, 0 UDP endpoints.
- **Install-script download counter** (`?src=install`) lives in install.ps1, which Conduit doesn't run;
  `build/fetch-runtime.mjs` does a plain pinned, sha256-checked GET at build time.

## Conduit guards
- `coreStartEnv` strips `HERDR_RELEASES_URL` (with `HC_*`), so no stray override reaches the core.
- `test/unit/hc-network-guard.test.ts` fails if server/src/electron ever runs `hc update`,
  `hc machine` or `--on`.
- Re-audit on every hc pin bump: Cargo.lock network crates, `releases::` callers, hc.exe imports.
